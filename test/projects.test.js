'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listProjects, startableScripts, stackOf, packageManager } = require('../lib/projects');
const { Launches } = require('../lib/launch');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devport-test-'));
  const mk = (rel, pkg, extra = []) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    if (pkg !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
    for (const f of extra) fs.mkdirSync(path.join(dir, f), { recursive: true });
  };
  mk('storefront', { scripts: { dev: 'vite --port 5180 --strictPort', build: 'vite build' }, devDependencies: { vite: '7' } }, ['node_modules']);
  mk('docs', { scripts: { dev: 'astro dev', start: 'astro dev' }, dependencies: { astro: '5' } });
  mk('Work/client-portal', { scripts: { dev: 'next dev' }, dependencies: { next: '16' } }, ['node_modules']);
  mk('build-only', { scripts: { build: 'tsc' } });
  mk('broken', '{ not json');
  mk('static-site');
  mk('.hidden', { scripts: { dev: 'x' } });
  mk('self', { scripts: { start: 'node server.js' } });
  fs.writeFileSync(path.join(root, 'docs', 'pnpm-lock.yaml'), '');
  return root;
}

test('lists only projects with a startable script, work/ grouped, self excluded', () => {
  const root = fixture();
  try {
    const list = listProjects(root, { exclude: [path.join(root, 'self')] });
    assert.deepEqual(list.map((p) => p.id), ['work/client-portal', 'docs', 'storefront']);
    const [portal, docs, store] = list;
    assert.equal(portal.group, 'work');
    assert.equal(portal.stack, 'Next.js');
    assert.equal(docs.pm, 'pnpm');
    assert.equal(docs.installed, false);
    assert.deepEqual(docs.scripts.map((s) => s.name), ['dev', 'start']);
    assert.equal(store.scripts[0].port, 5180);
    assert.equal(store.installed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing root gives an empty list', () => {
  assert.deepEqual(listProjects(path.join(os.tmpdir(), 'devport-nope-' + Date.now())), []);
});

test('script allowlist ignores build, test and non-string scripts', () => {
  const s = startableScripts({ scripts: { build: 'x', test: 'y', serve: 'serve -l 3000', start: 42, dev: '  ' } });
  assert.deepEqual(s.map((x) => x.name), ['serve']);
  assert.equal(startableScripts({}).length, 0);
  assert.equal(startableScripts(null).length, 0);
});

test('stack and package manager detection', () => {
  assert.equal(stackOf({ devDependencies: { vite: '1', '@sveltejs/kit': '2' } }), 'SvelteKit');
  assert.equal(stackOf({}), 'Node');
  assert.equal(packageManager(new Set(['yarn.lock'])), 'yarn');
  assert.equal(packageManager(new Set(['package-lock.json'])), 'npm');
});

test('launch attribution walks the parent chain to the launch root', () => {
  const l = new Launches();
  l.roots.set(100, { name: 'api', path: 'C:\\p\\api', group: 'personal' });
  const dev = [
    { pid: 300, repo: null },
    { pid: 400, repo: null },
    { pid: 500, repo: { name: 'kept', path: 'C:\\p\\kept' } },
  ];
  const parents = new Map([[300, 200], [200, 100], [100, 4], [400, 999]]);
  l.attribute(dev, parents);
  assert.equal(dev[0].repo.name, 'api');
  assert.equal(dev[1].repo, null);
  assert.equal(dev[2].repo.name, 'kept');
});
