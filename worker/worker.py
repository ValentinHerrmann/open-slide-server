#!/usr/bin/env python3
"""open-slide worker: projects, GitHub sync, static builds, share links.

Runs as a long-lived container (uid 1000, no Docker socket). It is the only part with the GitHub
credentials, and it never runs project code:
  - git: worker/sync.sh, with the git dir OUTSIDE the worktree and hooks disabled.
  - npm: a job for the "deps" container (npm ci --ignore-scripts, one project mounted).
  - builds: jobs for the "builder" container (no network, one project mounted read-only).
  - editor switch: re-point data/active, bump data/control/generation; the editor restarts itself.
The admin web UI can't do anything itself: it drops request files into state/requests/, which
this worker re-validates against a fixed list of actions.
"""
import hashlib, json, os, re, secrets, shutil, stat, subprocess, sys, time

DATA = "/data"
PROJECTS = f"{DATA}/projects"
GITDIRS = f"{DATA}/git"
KEYS = f"{DATA}/keys"
STATE = f"{DATA}/state"
REQS = f"{STATE}/requests"
VIEW = f"{STATE}/view"
WORKER = f"{STATE}/worker.json"
PUBLIC = f"{DATA}/public"
WWW = f"{PUBLIC}/www"
BUILDS = f"{PUBLIC}/builds"
JOBS = f"{DATA}/jobs"
CONTROL = f"{DATA}/control"
EMPTY = f"{PROJECTS}/.none"  # what the editor/builder/deps see when no project is selected
APP = "/opt/open-slide"
TEMPLATE = f"{APP}/templates/project"
SYNC_SH = f"{APP}/worker/sync.sh"
BUILD_SH = f"{APP}/runner/build-one.sh"
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")
CYCLE_SECONDS = max(30, int(os.environ.get("CYCLE_SECONDS", "120") or 120))
HOME_PROJECT = "main"  # published at /slides/; other projects at /slides/p/<name>/
GITHUB_ED25519_FP = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
DECK_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
REMOTE_RE = re.compile(r"^git@github\.com:([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})\.git$")
REPO_RE = re.compile(r"^([A-Za-z0-9_-][A-Za-z0-9_.-]{0,99})/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,99})$")
PAT_RE = re.compile(r"^github_pat_[A-Za-z0-9_]{40,250}$")
CLAUDE_DIR = f"{DATA}/claude"  # read only by claude-proxy (Caddy reads the file per request)
CLAUDE_RE = re.compile(r"^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$")
TOKEN_DIR = f"{KEYS}/_token"  # fine-grained GitHub token (not a valid project name, so no clash)
AUTHS = ("token", "key")
BRANCH_RE = re.compile(r"^(?!.*\.\.)[A-Za-z0-9._/-]{1,64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")
REQID_RE = re.compile(r"^[a-z0-9-]{8,40}$")
EXPIRY_DAYS = {0, 1, 7, 30}


def now():
    return int(time.time())


# ---------------------------------------------------------------- state
def load():
    try:
        with open(WORKER) as f:
            s = json.load(f)
    except FileNotFoundError:
        s = {}
    s.setdefault("projects", {})
    s.setdefault("shares", {})
    s.setdefault("built", {})  # target key -> fingerprint it was built from
    s.setdefault("log", [])
    s.setdefault("token", None)
    return s


def parse_repo(x):
    """owner/repo from git@github.com:o/r.git, https://github.com/o/r(.git) or o/r."""
    if not isinstance(x, str):
        return None
    x = x.strip()
    m = REMOTE_RE.match(x)
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    m = re.match(r"^https://github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", x)
    if m:
        x = f"{m.group(1)}/{m.group(2)}"
    return x if REPO_RE.match(x) and ".." not in x else None


def remote_url(p):
    return f"https://github.com/{p['repo']}.git" if p.get("auth") == "token" else f"git@github.com:{p['repo']}.git"


def save(s):
    s["log"] = s["log"][-200:]
    write_json(WORKER, s, 0o600)


def write_json(path, data, mode=0o644):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def log(s, msg, project=None, level="info"):
    print(f"[{level}] {project + ': ' if project else ''}{msg}", flush=True)
    s["log"].append({"t": now(), "level": level, "project": project, "msg": msg[:500]})


def run(cmd, timeout=600, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)


def symlink(target, path):
    """Atomically point path at target (relative to path's directory)."""
    tmp = f"{path}.new"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(target, tmp)
    os.replace(tmp, path)


# ---------------------------------------------------------------- git (in-process, no project code)
def key_dir(name, p):
    return TOKEN_DIR if p.get("auth") == "token" else f"{KEYS}/{name}"


