# open-slide-server

Self-host [open-slide](https://open-slide.dev) (React slide decks with a Claude agent)
for **one person**, with:

- **Editor** with the Claude agent, using *your* Claude subscription.
- **Start page**: projects, GitHub sync, publishing, share links.
- **Published decks** with presenter mode and every feature, read-only, behind your login.
- **Share links**: one deck, no login needed, expiring, revocable in one click.
- **GitHub sync**, two-way, per project: your own repos via a fine-grained token, colleagues' repos via deploy keys.

Everything runs from one `docker compose` file and lives on **one host name**:

| Path | What | Who |
|---|---|---|
| `/` | start page | you |
| `/editor/` | editor + agent | you |
| `/slides/` | your published decks | you (and whoever else your login allows) |
| `/share/<token>/` | one deck via share link | anyone with the link |

**Login is your job:**
- The stack listens on `127.0.0.1` only and does no login itself.
- Your reverse proxy provides HTTPS and must require login for everything except `/share/`.
- Our responsibility ends at the local port.

## Quick start

Requirements: Linux with Docker Engine + Compose v2, ~2 GB free RAM, a Claude Pro/Max
subscription, and your own HTTPS + login in front (suggestions: [docs/ingress.md](docs/ingress.md)).

```sh
git clone https://github.com/ValentinHerrmann/open-slide-server.git && cd open-slide-server
./setup.sh
```

`setup.sh` does the following:
1. Asks for your URL and local port, and writes `.env`.
2. Downloads the prebuilt images from `ghcr.io`, or builds them locally if that fails.
3. Prepares `./data`, starts everything and runs the self-check (`scripts/check.sh`).

Then:
1. Point your reverse proxy at `127.0.0.1:<port>` ([docs/ingress.md](docs/ingress.md)) and open your URL.
2. Under **Claude** on the start page, paste a token from `claude setup-token`. Run it on any computer with Claude Code; it's valid for one year.

How to use the start page: [docs/usage.md](docs/usage.md).

The Claude agent only works with your own subscription. It is a single-user tool: don't give others access to your editor.

## Security model

**Priorities:**
1. Nothing can be attacked from public URLs.
2. The Claude token can't leak.
3. Code from repos you open stays contained.

```
 browser ─▶ YOUR https + login ─▶ 127.0.0.1:PORT gateway ─┬─▶ admin (start page) ──▶ worker
                                                          ├─▶ editor-relay ─▶ editor (sandbox) ──▶ claude-proxy ─▶ api.anthropic.com
                                                          └─▶ static files: /slides, /share
```

| Part | Holds | Network | Runs code from your repos? |
|---|---|---|---|
| gateway | nothing secret | the only published port (127.0.0.1) | no |
| editor-relay | nothing | forwards gateway → editor only | no |
| editor | **placeholder** Claude token | sandbox network: no internet, no host, no gateway/admin; only claude-proxy | **yes** (Vite config, decks, agent tools) |
| claude-proxy | your Claude token | Anthropic API only, fixed paths | no |
| admin | nothing | gateway only | no |
| worker | GitHub token, deploy keys | GitHub | no (git hooks off, git dir outside the worktree) |
| builder | nothing | **none** | yes, one project at a time, read-only |
| deps | nothing | npm registry | no (`npm ci --ignore-scripts`) |

**Public URLs** (`/share/...`):
- They are static files: an existing share link or 404.
- The gateway matches `/share/<22 characters>/…` strictly (no dot segments, no encoded dots or slashes), so a share URL can never reach anything else.
- Requests from other sites are refused, except plain links (`Sec-Fetch-Site`). A malicious page can't use your logged-in browser against the start page or editor.

**Claude token:**
- It exists only in `data/claude/token`, which only the claude-proxy container mounts. It is saved through the start page and never shown again.
- The editor sends Claude API calls to the proxy with a placeholder, and the proxy swaps in the token. It forwards only Claude API paths to `api.anthropic.com`, so it can't be used to send data elsewhere.
- The editor has no other way out: an internal Docker network, with no IP for the host on that bridge.
- The token never reaches a browser.

**Repos you open:**
- An open-slide project is code: its Vite config, its decks, its `.claude/settings.json` hooks. All of it runs in the editor or builder sandbox.
- It **cannot** read your Claude or GitHub credentials, reach the internet, see your other projects (the editor and builder only ever mount one project), or reach host services.
- It **can**:
  - change the project's files (visible in git history)
  - use your Claude quota
  - act through the start page while you have the editor open in your browser, because decks run as JavaScript on the same site
- Server-side, the editor can't reach the gateway or the start page at all.
- So only open repos whose authors you trust.

**Other hardening:**
- Nothing gets the Docker socket, and nothing runs as root.
- Every container is read-only, with all capabilities dropped and `no-new-privileges`.
- Memory and process limits apply, and Docker images are pinned.

## Operations

```sh
docker compose ps                          # status
docker compose logs -f worker              # sync / build log (also on the start page)
sh scripts/check.sh                        # security self-check (makes one tiny Claude request)
git pull && docker compose pull && docker compose up -d      # update
docker compose build                       # build images yourself (set OPEN_SLIDE_VERSION=local in .env)
```

- **Backup:** `./data`. It holds your tokens, so treat backups as secret. Projects connected to GitHub are also on GitHub.
- **New Claude token:** use **Replace token** on the start page. It takes effect immediately.
- **Settings:** edit `.env`, then run `docker compose up -d`.
- **GitHub Pages:** `templates/github-pages.yml` is a workflow for publishing a repo's decks **publicly** on GitHub Pages, if you want that.

## License

MIT, see [LICENSE](LICENSE). This project builds on [open-slide](https://open-slide.dev) (MIT, © Yiwei Ho);
the logo in `admin/icons/` is open-slide's. Claude Code is installed from npm (`@anthropic-ai/claude-code`)
under Anthropic's terms; you use it with your own subscription.
