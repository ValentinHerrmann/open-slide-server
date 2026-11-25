// open-slide start page / admin UI backend. Deliberately powerless: it can only
//   - read  /state/view/status.json and /state/view/results/<id>.json (written by the worker)
//   - write request files into /state/requests/ (validated again by the worker)
// No keys, no git, no project files, no network except the gateway. Auth: the gateway.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const PORT = 8080;
const ORIGIN = new URL(process.env.PUBLIC_URL).origin;
const VIEW = '/state/view';
const REQS = '/state/requests';
const STATIC = path.dirname(new URL(import.meta.url).pathname);
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/static/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/favicon.ico': ['icons/favicon.ico', 'image/x-icon'],
  '/static/icon.svg': ['icons/icon.svg', 'image/svg+xml'],
  '/static/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/static/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/static/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
};
const ACTIONS = new Set(['add_project', 'connect', 'switch', 'sync', 'rebuild', 'set_publish', 'resolve',
  'set_auth', 'set_token', 'remove_token', 'set_claude_token', 'remove_claude_token', 'list_branches', 'switch_branch', 'remove_project', 'create_ssh_key', 'check_ssh_key', 'remove_ssh_key',
  'share_create', 'share_revoke', 'copy_deck']);
const ID_RE = /^[a-z0-9-]{8,40}$/;

const SEC = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { ...SEC, 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Drop stale temp files (crash between write and rename).
setInterval(async () => {
  for (const f of await readdir(REQS).catch(() => [])) {
    if (!f.startsWith('.')) continue;
    const st = await stat(path.join(REQS, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 60_000) await unlink(path.join(REQS, f)).catch(() => {});
  }
}, 60_000).unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && FILES[p]) {
      const [file, type] = FILES[p];
      return send(res, 200, await readFile(path.join(STATIC, file)), type);
    }
    if (req.method === 'GET' && p === '/api/status') {
      const data = await readFile(path.join(VIEW, 'status.json')).catch(() => null);
      return data ? send(res, 200, data) : send(res, 503, { error: 'worker has not run yet' });
    }
    const m = p.match(/^\/api\/result\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && m && ID_RE.test(m[1])) {
      const data = await readFile(path.join(VIEW, 'results', `${m[1]}.json`)).catch(() => null);
      return data ? send(res, 200, data) : send(res, 202, { pending: true });
    }

    if (req.method === 'POST' && p === '/api/request') {
      // CSRF: same-origin only, custom header (forces CORS preflight), JSON only.
      if (req.headers.origin !== ORIGIN) return send(res, 403, { error: 'bad origin' });
      if (req.headers['x-requested-with'] !== 'open-slide-admin') return send(res, 403, { error: 'bad request' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req));
      if (!body || typeof body !== 'object' || !ACTIONS.has(body.action)) return send(res, 400, { error: 'unknown action' });
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
      const id = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
      const data = JSON.stringify({ action: body.action, args, by: req.headers['cf-access-authenticated-user-email'] || null });
      if (data.length > 4096) return send(res, 413, { error: 'too large' });
      const tmp = path.join(REQS, `.${id}`);
      await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
      await rename(tmp, path.join(REQS, `${id}.json`));
      return send(res, 202, { id });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: 'bad request' });
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(PORT, '0.0.0.0', () => console.log(`admin listening on :${PORT}`));