def git_sync(name, mode, p, **extra):
    env = {**{k.upper(): str(v) for k, v in extra.items()},"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/tmp",
           "REPO_GIT": f"{GITDIRS}/{name}.git", "WORK": f"{PROJECTS}/{name}", "KEY_DIR": key_dir(name, p),
           "AUTH": p.get("auth", "key"), "MODE": mode, "REMOTE": remote_url(p), "BRANCH": p["branch"]}
    try:
        r = run(["sh", SYNC_SH], timeout=300, env=env)
    except subprocess.TimeoutExpired:
        return "error", "timed out"
    last = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith("RESULT ")]
    if not last:
        return "error", (r.stderr.strip().splitlines() or ["no output"])[-1]
    parts = last[-1].split(" ", 2)
    return parts[1], (parts[2] if len(parts) > 2 else "")


# ---------------------------------------------------------------- jobs for builder / deps
def run_job(kind, name, payload, timeout):
    """Mount project <name> in the <kind> container (via data/<kind>-src) and run one job there."""
    jd = f"{JOBS}/{kind}"
    os.makedirs(jd, exist_ok=True)
    for e in os.listdir(jd):
        path = f"{jd}/{e}"
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.unlink(path)
    os.makedirs(f"{jd}/out")
    symlink(f"projects/{name}", f"{DATA}/{kind}-src")
    jid = f"{now():x}-{secrets.token_hex(4)}"
    job = {"id": jid, "project": name, "ino": os.stat(f"{PROJECTS}/{name}").st_ino, **payload}
    write_json(f"{jd}/.job.json", job)
    os.replace(f"{jd}/.job.json", f"{jd}/job.json")
    deadline = time.time() + timeout
    res = f"{jd}/result-{jid}.json"
    while time.time() < deadline:
        if os.path.exists(res):
            try:
                with open(res) as f:
                    out = json.load(f)
            except (OSError, ValueError):
                out = {"ok": False, "out": "unreadable result"}
            os.unlink(f"{jd}/job.json")
            return out if isinstance(out, dict) else {"ok": False, "out": "bad result"}
        time.sleep(1)
    os.unlink(f"{jd}/job.json")
    return {"ok": False, "out": f"{kind} job timed out (is the '{'builder' if kind == 'build' else 'deps'}' container running?)"}


def npm_install(s, name, skills=False):
    r = run_job("deps", name, {"skills": skills}, timeout=1200)
    if not r.get("ok"):
        log(s, f"npm install failed: {r.get('out', '?')}", name, "error")
        return False
    s["projects"][name]["lock_hash"] = lock_hash(name)
    log(s, "dependencies installed", name)
    return True


def lock_hash(name):
    d = f"{PROJECTS}/{name}"
    h = hashlib.sha256()
    for f in ("package.json", "package-lock.json"):
        try:
            with open(f"{d}/{f}", "rb") as fh:
                h.update(fh.read())
        except FileNotFoundError:
            pass
    return h.hexdigest()


def scaffold(work):
    """Copy templates/project into an empty worktree."""
    for dirpath, dirs, files in os.walk(TEMPLATE):
        rel = os.path.relpath(dirpath, TEMPLATE)
        dst_dir = os.path.normpath(os.path.join(work, rel))
        os.makedirs(dst_dir, exist_ok=True)
        for f in files:
            dst = os.path.join(dst_dir, ".gitignore" if (rel == "." and f == "gitignore") else f)
            shutil.copyfile(os.path.join(dirpath, f), dst)


# ---------------------------------------------------------------- editor
def active_project():
    try:
        t = os.path.basename(os.readlink(f"{DATA}/active"))
        return t if NAME_RE.match(t) else None
    except OSError:
        return None


def restart_editor():
    """The editor watches this file and restarts (re-mounting data/active) when it changes."""
    os.makedirs(CONTROL, exist_ok=True)
    with open(f"{CONTROL}/.generation", "w") as f:
        f.write(f"{time.time_ns()}\n")
    os.replace(f"{CONTROL}/.generation", f"{CONTROL}/generation")


def set_active(name):
    symlink(f"projects/{name}", f"{DATA}/active")
    restart_editor()


# ---------------------------------------------------------------- projects
def decks(name):
    d = f"{PROJECTS}/{name}/slides"
    out = []
    if not os.path.isdir(d):
        return out
    for e in sorted(os.listdir(d)):
        if not DECK_RE.match(e) or os.path.islink(f"{d}/{e}"):
            continue
        idx = next((f"{d}/{e}/index.{x}" for x in ("tsx", "jsx", "ts", "js") if os.path.isfile(f"{d}/{e}/index.{x}")), None)
        if not idx:
            continue
        title = None
        try:
            with open(idx, errors="replace") as f:
                m = re.search(r"""(?:^|[\s,{])title\s*:\s*['"]([^'"\n]{1,120})['"]""", f.read(200_000))
                title = m.group(1) if m else None
        except OSError:
            pass
        out.append({"id": e, "title": title})
    return out


