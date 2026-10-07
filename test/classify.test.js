'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, detectRepo, detectStack, bindingOf } = require('../lib/classify');

const ROOT = 'C:\\Users\\dev\\projects';

test('repo under projects root (quoted, spaces in name)', () => {
  const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\dev\\projects\\My App\\node_modules\\vite\\bin\\vite.js" --port 5173';
  assert.deepEqual(detectRepo(cmd, ROOT), {
    name: 'My App',
    path: 'C:\\Users\\dev\\projects\\My App',
    group: 'personal',
  });
});

test('work repo, different case on root, forward slashes', () => {
  const cmd = 'node C:/Users/dev/Projects/Work/client-portal/node_modules/astro/astro.js dev';
  const r = detectRepo(cmd, ROOT);
  assert.equal(r.name, 'client-portal');
  assert.equal(r.group, 'work');
  assert.equal(r.path, 'C:\\Users\\dev\\Projects\\Work\\client-portal');
});

test('unquoted script directly in repo root', () => {
  const r = detectRepo('node C:\\Users\\dev\\projects\\api\\server.js --port 8080', ROOT);
  assert.equal(r.name, 'api');
  const r2 = detectRepo('node C:\\Users\\dev\\projects\\api --port 8080', ROOT);
  assert.equal(r2.name, 'api');
});

test('repo outside projects root falls back to node_modules parent', () => {
  const r = detectRepo('"node.exe" "D:\\dev\\thing\\node_modules\\next\\dist\\bin\\next" dev', ROOT);
  assert.deepEqual(r, { name: 'thing', path: 'D:\\dev\\thing', group: 'other' });
});

test('no path means no repo', () => {
  assert.equal(detectRepo('python -m http.server 8000', ROOT), null);
  assert.equal(detectRepo('', ROOT), null);
});

test('stack detection prefers framework over bundler', () => {
  assert.equal(detectStack('node C:\\x\\node_modules\\astro\\astro.js dev', 'node'), 'Astro');
  assert.equal(detectStack('node C:\\x\\node_modules\\vite\\bin\\vite.js', 'node'), 'Vite');
  assert.equal(detectStack('node C:\\x\\node_modules\\next\\dist\\server\\lib\\start-server.js', 'node'), 'Next.js');
  assert.equal(detectStack('python -m http.server 8000', 'python'), 'http.server');
  assert.equal(detectStack('node server.js', 'node'), 'node');
});

test('a dev server run by a runtime that lives inside a tool folder is still a dev server', () => {
  const hermesNode = '"C:\\Users\\dev\\AppData\\Local\\hermes\\tools\\node-26\\node.exe"';
  const listeners = [{ port: 5181, addr: '::1', pid: 1 }, { port: 8099, addr: '0.0.0.0', pid: 2 }, { port: 9000, addr: '127.0.0.1', pid: 3 }];
  const procs = new Map([
    [1, { pid: 1, name: 'node.exe', cmd: `${hermesNode} "C:\\Users\\dev\\projects\\demo-site\\node_modules\\vite\\bin\\vite.js" --port 5181` }],
    [2, { pid: 2, name: 'python.exe', cmd: 'C:\\Users\\dev\\AppData\\Local\\hermes\\tools\\py\\python.exe -m http.server 8099' }],
    [3, { pid: 3, name: 'python.exe', cmd: 'C:\\Users\\dev\\AppData\\Local\\hermes\\tools\\py\\python.exe -I "C:\\Users\\dev\\AppData\\Local\\hermes\\hermes-agent\\.hermes\\bin\\hermes.exe" serve' }],
  ]);
  const { dev, other } = classify(listeners, procs, { projectsRoot: ROOT, selfPid: 0 });
  assert.deepEqual(dev.map((d) => d.pid), [1, 2]);
  assert.equal(dev[0].repo.name, 'demo-site');
  assert.equal(other[0].kind, 'tooling');
});

test('binding', () => {
  assert.equal(bindingOf(['::1']), 'ipv6-only');
  assert.equal(bindingOf(['127.0.0.1', '::1']), 'local');
  assert.equal(bindingOf(['0.0.0.0']), 'all');
});

test('classify protects Hermes, self, and non-runtimes; merges ports per pid', () => {
  const listeners = [
    { port: 5173, addr: '::1', pid: 10 },
    { port: 24678, addr: '::1', pid: 10 },
    { port: 61181, addr: '127.0.0.1', pid: 20 },
    { port: 7777, addr: '127.0.0.1', pid: 30 },
    { port: 135, addr: '0.0.0.0', pid: 40 },
    { port: 8000, addr: '0.0.0.0', pid: 50 },
  ];
  const procs = new Map([
    [10, { pid: 10, name: 'node.exe', cmd: '"node.exe" "C:\\Users\\dev\\projects\\web-app\\node_modules\\vite\\bin\\vite.js"' }],
    [20, { pid: 20, name: 'python.exe', cmd: 'C:\\Users\\dev\\AppData\\Local\\hermes\\tools\\python.exe -m hermes_cli.main gateway run' }],
    [30, { pid: 30, name: 'node.exe', cmd: 'node server.js' }],
    [40, { pid: 40, name: 'svchost.exe', cmd: '' }],
    [50, { pid: 50, name: 'python.exe', cmd: 'python -m http.server 8000' }],
  ]);
  const { dev, other } = classify(listeners, procs, { projectsRoot: ROOT, selfPid: 30 });
  assert.equal(dev.length, 2);
  assert.deepEqual(dev[0].ports, [5173, 24678]);
  assert.equal(dev[0].repo.name, 'web-app');
  assert.equal(dev[0].binding, 'ipv6-only');
  assert.equal(dev[1].stack, 'http.server');
  assert.equal(dev[1].repo, null);
  const kinds = Object.fromEntries(other.map((o) => [o.pid, o.kind]));
  assert.deepEqual(kinds, { 20: 'tooling', 30: 'self', 40: 'system' });
  assert.equal(dev[1].display, 'python -m http.server 8000');
  assert.equal(dev[0].display, 'node .\\node_modules\\vite\\bin\\vite.js');
  assert.ok(other.every((o) => !o.killable));
});
