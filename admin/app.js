// open-slide start page. Deck titles, notes and log lines may come from other people's repos,
// so everything is inserted as text (never as HTML). All actions go through the worker.
'use strict';
const API = '/api';
const TOKEN_NEW = 'https://github.com/settings/personal-access-tokens/new';
const TOKEN_LIST = 'https://github.com/settings/personal-access-tokens';
let state = null;
let busy = false;

// ---------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round(Date.now() / 1000 - t);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t * 1000).toLocaleDateString();
};
const until = (t) => {
  if (!t) return 'never expires';
  const s = t - Date.now() / 1000;
  return s < 86400 ? `expires in ${Math.max(1, Math.round(s / 3600))} h` : `expires in ${Math.round(s / 86400)} days`;
};

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), bad ? 12000 : 5000);
}

async function request(action, args, label) {
  if (busy) return toast('Another action is still running…', true);
  busy = true;
  document.body.classList.add('busy');
  toast(`${label}…`);
  try {
    const r = await fetch(`${API}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'open-slide-admin' },
      body: JSON.stringify({ action, args }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const { id } = await r.json();
    for (let i = 0; i < 600; i++) {
      await sleep(1000);
      const res = await fetch(`${API}/result/${id}`);
      if (res.status === 200) {
        const out = await res.json();
        await load(true);
        if (!out.ok) toast(`${label} failed: ${typeof out.result === 'string' ? out.result : JSON.stringify(out.result)}`, true);
        else toast(`${label}: done`);
        return out;
      }
    }
    throw new Error('timed out waiting for the server');
  } catch (e) {
    toast(`${label} failed: ${e.message}`, true);
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied to the clipboard');
  } catch {
    prompt('Copy the link:', text);
  }
}

// Open a deck (or the editor) in project p, switching the editor first if needed.
async function openInEditor(p, path = '') {
  if (p.active) return void (location.href = `/editor/${path}`);
  const out = await request('switch', { name: p.name }, `Opening ${p.name} in the editor`);
  if (!out?.ok) return;
  toast('Starting the editor…');
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    const r = await fetch('/editor/', { cache: 'no-store' }).catch(() => null);
    if (r?.ok) return void (location.href = `/editor/${path}`);
    await sleep(1000);
  }
  toast('The editor takes unusually long to start; try the Editor button in a moment.', true);
}

const defaultAuth = () => (state.token ? 'token' : state.ssh?.login ? 'ssh' : 'key');
const AUTH_NAMES = { token: 'my token', ssh: 'my SSH key', key: 'a deploy key' };

function radio(form, name, value) {
  for (const r of form.querySelectorAll(`input[name=${name}]`)) r.checked = r.value === value;
}

// ---------------------------------------------------------------- dialogs
function newProjectDialog() {
  const dlg = $('#new-dlg');
  const form = $('#new-form');
  form.reset();
  radio(form, 'auth', defaultAuth());
  const sync = () => {
    const gh = form.kind.value === 'github';
    $('#new-github').hidden = !gh;
    form.remote.required = gh;
  };
  form.onchange = sync;
  sync();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const f = new FormData(form);
    const gh = f.get('kind') === 'github';
    request('add_project', {
      name: f.get('name').trim(),
      remote: gh ? f.get('remote').trim() : '',
      branch: gh ? (f.get('branch').trim() || 'main') : 'main',
      auth: f.get('auth') || 'token',
    }, `Creating project ${f.get('name').trim()}`);
  };
  dlg.showModal();
}

function connectDialog(p) {
  const dlg = $('#connect-dlg');
  const form = $('#connect-form');
  form.reset();
  $('#connect-project').textContent = p.name;
  radio(form, 'auth', defaultAuth());
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const f = new FormData(form);
    request('add_project', { name: p.name, remote: f.get('remote').trim(), branch: 'main', auth: f.get('auth') || 'token' }, 'Connecting to GitHub');
  };
  dlg.showModal();
}

function removeProject(p) {
  const msg = p.repo
    ? `Remove "${p.name}" from this server?\n\nYour latest edits are saved to GitHub first; the repo ${p.repo} is not touched and you can add it again any time. Share links of this project stop working.\n\nType the project name to confirm:`
    : `Delete "${p.name}" for good?\n\nIt is NOT on GitHub, so its decks are lost. Share links of this project stop working.\n\nType the project name to confirm:`;
  const typed = prompt(msg);
  if (typed === null) return;
  if (typed.trim() !== p.name) return toast('The name didn’t match; nothing was removed.', true);
  request('remove_project', { name: p.name, confirm: p.name }, `Removing ${p.name}`);
}

function shareDialog(p, deck) {
  const dlg = $('#share-dlg');
  const form = $('#share-form');
  form.reset();
  $('#share-deck').textContent = deck.title || deck.id;
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const f = new FormData(form);
    const out = await request('share_create', {
      name: p.name, deck: deck.id, expires_days: Number(f.get('expires_days')),
      snapshot: f.get('snapshot') === 'on', note: f.get('note') || '',
    }, `Creating a share link for ${deck.title || deck.id}`);
    if (out?.ok) copy(out.result.url);
  };
  dlg.showModal();
}

async function branchDialog(p) {
  const out = await request('list_branches', { name: p.name }, `Loading branches of ${p.repo}`);
  if (!out?.ok) return;
  const dlg = $('#branch-dlg');
  const form = $('#branch-form');
  form.reset();
  $('#branch-project').textContent = p.name;
  $('#branch-current').textContent = p.branch;
  const others = out.result.branches.filter((b) => b !== p.branch);
  form.branch.replaceChildren(h('option', { value: '' }, others.length ? '— choose —' : '(no other branches yet)'), ...others.map((b) => h('option', { value: b }, b)));
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const f = new FormData(form);
    const fresh = (f.get('new') || '').trim();
    const branch = fresh || f.get('branch');
    if (!branch) return toast('Choose a branch or enter a name for a new one', true);
    request('switch_branch', { name: p.name, branch, create: !!fresh },
      fresh ? `Creating branch ${fresh}` : `Switching ${p.name} to ${branch}`);
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- sections
function renderSetup() {
  const todo = [];
  if (!state.claude) todo.push(h('li', {}, h('b', {}, 'Save your Claude token'), ' so the agent in the editor works. ',
    h('button', { class: 'link', onclick: () => openSettings('#claude') }, 'Open settings')));
  if (!state.token && !state.ssh && !state.projects.some((p) => p.repo)) todo.push(h('li', {}, 'Optional: ', h('b', {}, 'save a GitHub token'),
    ' to back up projects and work with collaborators. ', h('button', { class: 'link', onclick: () => openSettings('#token') }, 'Open settings')));
  const box = $('#setup');
  box.hidden = !todo.length;
  box.replaceChildren(h('div', { class: 'callout warn' }, h('b', {}, 'Finish setting up'), h('ul', {}, todo)));
}

function openSettings(sel) {
  $('#settings').open = true;
  $(sel).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function status(p) {
  if (p.state === 'installing') return ['warn', 'Setting up… (installing, about a minute)'];
  if (p.state === 'error') return ['bad', 'Needs attention: see below'];
  if (p.conflict) return ['bad', 'Sync paused: conflicting changes'];
  if (p.state === 'need_token') return ['warn', 'Waiting for GitHub access (token)'];
  if (p.state === 'need_key') return ['warn', 'Waiting for GitHub access (deploy key)'];
  if (p.state === 'need_ssh') return ['warn', 'Waiting for GitHub access (SSH key)'];
  if (!p.repo) return ['', 'Only on this server (no backup)'];
  const ls = p.last_sync;
  if (!ls) return ['', 'Connected to GitHub'];
  if (ls.result === 'ok') return ['ok', `Saved to GitHub · ${ago(ls.t)}`];
  if (ls.result === 'busy') return ['warn', `Sync retrying (you were editing) · ${ago(ls.t)}`];
  return ['bad', `Sync failed ${ago(ls.t)}: ${ls.detail || ls.result}`];
}

function attention(p) {
  const connect = () => request('connect', { name: p.name }, 'Checking access and syncing');
  if (p.conflict) {
    return h('div', { class: 'callout bad' },
      h('p', {}, h('b', {}, 'You and someone on GitHub changed the same lines'), ` in ${(p.conflict.files || []).join(', ') || 'some files'}. Nothing was overwritten; syncing is paused until you decide:`),
      h('div', { class: 'row' },
        h('button', { onclick: () => confirm('Save the server’s version to a new branch “server/…” on GitHub and continue with GitHub’s version? You can merge that branch later with a pull request.') && request('resolve', { name: p.name, mode: 'branch' }, 'Resolving the conflict') }, 'Keep GitHub’s version (server’s saved to a branch)'),
        h('button', { class: 'secondary', onclick: () => request('resolve', { name: p.name, mode: 'retry' }, 'Retrying the sync') }, 'I fixed it on GitHub: retry')));
  }
  if (p.state === 'need_token') {
    return h('div', { class: 'callout warn' },
      h('p', {}, state.token
        ? ['The server can’t access ', h('b', {}, p.repo), ' with your token yet. On GitHub, open ', h('a', { href: TOKEN_LIST }, 'your fine-grained tokens'),
          ', edit the token and add this repo under “Repository access” (Contents: Read and write).']
        : ['Save a GitHub token first: ', h('button', { class: 'link', onclick: () => openSettings('#token') }, 'open settings'), '.']),
      h('div', { class: 'row' }, h('button', { onclick: connect }, 'Done: check again')));
  }
  if (p.state === 'need_ssh') {
    return h('div', { class: 'callout warn' },
      h('p', {}, state.ssh
        ? ['The server can’t access ', h('b', {}, p.repo), ' with your SSH key',
          state.ssh.login ? [' (GitHub account ', h('b', {}, state.ssh.login), ')'] : ' (the key isn’t on your GitHub account yet)',
          '. Make sure the key is added to your account and that your account has write access to the repo: for a colleague’s repo, ask them once to add you as a collaborator.']
        : ['Create the server’s SSH key first and add it to your GitHub account: ', h('button', { class: 'link', onclick: () => openSettings('#sshkey') }, 'open settings'), '.']),
      h('div', { class: 'row' }, h('button', { onclick: () => request('connect', { name: p.name }, 'Checking access and syncing') }, 'Done: check again')));
  }
  if (p.state === 'need_key') {
    return h('div', { class: 'callout warn' },
      h('p', {}, 'Add this deploy key to ', h('b', {}, p.repo), ' with ', h('b', {}, 'Allow write access'), ' (', h('a', { href: p.deploy_keys_url }, 'open the repo’s deploy keys'),
        '), or send it to the repo’s owner to do that.'),
      h('div', { class: 'row' }, h('code', { class: 'key' }, p.pubkey || ''), h('button', { class: 'secondary', onclick: () => copy(p.pubkey) }, 'Copy key')),
      h('div', { class: 'row' }, h('button', { onclick: connect }, 'Done: check again')));
  }
  if (p.state === 'error') {
    return h('div', { class: 'callout bad' }, h('p', {}, 'Something went wrong while setting up this project (details under Activity at the bottom).'),
      h('div', { class: 'row' }, p.repo ? h('button', { onclick: connect }, 'Try again') : null));
  }
  return null;
}

function renderDeck(p, d, ready) {
  return h('li', {},
    h('div', { class: 'deck-title' }, d.title || d.id, d.title ? h('span', { class: 'muted small' }, d.id) : null),
    h('div', { class: 'deck-actions' },
      ready ? h('button', { class: 'small', onclick: () => openInEditor(p, `s/${encodeURIComponent(d.id)}`) }, 'Edit') : null,
      d.published ? h('a', { class: 'btn small secondary', href: d.published }, 'View') : null,
      ready ? h('button', { class: 'small secondary', onclick: () => shareDialog(p, d) }, 'Share') : null));
}

function renderProject(p) {
  const ready = p.state === 'ready' || p.state === 'local';
  const [cls, text] = status(p);
  const card = h('article', { class: `card${p.active ? ' active' : ''}` });

  card.append(h('div', { class: 'row space' },
    h('h3', {}, p.name, p.active ? h('span', { class: 'badge ok' }, 'in the editor') : null),
    h('span', { class: `badge ${cls}` }, text)));

  card.append(h('p', { class: 'muted small meta' },
    p.repo
      ? [h('a', { href: p.repo_url }, p.repo), ' · branch ', h('b', {}, p.branch),
        p.state === 'ready' && !p.conflict ? [' ', h('button', { class: 'link', onclick: () => branchDialog(p) }, 'change')] : null]
      : ['Not backed up. ', ready ? h('button', { class: 'link', onclick: () => connectDialog(p) }, 'Connect to GitHub') : null]));

  const att = attention(p);
  if (att) card.append(att);

  const list = h('ul', { class: 'decks' }, p.decks.map((d) => renderDeck(p, d, ready)));
  if (!p.decks.length) list.append(h('li', { class: 'muted' }, ready ? 'No decks yet. Open the editor and create one (or ask the agent).' : 'No decks yet.'));
  card.append(list);

  const pubToggle = ready ? h('label', { class: 'check' }, h('input', {
    type: 'checkbox', checked: p.publish,
    onchange: (e) => request('set_publish', { name: p.name, publish: e.target.checked }, e.target.checked ? 'Publishing' : 'Unpublishing'),
  }), ' Published', p.site ? [' at ', h('a', { href: p.site }, p.site)] : null) : null;

  const more = h('details', { class: 'more' }, h('summary', {}, 'More'),
    h('div', { class: 'row' },
      p.repo && p.state === 'ready' ? h('button', { class: 'small secondary', onclick: () => request('sync', { name: p.name }, 'Syncing with GitHub') }, 'Sync with GitHub now') : null,
      ready ? h('button', { class: 'small secondary', onclick: () => request('rebuild', { name: p.name }, 'Rebuilding the published version') }, 'Rebuild published version') : null,
      p.repo && ['ready', 'need_key', 'need_token', 'need_ssh'].includes(p.state)
        ? ['token', 'ssh', 'key'].filter((a) => a !== p.auth).map((a) => h('button', {
          class: 'small secondary', onclick: () => request('set_auth', { name: p.name, auth: a }, 'Changing the access method'),
        }, `Access via ${AUTH_NAMES[a]}`)) : null,
      h('button', { class: 'small danger', onclick: () => removeProject(p) }, p.repo ? 'Remove from this server' : 'Delete project')),
    p.last_build ? h('p', { class: 'muted small' }, `Last build ${ago(p.last_build.t)}${p.last_build.ok ? '' : ' (failed, see Activity)'}`) : null);

  card.append(h('div', { class: 'row space foot' },
    h('div', { class: 'row' },
      ready ? h('button', { onclick: () => openInEditor(p) }, p.active ? 'Open editor' : 'Open in editor') : null,
      pubToggle),
    ready ? more : h('button', { class: 'small danger', onclick: () => removeProject(p) }, p.repo ? 'Remove from this server' : 'Delete project')));
  return card;
}

function renderShares() {
  const box = $('#shares');
  if (!state.shares.length) return box.replaceChildren(h('p', { class: 'muted' }, 'No share links yet.'));
  box.replaceChildren(h('ul', { class: 'shares' }, state.shares.map((s) => h('li', {},
    h('div', {},
      h('b', {}, s.deck), s.note ? [' · ', s.note] : null,
      h('div', { class: 'muted small' }, `${s.project} · ${s.snapshot ? 'frozen version' : 'follows your edits'} · ${until(s.expires)} · created ${ago(s.created)}`)),
    h('div', { class: 'deck-actions' },
      s.live ? [h('button', { class: 'small', onclick: () => copy(s.url) }, 'Copy link'), h('a', { class: 'btn small secondary', href: s.url }, 'Open')]
        : h('span', { class: 'bad small' }, 'build failed'),
      h('button', { class: 'small danger', onclick: () => confirm(`Revoke the link for ${s.deck}? It stops working immediately.`) && request('share_revoke', { token: s.token }, 'Revoking the link') }, 'Revoke'))))));
}

function secretForm(action, placeholder, label, note) {
  return h('form', {
    class: 'row', onsubmit: (e) => {
      e.preventDefault();
      const tok = new FormData(e.target).get('token').trim();
      e.target.reset();
      request(action, { token: tok }, note);
    },
  }, h('input', { name: 'token', type: 'password', autocomplete: 'off', placeholder, required: true, size: 40 }), h('button', {}, label));
}

function renderClaude() {
  const c = state.claude;
  $('#claude').replaceChildren(
    c ? h('p', {}, h('span', { class: 'badge ok' }, 'token saved'), ' ', h('span', { class: 'muted small' }, new Date(c.saved * 1000).toLocaleDateString()), ' ',
      h('button', { class: 'small danger', onclick: () => confirm('Remove the Claude token? The agent stops working until a new one is saved.') && request('remove_claude_token', {}, 'Removing the Claude token') }, 'Remove'))
      : h('p', { class: 'bad' }, 'No token yet: the agent in the editor can’t work.'),
    secretForm('set_claude_token', 'sk-ant-oat01-…', c ? 'Replace token' : 'Save token', 'Saving the Claude token'),
    h('p', { class: 'muted small' }, 'On any computer with Claude Code, run ', h('code', {}, 'claude setup-token'),
      ', log in with your Claude subscription and paste the token here (valid for a year). Only the Claude proxy can read it; ',
      'the editor and the code of your repos never see it, and it is never shown again.'));
}

function renderToken() {
  const t = state.token;
  const soon = t?.expires && new Date(t.expires.replace(' ', 'T').replace(' ', '')) - Date.now() < 14 * 864e5;
  $('#token').replaceChildren(
    t ? h('p', {}, h('span', { class: `badge ${soon ? 'warn' : 'ok'}` }, `token saved · ${t.login}`), ' ',
      h('span', { class: soon ? 'bad small' : 'muted small' }, t.expires ? `expires ${t.expires}` : 'no expiry'), ' ',
      h('a', { href: TOKEN_LIST, class: 'small' }, 'choose repos on GitHub'), ' ',
      h('button', { class: 'small danger', onclick: () => confirm('Remove the GitHub token? Projects using it stop syncing until a new one is saved.') && request('remove_token', {}, 'Removing the GitHub token') }, 'Remove'))
      : h('p', { class: 'muted' }, 'No token saved. Projects can still use deploy keys.'),
    secretForm('set_token', 'github_pat_…', t ? 'Replace token' : 'Save token', 'Checking and saving the GitHub token'),
    h('p', { class: 'muted small' }, h('a', { href: TOKEN_NEW }, 'Create a fine-grained token'),
      ': Repository access → “Only select repositories” (your slide repos), Permissions → Contents → ', h('b', {}, 'Read and write'),
      '. You can add more repos there later without changing anything here. The token is only used for syncing and never shown again.'));
}

function renderSsh() {
  const k = state.ssh;
  const box = $('#sshkey');
  if (!k) {
    return box.replaceChildren(
      h('p', { class: 'muted small' }, 'Lets the server reach every repo your GitHub account can, including colleagues’ personal repos where you’re a collaborator, without asking them for a deploy key. ',
        'GitHub can’t limit such a key to certain repos, so it can write to all of them; it is only used by the sync worker, which never runs repo code.'),
      h('button', { onclick: () => request('create_ssh_key', {}, 'Creating the SSH key') }, 'Create SSH key'));
  }
  box.replaceChildren(
    h('p', {}, k.login ? h('span', { class: 'badge ok' }, `works · GitHub account ${k.login}`) : h('span', { class: 'badge warn' }, 'not on GitHub yet')),
    h('div', { class: 'row' }, h('code', { class: 'key' }, k.pubkey), h('button', { class: 'small secondary', onclick: () => copy(k.pubkey) }, 'Copy key')),
    k.login ? null : h('p', { class: 'small' }, '1. Copy the key. 2. On GitHub: ', h('a', { href: 'https://github.com/settings/ssh/new' }, 'Settings → SSH and GPG keys → New SSH key'),
      ' (key type “Authentication Key”, title e.g. “open-slide server”). 3. Check:'),
    h('div', { class: 'row' },
      h('button', { class: k.login ? 'small secondary' : '', onclick: () => request('check_ssh_key', {}, 'Checking the SSH key with GitHub') }, k.login ? 'Check again' : 'Check'),
      h('button', { class: 'small danger', onclick: () => confirm('Remove the SSH key from this server? Projects using it stop syncing. Also delete it on GitHub.') && request('remove_ssh_key', {}, 'Removing the SSH key') }, 'Remove')));
}

function render() {
  $('#updated').textContent = `updated ${ago(state.updated)}`;
  renderSetup();
  $('#projects').replaceChildren(...state.projects.map(renderProject));
  renderShares();
  renderClaude();
  renderToken();
  renderSsh();
  $('#log').replaceChildren(...state.log.slice(0, 40).map((l) => h('li', { class: l.level },
    h('span', { class: 'muted small' }, new Date(l.t * 1000).toLocaleString(), ' '), l.project ? h('b', {}, `${l.project}: `) : null, l.msg)));
}

async function load(force = false) {
  const r = await fetch(`${API}/status`, { cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return toast('The server is starting up…', true);
  state = await r.json();
  const typing = document.activeElement?.matches('input,select');
  if (force || (!document.querySelector('dialog[open]') && !typing)) render();
}

$('#new-project').addEventListener('click', () => state && newProjectDialog());
load();
setInterval(() => !busy && load(), 10000);