def fingerprint(name):
    h = hashlib.sha256()
    with open(BUILD_SH, "rb") as f:
        h.update(f.read())
    base = f"{PROJECTS}/{name}"
    for dirpath, dirnames, filenames in os.walk(base):  # does not follow symlinks
        rel = os.path.relpath(dirpath, base)
        if rel == ".":
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", ".git-old", "inbox", "dist")]
        dirnames.sort()
        for fn in sorted(filenames):
            try:
                st = os.lstat(os.path.join(dirpath, fn))
            except OSError:
                continue
            h.update(f"{rel}/{fn}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())
    return h.hexdigest()


def known_hosts():
    path = f"{KEYS}/known_hosts"
    if os.path.exists(path):
        return path
    r = run(["ssh-keyscan", "-t", "ed25519", "github.com"], timeout=30)
    line = next((l for l in r.stdout.splitlines() if l.startswith("github.com ssh-ed25519 ")), None)
    if not line:
        raise RuntimeError("ssh-keyscan github.com failed")
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        f.write(line + "\n")
    fp = run(["ssh-keygen", "-lf", tmp]).stdout.split()
    if len(fp) < 2 or fp[1] != GITHUB_ED25519_FP:
        os.unlink(tmp)
        raise RuntimeError("GitHub host key fingerprint mismatch")
    os.replace(tmp, path)
    return path


def ensure_key(name):
    d = f"{KEYS}/{name}"
    os.makedirs(d, mode=0o700, exist_ok=True)
    if not os.path.exists(f"{d}/id"):
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"open-slide-server:{name}", "-f", f"{d}/id"])
    shutil.copy(known_hosts(), f"{d}/known_hosts")
    os.chmod(f"{d}/id", 0o600)
    os.chmod(d, 0o700)
    with open(f"{d}/id.pub") as f:
        return f.read().strip()


def ensure_gitdir(name):
    os.makedirs(f"{GITDIRS}/{name}.git", exist_ok=True)


def worktree_has_files(work):
    return os.path.isdir(work) and any(e not in ("inbox", ".git-old") for e in os.listdir(work))


def setup_new_project(s, name):
    """Fresh open-slide project from the template: install deps + agent skills."""
    work = f"{PROJECTS}/{name}"
    os.makedirs(work, exist_ok=True)
    scaffold(work)
    log(s, "created a fresh open-slide project", name)
    s["projects"][name]["state"] = "installing"
    save(s)
    write_view(s)
    return npm_install(s, name, skills=True)


def connect(s, name):
    """Test access; then clone (empty worktree) or init+push (existing worktree / new project)."""
    p = s["projects"][name]
    if p.get("auth") == "token":
        if not os.path.exists(f"{TOKEN_DIR}/token"):
            p["state"] = "need_token"
            return False, "No GitHub token saved yet (see 'GitHub token')."
    else:
        ensure_key(name)
    ensure_gitdir(name)
    code, detail = git_sync(name, "test", p)
    if code == "no_access":
        if p.get("auth") == "token":
            p["state"] = "need_token"
            log(s, f"token has no access to {p['repo']} yet ({detail})", name, "warn")
            return False, (f"The token can't access {p['repo']}. On GitHub, add the repo to the token "
                           "(Repository access) with Contents: Read and write, then try again.")
        p["state"] = "need_key"
        log(s, f"no access to {p['repo']} yet ({detail})", name, "warn")
        return False, "No access yet. Add the deploy key (with write access) on GitHub, then try again."
    if code not in ("ok", "ok_empty"):
        p["state"] = "error"
        log(s, f"access test failed: {detail}", name, "error")
        return False, detail
    work = f"{PROJECTS}/{name}"
    has_files = worktree_has_files(work)
    os.makedirs(work, exist_ok=True)
    if code == "ok_empty" and not has_files:
        # New, empty repo: start a fresh open-slide project, then push it (init).
        if not setup_new_project(s, name):
            p["state"] = "error"
            return False, "Setting up the new project failed (see log)"
        has_files = True
    mode = "init" if has_files else "clone"
    code, detail = git_sync(name, mode, p)
    if code != "ok":
        p["state"] = "error"
        log(s, f"{mode} failed: {detail}", name, "error")
        return False, detail
    log(s, f"connected to {p['repo']} via {'token' if p.get('auth') == 'token' else 'deploy key'} ({mode})", name)
    if not os.path.isdir(f"{work}/node_modules") or p.get("lock_hash") != lock_hash(name):
        p["state"] = "installing"
        save(s)
        write_view(s)
        if not npm_install(s, name):
            p["state"] = "error"
            return False, "npm install failed (see log)"
    p["state"] = "ready"
    p["last_sync"] = {"t": now(), "result": "ok", "detail": mode}
    if not active_project():
        set_active(name)
    return True, "connected"


