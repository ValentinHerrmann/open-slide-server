#!/bin/sh
# Git operations for ONE project, run by the worker (worker.py) with:
#   REPO_GIT = the project's git dir, WORK = its worktree, KEY_DIR = its deploy key or the token dir.
#
# The git dir lives OUTSIDE the worktree, so nothing in the worktree (which the
# editor's agent and collaborators can write) can set hooks, config, filters or
# fsmonitor. Hooks are disabled on top of that. Never force-pushes.
#
# Auth: AUTH=key -> deploy key $KEY_DIR/id over SSH; AUTH=token -> fine-grained token $KEY_DIR/token over
# HTTPS via a credential helper that reads the file (never written to git config or URLs).
# Env: MODE (test|clone|init|sync|resolve|branches|switch), AUTH, REMOTE, BRANCH (+ TARGET, CREATE for switch)
# Output: last line is "RESULT <code> <detail>" for the worker.
set -u
R="${REPO_GIT:?}" W="${WORK:?}" K="${KEY_DIR:?}"
export GIT_DIR="$R" GIT_WORK_TREE="$W" HOME=/tmp
export GIT_SSH_COMMAND="ssh -i $K/id -o IdentitiesOnly=yes -o UserKnownHostsFile=$K/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=15"
export GIT_AUTHOR_NAME="open-slide server" GIT_AUTHOR_EMAIL="open-slide-server@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_TERMINAL_PROMPT=0
B="${BRANCH:-main}"
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
if [ "${AUTH:-key}" = token ]; then
	unset GIT_SSH_COMMAND
	CRED='!f() { test "$1" = get || exit 0; echo username=x-access-token; printf "password=%s\n" "$(cat '"$K"'/token)"; }; f'
else
	CRED=''
fi
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false -c protocol.file.allow=never \
	-c credential.helper= -c "credential.helper=$CRED" -c http.followRedirects=false "$@"; }
result() { echo "RESULT $1 ${2:-}"; exit 0; }

setup_excludes() {
	mkdir -p $R/info
	printf '%s\n' node_modules/ dist/ inbox/ .git-old/ .DS_Store >$R/info/exclude
}

commit_local() {
	g add -A || return 1
	if ! g diff --cached --quiet; then
		g commit -q -m "auto: server edits $(date -u '+%Y-%m-%d %H:%M UTC')" || return 1
	fi
}

# Keep the remote URL in sync with the chosen auth method (SSH vs HTTPS).
if [ "$MODE" != test ] && [ -f $R/config ]; then
	g remote set-url origin "$REMOTE" 2>/dev/null
fi

case "${MODE:?}" in
test)
	out=$(g ls-remote "$REMOTE" 2>&1) || result no_access "$(echo "$out" | tail -n1)"
	[ -z "$out" ] && result ok_empty
	result ok
	;;

clone) # remote has content, worktree empty: check it out with external git dir
	[ -d $R/objects ] || (unset GIT_WORK_TREE; g init -q --bare $R >/dev/null) || result error "init"
	g config core.bare false
	g config core.worktree "$W"
	setup_excludes
	g remote add origin "$REMOTE" 2>/dev/null || g remote set-url origin "$REMOTE"
	g fetch -q origin "$B" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	g checkout -q -B "$B" "origin/$B" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	g branch -q --set-upstream-to="origin/$B" "$B"
	result ok
	;;

init) # worktree has content (e.g. existing workspace), remote empty or not
	[ -d $R/objects ] || (unset GIT_WORK_TREE; g init -q --bare $R >/dev/null) || result error "init"
	g config core.bare false
	g config core.worktree "$W"
	setup_excludes
	g remote add origin "$REMOTE" 2>/dev/null || g remote set-url origin "$REMOTE"
	g symbolic-ref HEAD "refs/heads/$B"
	if g fetch -q origin "$B" 2>/dev/null; then
		# Remote already has history: adopt it, keep local files as changes on top.
		g reset -q "origin/$B"
	fi
	commit_local || result error "commit"
	g push -q -u origin "$B" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	result ok
	;;

sync)
	if [ -d $R/rebase-merge ] || [ -d $R/rebase-apply ]; then
		g rebase --abort >/dev/null 2>&1
	fi
	commit_local || result error "commit"
	g fetch -q origin "$B" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	behind=$(g rev-list --count "HEAD..origin/$B")
	if [ "$behind" -gt 0 ]; then
		# Files changed while we were committing -> try again next cycle.
		g diff --quiet && g diff --cached --quiet || result busy "worktree changed during sync"
		if ! g rebase -q "origin/$B" > "$ERR" 2>&1; then
			files=$(g diff --name-only --diff-filter=U | tr '\n' ' ')
			g rebase --abort >/dev/null 2>&1
			result conflict "$files"
		fi
	fi
	ahead=$(g rev-list --count "origin/$B..HEAD")
	if [ "$ahead" -gt 0 ]; then
		g push -q origin "HEAD:$B" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	fi
	result ok "pulled=$behind pushed=$ahead"
	;;

resolve) # conflict: park server commits on a branch, then take GitHub's version
	commit_local || result error "commit"
	g fetch -q origin "$B" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	park="server/$(date -u +%Y%m%d-%H%M%S)"
	g push -q origin "HEAD:refs/heads/$park" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	g reset -q --hard "origin/$B" || result error "reset"
	result ok "$park"
	;;

branches) # branches on GitHub, space separated
	out=$(g ls-remote --heads origin 2>"$ERR") || result error "$(tail -n1 "$ERR")"
	result ok "$(echo "$out" | sed -n 's#^[0-9a-f]*[[:space:]]*refs/heads/##p' | tr '\n' ' ')"
	;;

switch) # B = current branch (already synced by the worker), TARGET = branch to switch to
	T="${TARGET:?}"
	commit_local || result error "commit"
	g diff --quiet && g diff --cached --quiet || result busy "worktree changed during switch"
	if g fetch -q origin "$T" 2>/dev/null; then
		[ "${CREATE:-}" = 1 ] && result error "branch $T already exists on GitHub"
		g checkout -q -B "$T" "origin/$T" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
	else
		[ "${CREATE:-}" = 1 ] || result error "branch $T not found on GitHub"
		g checkout -q -B "$T" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
		g push -q origin "HEAD:refs/heads/$T" 2>"$ERR" || result error "$(tail -n1 "$ERR")"
		g fetch -q origin "$T" 2>/dev/null
	fi
	g branch -q --set-upstream-to="origin/$T" "$T" 2>/dev/null
	result ok "$T"
	;;

*) result error "unknown mode" ;;
esac
