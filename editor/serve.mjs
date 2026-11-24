// Start open-slide's dev server for /workspace under a sub-path (EDITOR_BASE), without changing the repo.
// Uses the project's own @open-slide/core (public export "./vite") and the vite it depends on.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const cwd = '/workspace';
function pkgDir(name, from) {
  for (let d = from; ; d = path.dirname(d)) {
    const c = path.join(d, 'node_modules', name);
    if (existsSync(path.join(c, 'package.json'))) return c;
    if (d === '/') throw new Error(`${name} not found (is the project installed?)`);
  }
}
function entry(dir, sub = '.') {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let e = pkg.exports?.[sub] ?? (sub === '.' ? pkg.module ?? pkg.main : null);
  while (e && typeof e === 'object') e = e.import ?? e.default;
  if (!e) throw new Error(`${dir}: no entry for ${sub}`);
  return pathToFileURL(path.join(dir, e)).href;
}
const core = pkgDir('@open-slide/core', cwd);
const { createViteConfig } = await import(entry(core, './vite'));
const { createServer, mergeConfig } = await import(entry(pkgDir('vite', core)));

const base = process.env.EDITOR_BASE || '/editor/';
const server = await createServer(mergeConfig(await createViteConfig({ userCwd: cwd }), {
  base,
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
await server.listen();
console.log(`open-slide editor listening on 127.0.0.1:5173${base}`);
