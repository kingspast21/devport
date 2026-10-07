'use strict';
// Finds startable projects under the projects root: folders (and work/<folder>)
// with a package.json that has a dev, start or serve script.
const fs = require('node:fs');
const path = require('node:path');

// Only these scripts can be started from the dashboard, in order of preference.
const STARTABLE = ['dev', 'start', 'serve'];

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
];

// Framework before the bundler it wraps.
const STACK_DEPS = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['astro', 'Astro'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@remix-run/dev', 'Remix'],
  ['@angular/core', 'Angular'],
  ['vite', 'Vite'],
  ['react-scripts', 'CRA'],
  ['webpack-dev-server', 'Webpack'],
  ['http-server', 'http-server'],
  ['express', 'Express'],
];

function packageManager(files) {
  for (const [lock, pm] of LOCKFILES) if (files.has(lock)) return pm;
  return 'npm';
}

function stackOf(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [dep, label] of STACK_DEPS) if (deps[dep]) return label;
  return 'Node';
}

function startableScripts(pkg) {
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  return STARTABLE.filter((s) => typeof scripts[s] === 'string' && scripts[s].trim()).map((name) => {
    const m = scripts[name].match(/--port[=\s]+(\d{2,5})/);
    return { name, command: scripts[name], port: m ? Number(m[1]) : null };
  });
}

function readProject(dir, name, group, exclude) {
  if (exclude.has(path.resolve(dir).toLowerCase())) return null;
  let entries;
  try {
    entries = new Set(fs.readdirSync(dir));
  } catch {
    return null;
  }
  if (!entries.has('package.json')) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const scripts = startableScripts(pkg);
  if (!scripts.length) return null;
  return {
    id: group === 'work' ? `work/${name}` : name,
    name,
    path: dir,
    group,
    stack: stackOf(pkg),
    pm: packageManager(entries),
    scripts,
    installed: entries.has('node_modules'),
  };
}

function listProjects(root, { exclude = [] } = {}) {
  const ex = new Set(exclude.map((p) => path.resolve(p).toLowerCase()));
  const out = [];
  let top;
  try {
    top = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of top) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    const dir = path.join(root, d.name);
    if (d.name.toLowerCase() === 'work') {
      let inner = [];
      try {
        inner = fs.readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const w of inner) {
        if (!w.isDirectory() || w.name.startsWith('.')) continue;
        const p = readProject(path.join(dir, w.name), w.name, 'work', ex);
        if (p) out.push(p);
      }
      continue;
    }
    const p = readProject(dir, d.name, 'personal', ex);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

module.exports = { listProjects, startableScripts, stackOf, packageManager, STARTABLE };