def sync_project(s, name):
    p = s["projects"][name]
    if p.get("state") != "ready" or not p.get("repo") or p.get("conflict"):
        return
    code, detail = git_sync(name, "sync", p)
    p["last_sync"] = {"t": now(), "result": code, "detail": detail}
    if code == "conflict":
        p["conflict"] = {"since": now(), "files": detail.split()}
        log(s, f"sync stopped: conflict in {detail or '?'} (resolve on the start page)", name, "error")
    elif code == "error":
        log(s, f"sync failed: {detail}", name, "error")
    elif code == "ok" and detail != "pulled=0 pushed=0":
        log(s, f"synced ({detail})", name)
    if code == "ok" and "pulled=0" not in detail and p.get("lock_hash") != lock_hash(name):
        if npm_install(s, name) and active_project() == name:
            restart_editor()


# ---------------------------------------------------------------- builds
def targets(s):
    """All wanted static builds: key -> spec."""
    t = {}
    for name, p in s["projects"].items():
        if not os.path.isdir(f"{PROJECTS}/{name}/node_modules"):
            continue
        ds = [d["id"] for d in decks(name)]
        if p.get("publish"):
            home = name == HOME_PROJECT
            t[f"{name}~all"] = dict(project=name, deck=None, browser=True,
                                    base="/slides/" if home else f"/slides/p/{name}/",
                                    link="root" if home else f"p/{name}")
            for d in ds:
                t[f"{name}~d~{d}"] = dict(project=name, deck=d, browser=False,
                                          base=f"/slides/d/{d}/" if home else f"/slides/p/{name}/d/{d}/",
                                          link=f"d/{d}" if home else f"pd/{name}/{d}")
        for tok, sh in s["shares"].items():
            if sh["project"] == name and sh["deck"] in ds:
                t[f"share~{tok}"] = dict(project=name, deck=sh["deck"], browser=False,
                                         base=f"/share/{tok}/", link=f"share/{tok}", snapshot=sh.get("snapshot"))
    return t


def inject_redirect(out, base, deck):
    """Per-deck builds have no deck browser: send <base> straight to the deck."""
    idx = f"{out}/index.html"
    with open(idx) as f:
        html = f.read()
    js = ("<script>(function(){var b=%s;var p=location.pathname;"
          "if(p===b||p+'/'===b)location.replace(b+'s/'+%s+location.search+location.hash);})()</script>"
          % (json.dumps(base), json.dumps(deck)))
    html = html.replace("<head>", "<head>" + js, 1)
    with open(idx, "w") as f:
        f.write(html)


def sanitize_build(out):
    """Build output comes from project code: keep only regular files and directories."""
    for dirpath, dirnames, filenames in os.walk(out):
        for e in dirnames + filenames:
            path = os.path.join(dirpath, e)
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                os.unlink(path)
            else:
                os.chmod(path, 0o755 if stat.S_ISDIR(st.st_mode) else 0o644)


def set_link(link, build_dir):
    path = f"{WWW}/{link}"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    symlink(os.path.relpath(build_dir, os.path.dirname(path)), path)


def build_all(s, only=None):
    os.makedirs(WWW, exist_ok=True)
    os.makedirs(BUILDS, exist_ok=True)
    want = targets(s)
    todo = {}  # project -> [(key, target)]
    fps = {}
    for key, t in want.items():
        name = t["project"]
        if only and name not in only and not key.startswith("share~"):
            continue
        if name not in fps:
            fps[name] = fingerprint(name)
        linked = os.path.lexists(f"{WWW}/{t['link']}")
        if linked and (t.get("snapshot") or s["built"].get(key) == fps[name]):
            continue
        todo.setdefault(name, []).append((key, t))
    changed = False
    for name, items in todo.items():
        job = {"targets": [{"key": k, "base": t["base"], "deck": t["deck"], "browser": t["browser"]} for k, t in items]}
        r = run_job("build", name, job, timeout=600 + 300 * len(items))
        results = {x.get("key"): x for x in r.get("results", []) if isinstance(x, dict)}
        for key, t in items:
            res = results.get(key) or {"ok": False, "out": r.get("out", "no result")}
            src = f"{JOBS}/build/out/{key}"
            if not res.get("ok") or not os.path.isfile(f"{src}/index.html") or os.path.islink(src):
                s["projects"][name]["last_build"] = {"t": now(), "ok": False, "detail": str(res.get("out", ""))[-400:]}
                log(s, f"build {key} failed: {str(res.get('out', ''))[-300:]}", name, "error")
                continue
            out = f"{BUILDS}/{key}-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"
            os.rename(src, out)
            sanitize_build(out)
            if t["deck"]:
                inject_redirect(out, t["base"], t["deck"])
            set_link(t["link"], out)
            s["built"][key] = fps[name]
            s["projects"][name]["last_build"] = {"t": now(), "ok": True, "detail": key}
            changed = True
    prune(s, want)
    return changed


