'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Launches, readFrom } = require('../lib/launch');

test('logs: servers under a launch root get logs; others do not', () => {
  const l = new Launches();
  l.roots.set(100, { name: 'api', path: 'C:\\p\\api', group: 'personal', out: 'a.out.log', err: 'a.err.log' });
  const dev = [
    { pid: 300, repo: { name: 'api', path: 'C:\\p\\api' } },
    { pid: 400, repo: null },
  ];
  l.attribute(dev, new Map([[300, 200], [200, 100], [400, 4]]));
  assert.equal(dev[0].logs, true);
  assert.equal(dev[1].logs, undefined);
  assert.deepEqual(l.logsFor(300), { out: 'a.out.log', err: 'a.err.log' });
  assert.equal(l.logsFor(400), null);
});

test('logs: resolved pids are cached and pruned when they stop listening', () => {
  const l = new Launches();
  l.roots.set(100, { name: 'api', path: 'C:\\p\\api', group: 'personal', out: 'o', err: 'e' });
  const dev = [{ pid: 300, repo: null }];
  l.attribute(dev, new Map([[300, 100]]));
  assert.equal(l.unresolved([{ pid: 300 }]).length, 0, 'cached');
  l.decorate([]);
  assert.equal(l.pidRoot.has(300), false, 'pruned');
});

test('readFrom: tail first, then only new bytes, ANSI stripped, reset on truncation', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devport-log-')), 'x.log');
  try {
    assert.deepEqual(readFrom(f, -1), { text: '', next: 0, size: 0 }, 'missing file');
    fs.writeFileSync(f, '\x1b[32mVITE\x1b[39m ready\r\n');
    const a = readFrom(f, -1);
    assert.equal(a.text, 'VITE ready\n');
    fs.appendFileSync(f, 'line two\n');
    const b = readFrom(f, a.next);
    assert.equal(b.text, 'line two\n');
    assert.equal(readFrom(f, b.next).text, '');
    fs.writeFileSync(f, 'new\n');
    assert.equal(readFrom(f, b.next).text, 'new\n', 'truncated file restarts at 0');
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});

test('readFrom: a long log starts at a line boundary', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devport-log-')), 'big.log');
  try {
    fs.writeFileSync(f, 'x'.repeat(70 * 1024) + '\nlast line\n');
    const r = readFrom(f, -1);
    assert.equal(r.text, 'last line\n');
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
});
