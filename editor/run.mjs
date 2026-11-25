// Editor container entrypoint (PID 1).
//  - Starts open-slide's dev server for /workspace on 127.0.0.1:5173 (serve.mjs). open-slide only
//    enables the agent for requests from loopback, so the gateway reaches it through the TCP
//    forwarder below (0.0.0.0:8080 -> 127.0.0.1:5173). Auth happens in the gateway.
//  - Exits when /control/generation changes (project switch). Docker restarts the container,
//    which re-resolves the ./data/active symlink, so the editor comes back on the new project.
//  - Without an installed project, serves a small "no project yet" page instead.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const GEN_FILE = '/control/generation';
const readGen = () => { try { return readFileSync(GEN_FILE, 'utf8').trim(); } catch { return ''; } };
const startGen = readGen();
let child = null;

function stop(code = 0) {
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
  if (!child) process.exit(code);
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
setInterval(() => { if (readGen() !== startGen) { console.log('project switched, restarting'); stop(0); } }, 1500);

// User-level instructions for the agent (environment notes), refreshed on every start.
try {
  mkdirSync('/home/node/.claude', { recursive: true });
  writeFileSync('/home/node/.claude/CLAUDE.md', readFileSync('/opt/open-slide/editor/CLAUDE.md'));
} catch (e) { console.log(`could not write ~/.claude/CLAUDE.md: ${e.message}`); }

// Claude Code trusts claude-proxy's CA (NODE_EXTRA_CA_CERTS); give the proxy a moment to publish it.
for (let i = 0; i < 60 && !existsSync('/claude-ca/claude-ca.crt'); i++) await new Promise((r) => setTimeout(r, 1000));

const ready = existsSync('/workspace/package.json') && existsSync('/workspace/node_modules/@open-slide/core');

if (ready) {
  let host = '';
  try { host = new URL(process.env.PUBLIC_URL || '').hostname; } catch {}
  child = spawn(process.execPath, ['/opt/open-slide/editor/serve.mjs'], {
    cwd: '/workspace',
    stdio: 'inherit',
    env: { ...process.env, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host },
  });
  child.on('exit', (code) => { console.log(`dev server exited (${code})`); child = null; stop(code || 1); });
  net.createServer((c) => {
    const u = net.connect(5173, '127.0.0.1');
    c.pipe(u).pipe(c);
    c.on('error', () => u.destroy());
    u.on('error', () => c.destroy());
  }).listen(8080, '0.0.0.0');
} else {
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>open-slide editor</title><body style="font:16px system-ui;max-width:36em;margin:4em auto;padding:0 1em">
<h1>No project yet</h1><p>The editor starts once a project is set up. Open the <a href="/">start page</a>
to add one or to see what is happening.</p><script>setTimeout(()=>location.reload(),5000)</script>`;
  http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  }).listen(8080, '0.0.0.0');
  // Restart into the real editor once the project is installed.
  setInterval(() => {
    if (existsSync('/workspace/package.json') && existsSync('/workspace/node_modules/@open-slide/core')) stop(0);
  }, 3000);
}