def prune(s, want):
    links = {f"{WWW}/{t['link']}" for t in want.values()}
    for dirpath, dirnames, filenames in os.walk(WWW):
        for e in dirnames + filenames:
            path = os.path.join(dirpath, e)
            if os.path.islink(path) and path not in links:
                os.unlink(path)
    for dirpath, dirnames, _ in os.walk(WWW, topdown=False):
        for d in dirnames:
            path = os.path.join(dirpath, d)
            if not os.path.islink(path) and not os.listdir(path):
                os.rmdir(path)
    used = {os.path.realpath(l) for l in links if os.path.lexists(l)}
    for b in os.listdir(BUILDS):
        path = f"{BUILDS}/{b}"
        if path not in used and now() - os.lstat(path).st_mtime > 600:
            shutil.rmtree(path, ignore_errors=True)
    s["built"] = {k: v for k, v in s["built"].items() if k in want}


def expire_shares(s):
    for tok, sh in list(s["shares"].items()):
        if sh.get("expires") and sh["expires"] < now():
            del s["shares"][tok]
            log(s, f"share link for {sh['deck']} expired", sh["project"])


# ---------------------------------------------------------------- requests
def act_add_project(s, a):
    name = a.get("name")
    if not (isinstance(name, str) and NAME_RE.match(name)):
        return False, "invalid project name (a-z, 0-9, -)"
    if not a.get("remote"):
        # Local project without GitHub (can be connected later).
        if name in s["projects"] or os.path.exists(f"{PROJECTS}/{name}"):
            return False, "project exists"
        s["projects"][name] = {"created": now(), "publish": False, "branch": "main"}
        if not setup_new_project(s, name):
            s["projects"][name]["state"] = "error"
            return False, "setting up the project failed (see log)"
        s["projects"][name]["state"] = "ready"
        if not active_project():
            set_active(name)
        return True, "created"
    repo, branch = parse_repo(a.get("remote")), a.get("branch") or "main"
    auth = a.get("auth", "key")
    if not repo:
        return False, "repo must be owner/repo, a github.com URL or git@github.com:owner/repo.git"
    if not (isinstance(branch, str) and BRANCH_RE.match(branch)):
        return False, "invalid branch"
    if auth not in AUTHS:
        return False, "invalid auth"
    p = s["projects"].get(name)
    if p and p.get("repo"):
        return False, "project already connected"
    if not p:
        if os.path.exists(f"{PROJECTS}/{name}"):
            return False, "project directory exists"
        p = s["projects"][name] = {"created": now(), "publish": False}
    p.update(repo=repo, branch=branch, auth=auth)
    if auth == "token":
        log(s, f"added {repo} (via token)", name)
        return connect(s, name)
    p["state"] = "need_key"
    pub = ensure_key(name)
    log(s, f"added {repo}; waiting for deploy key", name)
    return True, {"pubkey": pub}


def act_set_auth(s, a):
    name = need_project(s, a)
    p, auth = s["projects"][name], a.get("auth")
    if auth not in AUTHS or not p.get("repo"):
        return False, "invalid"
    p["auth"] = auth
    log(s, f"now using {'the token' if auth == 'token' else 'a deploy key'}", name)
    if auth == "key":
        ensure_key(name)
    if p.get("state") == "ready":
        code, detail = git_sync(name, "test", p)
        if code not in ("ok", "ok_empty"):
            p["state"] = "need_token" if auth == "token" else "need_key"
            return False, f"no access with the new method yet: {detail}"
        return True, "switched"
    return connect(s, name)


