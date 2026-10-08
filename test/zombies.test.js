'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitsFrom, flag, alertsFor, fmtDuration } = require('../lib/zombies');

const H = 3600 * 1000;

test('limits: defaults, overrides, 0 disables, junk falls back', () => {
  const d = limitsFrom({});
  assert.equal(d.staleHours, 8);
  assert.equal(d.memMb, 1024);
  assert.equal(d.notify, true);
  const o = limitsFrom({ DEVPORT_STALE_HOURS: '2.5', DEVPORT_MEM_MB: '512', DEVPORT_ALERTS: '0' });
  assert.equal(o.staleMs, 2.5 * H);
  assert.equal(o.memBytes, 512 * 1024 * 1024);
  assert.equal(o.notify, false);
  assert.equal(limitsFrom({ DEVPORT_STALE_HOURS: '0' }).staleMs, Infinity);
  assert.equal(limitsFrom({ DEVPORT_MEM_MB: 'lots' }).memMb, 1024);
});

test('flag + alerts: stale and heavy, one alert per reason, stable keys', () => {
  const now = 100 * H;
  const limits = limitsFrom({});
  const dev = [
    { pid: 1, port: 5173, start: now - 9 * H - 12 * 60000, mem: 200 * 1024 ** 2, repo: { name: 'storefront' } },
    { pid: 2, port: 3000, start: now - 1 * H, mem: 1.5 * 1024 ** 3, repo: null },
    { pid: 3, port: 4321, start: now - 1 * H, mem: 100 * 1024 ** 2, repo: { name: 'docs' } },
    { pid: 4, port: 8080, start: 0, mem: 0, repo: null },
  ];
  flag(dev, limits, now);
  assert.deepEqual(dev.map((d) => d.flags), [
    { stale: true, heavy: false },
    { stale: false, heavy: true },
    { stale: false, heavy: false },
    { stale: false, heavy: false },
  ]);
  const a = alertsFor(dev, now);
  assert.deepEqual(a.map((x) => x.key), ['1:stale', '2:heavy']);
  assert.equal(a[0].text, 'storefront on :5173 has been running for 9h 12m.');
  assert.equal(a[1].text, 'A dev server on :3000 is using 1.5 GB.');
});

test('durations', () => {
  assert.equal(fmtDuration(42 * 1000), '42s');
  assert.equal(fmtDuration(5 * 60000), '5m');
  assert.equal(fmtDuration(8 * H + 3 * 60000), '8h 03m');
  assert.equal(fmtDuration(50 * H), '2d 2h');
});
