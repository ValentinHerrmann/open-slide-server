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

> [!CAUTION]
> **open-slide-server has no login of its own.** It listens on `127.0.0.1` only. **You** must put
> HTTPS and a login in front of it, for everything except `/share/`
> ([protection setups](#protection-setups) below).
>
> If the start page, `/editor/` or `/__*` are reachable without login, **anyone who finds the URL can**:
> - **use your Claude subscription**: the agent runs as you, on your quota
> - **read, change and delete all your decks**, and run code in the editor sandbox
> - **push to every GitHub repo** your token or deploy keys can write to (sync is automatic)
> - **create public share links**, and replace or remove your tokens
>
> The Claude token itself stays hidden even then (only the Claude proxy can read it), but everything
> it unlocks is open. Never publish the port directly, and never set `BIND=0.0.0.0` without a
> firewall and a login in front.

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
1. Set up protection: `sh scripts/protect.sh` ([options](#protection-setups)), then `sh scripts/test-protection.sh <your URL>`.
2. Under **Claude** on the start page, paste a token from `claude setup-token`. Run it on any computer with Claude Code; it's valid for one year.

How to use the start page: [docs/usage.md](docs/usage.md).

The Claude agent only works with your own subscription. It is a single-user tool: don't give others access to your editor.

## Protection setups

Every setup must (1) serve HTTPS, (2) require **your** login for everything, (3) except paths
starting with `/share/` (share links are meant to work without login).

**The quick way:** run the generator. It asks a few questions, writes a ready-to-run config into
`./protect/` (nothing outside it is changed) and prints the remaining steps for your dashboards:

```sh
sh scripts/protect.sh
```

| # | Setup | Good for | Effort | What you get |
|---|---|---|---|---|
| 1 | **Cloudflare Tunnel + Access** (recommended) | most people: reachable from anywhere, no open ports | ~20 min, free plan, domain on Cloudflare | `cloudflared` container + the Access apps to click. Login by email code / Google / GitHub. |
| 2 | **Caddy + Cloudflare (proxied DNS)** | you run your own Caddy on a server with a public IP and want Cloudflare in front | ~30 min, free plan, domain on Cloudflare | Caddy (with JWT + DNS plugins) that only accepts Cloudflare (Authenticated Origin Pulls) **and** verifies the Access login token itself, so a misconfigured Access policy still fails closed. Certificates via DNS. The most defensive setup. |
| 3 | **Caddy + basic auth** | quick start on a server with a public IP | ~10 min | Caddy + a generated 24-character password. No 2FA, no lockout. |
| 4 | **Tailscale only** | just you, on your own devices | ~5 min | One `tailscale serve` command. Share links only work inside your tailnet. Never use Funnel for this port: it would make the editor public. |
| 5 | **Caddy + SSO proxy** (Authelia, authentik, oauth2-proxy) | you already run one, or want 2FA without Cloudflare | 30–60 min | Caddy with `forward_auth` to your auth service. |

Step-by-step explanations: [docs/ingress.md](docs/ingress.md).

**Then test it.** This checks from the outside, without any login, that only `/share/` is open:

```sh
sh scripts/test-protection.sh https://slides.example.com
```

If it reports **OPEN**, stop the stack right away (`docker compose stop`) and fix your setup. Also open
`/editor/` in a private browser window once: you must see a login first.

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
