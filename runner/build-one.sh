#!/bin/sh
# One static build of one project (or one deck of it). Runs in the "builder" container
# (runner.mjs): no network, project read-only at $PROJECT, output into a fresh, empty $OUT.
# Runs project code (open-slide.config.ts, decks); the sandbox makes that harmless.
#
# Env: PROJECT, OUT, BASE (e.g. /slides/ or /share/<token>/), DECK (empty = all decks), BROWSER (true|false)
set -eu
: "${BASE:?}" "${BROWSER:?}"
DECK="${DECK:-}"
P="${PROJECT:-/project}"
OUT="${OUT:-/out}"
S=$(mktemp -d /tmp/stage.XXXXXX)
trap 'rm -rf "$S"' EXIT

mkdir -p "$S/slides"
# Copy the project minus heavy/irrelevant dirs; keep the relative layout so
# decks importing ../../themes etc. still resolve. node_modules is linked.
for e in "$P"/* "$P"/.[!.]*; do
	[ -e "$e" ] || continue
	case "${e##*/}" in
		node_modules | .git | .git-old | inbox | dist | slides) ;;
		*) cp -R "$e" "$S/" ;;
	esac
done
# node_modules: a real dir of links, so Vite's temp files (.vite-temp) land in
# the writable /tmp instead of the read-only project.
mkdir "$S/node_modules"
for m in "$P"/node_modules/* "$P"/node_modules/.[!.]*; do
	[ -e "$m" ] || continue
	case "${m##*/}" in .vite-temp | .vite | .open-slide) continue ;; esac
	ln -s "$m" "$S/node_modules/${m##*/}"
done

if [ -n "$DECK" ]; then
	case "$DECK" in *[!A-Za-z0-9_-]*) echo "invalid deck id" >&2; exit 2 ;; esac
	cp -R "$P/slides/$DECK" "$S/slides/$DECK"
else
	cp -R "$P/slides/." "$S/slides/"
fi

# Wrap the project's own config: force base path + deck browser, agent off.
if [ -f "$S/open-slide.config.ts" ]; then
	mv "$S/open-slide.config.ts" "$S/open-slide.user.config.ts"
else
	echo 'export default {};' >"$S/open-slide.user.config.ts"
fi
cat >"$S/open-slide.config.ts" <<EOF
import user from './open-slide.user.config';
const u: any = user ?? {};
export default {
  ...u,
  base: '$BASE',
  build: { ...(u.build ?? {}), showSlideBrowser: $BROWSER },
  agent: { enabled: false },
};
EOF

cd "$S"
npx --offline open-slide build --out-dir "$OUT"