def github_token_info(tok):
    import urllib.request, urllib.error
    req = urllib.request.Request("https://api.github.com/user", headers={
        "Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "open-slide-server"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return True, json.load(r).get("login"), r.headers.get("github-authentication-token-expiration")
    except urllib.error.HTTPError as e:
        return False, f"GitHub rejected the token (HTTP {e.code})", None
    except OSError as e:
        return False, f"could not reach GitHub: {e}", None


def act_set_token(s, a):
    tok = a.get("token")
    if not (isinstance(tok, str) and PAT_RE.match(tok.strip())):
        return False, "expected a fine-grained token (starts with github_pat_). Classic tokens can't be limited to repos."
    tok = tok.strip()
    ok, login, expires = github_token_info(tok)
    if not ok:
        return False, login
    os.makedirs(TOKEN_DIR, mode=0o700, exist_ok=True)
    path = f"{TOKEN_DIR}/token"
    fd = os.open(f"{path}.tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(tok)
    os.replace(f"{path}.tmp", path)
    os.chmod(TOKEN_DIR, 0o700)
    s["token"] = {"login": login, "expires": expires, "saved": now()}
    log(s, f"GitHub token saved (account {login}, expires {expires or 'never'})")
    for name, p in s["projects"].items():
        if p.get("auth") == "token" and p.get("state") == "need_token":
            connect(s, name)
    return True, {"login": login, "expires": expires}


def act_remove_token(s, a):
    try:
        os.unlink(f"{TOKEN_DIR}/token")
    except FileNotFoundError:
        pass
    s["token"] = None
    log(s, "GitHub token removed; projects using it stop syncing", level="warn")
    return True, "removed"


def act_set_claude_token(s, a):
    tok = a.get("token")
    tok = tok.strip() if isinstance(tok, str) else ""
    if not CLAUDE_RE.match(tok):
        return False, "expected a token from 'claude setup-token' (starts with sk-ant-oat01-)"
    os.makedirs(CLAUDE_DIR, mode=0o700, exist_ok=True)
    fd = os.open(f"{CLAUDE_DIR}/.token", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(tok)
    os.replace(f"{CLAUDE_DIR}/.token", f"{CLAUDE_DIR}/token")
    s["claude"] = {"saved": now()}
    log(s, "Claude token saved")
    return True, "saved"


def act_remove_claude_token(s, a):
    try:
        os.unlink(f"{CLAUDE_DIR}/token")
    except FileNotFoundError:
        pass
    s["claude"] = None
    log(s, "Claude token removed; the agent stops working until a new one is saved", level="warn")
    return True, "removed"


def need_project(s, a):
    name = a.get("name")
    if not (isinstance(name, str) and name in s["projects"]):
        raise ValueError("unknown project")
    return name


def act_connect(s, a):
    return connect(s, need_project(s, a))


def act_switch(s, a):
    name = need_project(s, a)
    if not os.path.isdir(f"{PROJECTS}/{name}/node_modules"):
        return False, "project not ready (no dependencies installed yet)"
    set_active(name)
    log(s, "editor switched to this project", name)
    return True, "switched"


def act_sync(s, a):
    name = need_project(s, a)
    sync_project(s, name)
    build_all(s, {name})
    return True, s["projects"][name].get("last_sync")


def act_rebuild(s, a):
    name = need_project(s, a)
    for k in list(s["built"]):
        if k.startswith(f"{name}~") or s["shares"].get(k.removeprefix("share~"), {}).get("project") == name:
            s["built"].pop(k)
    build_all(s, {name})
    return True, s["projects"][name].get("last_build")


def act_set_publish(s, a):
    name = need_project(s, a)
    s["projects"][name]["publish"] = bool(a.get("publish"))
    build_all(s, {name})
    return True, "ok"


def act_resolve(s, a):
    name = need_project(s, a)
    p = s["projects"][name]
    if a.get("mode") == "retry":
        p.pop("conflict", None)
        sync_project(s, name)
        return not p.get("conflict"), p.get("last_sync")
    code, detail = git_sync(name, "resolve", p)
    if code != "ok":
        return False, detail
    p.pop("conflict", None)
    log(s, f"conflict resolved: server changes saved to branch {detail}, took GitHub's version", name, "warn")
    if p.get("lock_hash") != lock_hash(name):
        npm_install(s, name)
    if active_project() == name:
        restart_editor()
    build_all(s, {name})
    return True, {"branch": detail}


def act_list_branches(s, a):
    name = need_project(s, a)
    p = s["projects"][name]
    if not p.get("repo") or p.get("state") != "ready":
        return False, "only for projects connected to GitHub"
    code, detail = git_sync(name, "branches", p)
    if code != "ok":
        return False, detail
    branches = sorted({b for b in detail.split() if BRANCH_RE.match(b)}, key=lambda b: (b != p["branch"], b.startswith("server/"), b.lower()))
    return True, {"current": p["branch"], "branches": branches}


def act_switch_branch(s, a):
    """Sync the current branch (nothing gets lost), then check out another (or a new) branch."""
    name = need_project(s, a)
    p = s["projects"][name]
    target, create = a.get("branch"), bool(a.get("create"))
    if not p.get("repo") or p.get("state") != "ready":
        return False, "only for projects connected to GitHub"
    if not (isinstance(target, str) and BRANCH_RE.match(target)) or target.startswith("-") or target.endswith((".", "/", ".lock")):
        return False, "invalid branch name"
    if target == p["branch"]:
        return False, f"already on {target}"
    if p.get("conflict"):
        return False, "resolve the sync conflict on the current branch first"
    sync_project(s, name)
    if p.get("conflict") or (p.get("last_sync") or {}).get("result") != "ok":
        return False, f"syncing {p['branch']} failed first, so nothing was switched: {(p.get('last_sync') or {}).get('detail', '')}"
    code, detail = git_sync(name, "switch", p, target=target, create="1" if create else "")
    if code != "ok":
        return False, detail
    old = p["branch"]
    p["branch"] = target
    log(s, f"switched branch {old} -> {target}{' (new)' if create else ''}", name)
    if p.get("lock_hash") != lock_hash(name):
        npm_install(s, name)
    if active_project() == name:
        restart_editor()
    build_all(s, {name})
    return True, {"branch": target}


def share_url(tok):
    return f"{PUBLIC_URL}/share/{tok}/"


def act_share_create(s, a):
    name = need_project(s, a)
    deck, days = a.get("deck"), a.get("expires_days", 7)
    if not (isinstance(deck, str) and DECK_RE.match(deck) and deck in [d["id"] for d in decks(name)]):
        return False, "unknown deck"
    if days not in EXPIRY_DAYS:
        return False, "invalid expiry"
    tok = secrets.token_urlsafe(16)
    s["shares"][tok] = {"project": name, "deck": deck, "created": now(),
                        "expires": now() + days * 86400 if days else None, "snapshot": bool(a.get("snapshot")),
                        "note": str(a.get("note", ""))[:80]}
    build_all(s, {name})
    if not os.path.lexists(f"{WWW}/share/{tok}"):
        del s["shares"][tok]
        return False, "build failed (see log)"
    log(s, f"share link created for {deck}", name)
    return True, {"token": tok, "url": share_url(tok)}


def act_share_revoke(s, a):
    tok = a.get("token")
    if not (isinstance(tok, str) and TOKEN_RE.match(tok) and tok in s["shares"]):
        return False, "unknown link"
    sh = s["shares"].pop(tok)
    path = f"{WWW}/share/{tok}"
    if os.path.lexists(path):
        os.unlink(path)
    prune(s, targets(s))
    log(s, f"share link for {sh['deck']} revoked", sh["project"])
    return True, "revoked"


ACTIONS = {"add_project": act_add_project, "connect": act_connect, "switch": act_switch, "sync": act_sync,
           "set_auth": act_set_auth, "set_token": act_set_token, "remove_token": act_remove_token,
           "set_claude_token": act_set_claude_token, "remove_claude_token": act_remove_claude_token,
           "rebuild": act_rebuild, "set_publish": act_set_publish, "resolve": act_resolve,
           "list_branches": act_list_branches, "switch_branch": act_switch_branch,
           "share_create": act_share_create, "share_revoke": act_share_revoke}


def apply_requests(s):
    """Process pending UI requests. Returns True if any were handled."""
    files = sorted(f for f in os.listdir(REQS) if not f.startswith("."))[:20]
    for f in os.listdir(REQS):  # half-written temp files of the admin, if it crashed
        if f.startswith("."):
            try:
                if now() - os.lstat(f"{REQS}/{f}").st_mtime > 60:
                    os.unlink(f"{REQS}/{f}")
            except OSError:
                pass
    for fn in files:
        path = f"{REQS}/{fn}"
        req, rid = None, fn.removesuffix(".json")
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                st = os.fstat(fd)
                if stat.S_ISREG(st.st_mode) and st.st_size <= 4096:
                    req = json.loads(os.read(fd, 4096))
            finally:
                os.close(fd)
        except (OSError, ValueError):
            pass
        try:
            os.unlink(path)
        except OSError:
            pass
        if not REQID_RE.match(rid):
            continue
        action = req.get("action") if isinstance(req, dict) else None
        args = req.get("args") if isinstance(req, dict) and isinstance(req.get("args"), dict) else {}
        if action not in ACTIONS:
            ok, res = False, "unknown action"
        else:
            try:
                ok, res = ACTIONS[action](s, args)
            except ValueError as e:
                ok, res = False, str(e)
            except Exception as e:  # never leave the UI waiting
                ok, res = False, f"internal error: {e}"
                log(s, f"{action} failed: {e}", level="error")
        write_json(f"{VIEW}/results/{rid}.json", {"ok": ok, "result": res, "t": now()})
        save(s)
        write_view(s)
    for fn in os.listdir(f"{VIEW}/results"):
        if now() - os.lstat(f"{VIEW}/results/{fn}").st_mtime > 3600:
            os.unlink(f"{VIEW}/results/{fn}")
    return bool(files)


# ---------------------------------------------------------------- view for the UI
def write_view(s):
    act = active_project()
    projects = []
    for name, p in sorted(s["projects"].items(), key=lambda kv: (kv[0] != HOME_PROJECT, kv[0])):
        pub = None
        if p.get("repo") and p.get("auth") != "token" and os.path.exists(f"{KEYS}/{name}/id.pub"):
            with open(f"{KEYS}/{name}/id.pub") as f:
                pub = f.read().strip()
        repo = p.get("repo")
        home = name == HOME_PROJECT
        ds = decks(name) if os.path.isdir(f"{PROJECTS}/{name}") else []
        for d in ds:
            d["editor"] = f"/editor/s/{d['id']}" if name == act else None
            if p.get("publish"):
                d["published"] = f"/slides/d/{d['id']}/" if home else f"/slides/p/{name}/d/{d['id']}/"
        projects.append({
            "name": name, "active": name == act, "repo": repo, "auth": p.get("auth"), "branch": p.get("branch"),
            "publish": bool(p.get("publish")), "state": p.get("state", "local"), "pubkey": pub,
            "repo_url": f"https://github.com/{repo}" if repo else None,
            "deploy_keys_url": f"https://github.com/{repo}/settings/keys/new" if repo else None,
            "last_sync": p.get("last_sync"), "last_build": p.get("last_build"), "conflict": p.get("conflict"),
            "site": ("/slides/" if home else f"/slides/p/{name}/") if p.get("publish") else None,
            "decks": ds,
        })
    shares = [{"token": t, **sh, "url": share_url(t), "live": os.path.lexists(f"{WWW}/share/{t}")}
              for t, sh in sorted(s["shares"].items(), key=lambda kv: -kv[1]["created"])]
    tok = s.get("token") if os.path.exists(f"{TOKEN_DIR}/token") else None
    write_json(f"{VIEW}/status.json", {"updated": now(), "editor": "/editor/", "slides": "/slides/",
                                         "token": tok,  # login + expiry only, never the token itself
                                         "claude": ({"saved": (s.get("claude") or {}).get("saved") or int(os.path.getmtime(f"{CLAUDE_DIR}/token"))}
                                                    if os.path.exists(f"{CLAUDE_DIR}/token") else None),
                                         "projects": projects, "shares": shares, "log": s["log"][-60:][::-1]})


# ---------------------------------------------------------------- main loop
def first_run(s):
    """Fresh install: create the home project so the editor works right away."""
    if s["projects"]:
        return
    s["projects"][HOME_PROJECT] = {"created": now(), "publish": True, "branch": "main"}
    log(s, "first start: setting up your first project", HOME_PROJECT)
    if setup_new_project(s, HOME_PROJECT):
        s["projects"][HOME_PROJECT]["state"] = "ready"
        set_active(HOME_PROJECT)
    else:
        s["projects"][HOME_PROJECT]["state"] = "error"


def main():
    for d in (PROJECTS, EMPTY, GITDIRS, KEYS, STATE, REQS, VIEW, f"{VIEW}/results", WWW, BUILDS,
              f"{JOBS}/build", f"{JOBS}/deps", CONTROL, CLAUDE_DIR):
        os.makedirs(d, exist_ok=True)
    os.chmod(KEYS, 0o700)
    os.chmod(CLAUDE_DIR, 0o700)
    os.chmod(REQS, 0o700)
    for link in ("active", "build-src", "deps-src"):
        if not os.path.lexists(f"{DATA}/{link}"):
            symlink("projects/.none", f"{DATA}/{link}")
    s = load()
    write_view(s)
    first_run(s)
    save(s)
    write_view(s)
    last_cycle = 0
    while True:
        try:
            busy = apply_requests(s)
            if time.time() - last_cycle >= CYCLE_SECONDS:
                last_cycle = time.time()
                expire_shares(s)
                for name in sorted(s["projects"]):
                    try:
                        sync_project(s, name)
                    except Exception as e:
                        log(s, f"sync crashed: {e}", name, "error")
                build_all(s)
                busy = True
            if busy:
                save(s)
                write_view(s)
        except Exception as e:
            log(s, f"worker error: {e}", level="error")
            save(s)
            write_view(s)
            time.sleep(5)
        time.sleep(1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "decks"} for k, v in load()["projects"].items()}, indent=1))
    else:
        main()
