// Job runner for the "builder" (no network) and "deps" (npm registry only) containers.
//
// Isolation without a Docker socket: the worker points ./data/<kind>-src at ONE project and writes
// /jobs/job.json with that project's inode. This container only ever sees the project mounted at
// /src. If the inode doesn't match, it exits and Docker restarts it, which re-resolves the symlink.
// One job per container lifetime: when the job is done the container exits, so nothing a build
// left running survives into the next job. Lifetime is kept >= 11 s so Docker's restart backoff
// stays at its minimum.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

const kind = process.argv[2];
if (kind !== 'build' && kind !== 'deps') throw new Error('usage: runner.mjs build|deps');
const J = '/jobs';
const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DECK_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_~-]{1,160}$/;
const BASE_RE = /^\/[A-Za-z0-9_\/-]{0,200}\/$/;

async function exitSoon() {
  const left = 11_000 - (Date.now() - started);
  if (left > 0) await sleep(left);
  process.exit(0);
}

function readJob() {
  try { return JSON.parse(readFileSync(`${J}/job.json`, 'utf8')); } catch { return null; }
}

function run(cmd, args, env, timeoutS) {
  const r = spawnSync(cmd, args, {
    cwd: '/tmp', env: { PATH: process.env.PATH, HOME: '/tmp', ...env },
    encoding: 'utf8', timeout: timeoutS * 1000, maxBuffer: 16 << 20,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-4).join(' | ').slice(-600);
  return { ok: r.status === 0, code: r.status, out: r.error ? `${r.error.message} ${out}` : out };
}

function doBuild(job) {
  const results = [];
  for (const t of job.targets || []) {
    if (!KEY_RE.test(t.key) || !BASE_RE.test(t.base) || (t.deck && !DECK_RE.test(t.deck))) {
      results.push({ key: t.key, ok: false, out: 'invalid target' });
      continue;
    }
    const out = `${J}/out/${t.key}`;
    mkdirSync(out, { recursive: true });
    const r = run('sh', ['/opt/open-slide/runner/build-one.sh'], {
      PROJECT: '/src', OUT: out, BASE: t.base, DECK: t.deck || '', BROWSER: t.browser ? 'true' : 'false',
    }, 600);
    results.push({ key: t.key, ...r });
  }
  return { results };
}

function doDeps(job) {
  const opts = ['--ignore-scripts', '--no-audit', '--no-fund'];
  const env = { npm_config_cache: '/tmp/npm-cache' };
  const install = existsSync('/src/package-lock.json')
    ? spawnSync('npm', ['ci', ...opts], { cwd: '/src', env: { ...process.env, ...env, HOME: '/tmp' }, encoding: 'utf8', timeout: 900_000, maxBuffer: 16 << 20 })
    : spawnSync('npm', ['install', ...opts], { cwd: '/src', env: { ...process.env, ...env, HOME: '/tmp' }, encoding: 'utf8', timeout: 900_000, maxBuffer: 16 << 20 });
  const tail = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join(' | ').slice(-600);
  if (install.status !== 0) return { ok: false, out: tail(install) || String(install.error) };
  if (job.skills) {
    const s = spawnSync('npx', ['--offline', 'open-slide', 'sync:skills'], { cwd: '/src', env: { ...process.env, HOME: '/tmp' }, encoding: 'utf8', timeout: 300_000 });
    if (s.status !== 0) return { ok: false, out: `skills: ${tail(s)}` };
  }
  return { ok: true, out: tail(install) };
}

for (;;) {
  const job = readJob();
  if (!job || typeof job.id !== 'string' || !/^[a-z0-9-]{6,40}$/.test(job.id)) { await sleep(1000); continue; }
  const resultFile = `${J}/result-${job.id}.json`;
  if (existsSync(resultFile)) { await sleep(1000); continue; } // done; the worker removes job.json
  let st;
  try { st = statSync('/src'); } catch { st = null; }
  if (!st || st.ino !== job.ino) {
    console.log(`job ${job.id}: /src is not the requested project yet; restarting to re-mount`);
    await exitSoon();
  }
  console.log(`job ${job.id}: ${kind} ${job.project}`);
  let result;
  try { result = kind === 'build' ? doBuild(job) : doDeps(job); }
  catch (e) { result = { ok: false, out: String(e?.message || e) }; }
  writeFileSync(`${resultFile}.tmp`, JSON.stringify(result));
  renameSync(`${resultFile}.tmp`, resultFile);
  console.log(`job ${job.id}: done`);
  await exitSoon();
}
