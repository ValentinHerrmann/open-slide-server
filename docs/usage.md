# Using the start page

Open your URL. The start page shows your projects with their decks, your share links, and (collapsed) settings and an activity log. A banner at the top tells you if setup isn't finished yet, e.g. the Claude token is missing.

## Projects

- A project is one open-slide workspace, usually one GitHub repo. On the first start, a project called `main` is created; it isn't connected to GitHub yet.
- The **editor** always shows one project; its card is marked "in the editor". **Edit** next to any deck, or **Open in editor** on a card, switches the editor to that project if needed (a few seconds) and opens it.
- **+ New project:**
  - Give it a short name.
  - Choose **Only on this server**, or **In a GitHub repo** (`owner/repo` or its URL, plus the access method: your token or a deploy key).
  - A project only on this server isn't backed up. Use **Connect to GitHub** on its card later.
  - An **empty** repo gets a fresh open-slide project, which is pushed as the first commit.
  - An existing open-slide repo is cloned and its dependencies installed. The repo needs no changes for this server.

- **Remove a project:** use **More → Remove from this server** on its card. The GitHub repo is never touched: your latest edits are saved there first, and you can add the repo again any time. A project that isn't on GitHub is deleted for good (**Delete project**), so you confirm by typing its name. Its share links stop working.

## GitHub: token or deploy key

- **Fine-grained token** (recommended for your own and your organisations' repos):
  1. On GitHub, go to Settings → Developer settings → Fine-grained tokens → Generate.
  2. Under *Repository access*, choose **Only select repositories**. Under *Permissions → Contents*, choose **Read and write**.
  3. Paste the token under **Settings → GitHub** on the start page. It's stored for the worker only and never shown again.
  4. To add more repos later, tick them on GitHub; nothing changes on the server.
- **Deploy key**, for a colleague's personal repo: GitHub doesn't let your token reach those.
  - The start page shows a key for that one repo. The owner adds it under *Settings → Deploy keys* with **Allow write access**.
  - Then click **Done: check again**.

## Sync

- Every few minutes (`CYCLE_SECONDS`), each connected project is synced both ways on its branch:
  1. Server edits are committed as "open-slide server".
  2. GitHub's changes are pulled with a rebase.
  3. The result is pushed. It never force-pushes.
- **Conflicts:** if you and a collaborator changed the same lines, syncing stops for that project and the start page shows the files. Either:
  - **Keep GitHub's version.** The server's version is saved to a branch first. Nothing is lost: merge the `server/<date>` branch on GitHub, e.g. with a pull request.
  - Or fix it on GitHub yourself and click **I fixed it on GitHub: retry**.

## Branches

- Each project connected to GitHub works on one branch at a time, shown on its card. Click **change** next to it to open the branch dialog:
  - **Switch to an existing branch** from the list of the repo's branches on GitHub.
  - Or **create a new branch** from the current state, e.g. to try something out or to give a collaborator their own line of work.
- Before switching, the current branch is synced, so your latest edits are committed and pushed and nothing is lost. A pending conflict has to be resolved first.
- From then on, sync, publishing and share links use the new branch. If the project is open in the editor, the editor reloads with it.
- Merging branches happens on GitHub, e.g. with a pull request. The server syncs the result.

## Publishing

- The **Published** switch on a project card builds the project's decks to `/slides/` (the `main` project) or `/slides/p/<name>/` (other projects).
- Builds include presenter mode, animations and every other feature, and are read-only. They are rebuilt automatically after changes.
- Who can open them is decided by your login in front, e.g. a per-path rule for `/slides/d/<deck>/` to let presenters see one deck.

## Share links

- **Share** on a deck creates `https://…/share/<token>/`. Anyone with the link sees only that deck, without login.
- **Options:**
  - Expiry: 1, 7 or 30 days, or never.
  - **Freeze** keeps the current version. Otherwise the link follows your edits.
- **Revoke** works immediately: share pages are never cached.

## Files for the agent

- Upload images, videos, fonts and other files with the **asset panel** in the editor (25 MB per file, per deck or global `assets/`).
- These files are part of the repo, so they are committed and pushed to GitHub. Don't upload confidential material into a project that syncs to a shared repo.
- The agent can **search the web** and, with `EDITOR_INTERNET=on` (the default), **open URLs**, use MCP servers and install packages, all through a filtering proxy that never reaches your host or local network. With `EDITOR_INTERNET=off` it can only search. Then paste a page's text or upload it as PDF instead.
