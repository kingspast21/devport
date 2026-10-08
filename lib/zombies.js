'use strict';
// Zombie detection: dev servers that look forgotten (running for hours) or
// heavy (using a lot of memory). Pure, so it's unit-testable.

const DEFAULTS = { staleHours: 8, memMb: 1024 };

// Env value -> number. Unset or invalid = default; 0 or less = disabled.
function num(v, def) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return n > 0 ? n : Infinity;
}

function limitsFrom(env = process.env) {
  const staleHours = num(env.DEVPORT_STALE_HOURS, DEFAULTS.staleHours);
  const memMb = num(env.DEVPORT_MEM_MB, DEFAULTS.memMb);
  return {
    staleHours,
    memMb,
    staleMs: staleHours * 3600 * 1000,
    memBytes: memMb * 1024 * 1024,
    notify: env.DEVPORT_ALERTS !== '0',
  };
}

function fmtDuration(ms) {
  if (ms < 60000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m`;
}

function fmtMem(b) {
  return b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
}

// Adds d.flags = { stale, heavy } to each dev server, in place.
function flag(dev, limits, now = Date.now()) {
  for (const d of dev) {
    d.flags = {
      stale: !!d.start && now - d.start > limits.staleMs,
      heavy: (d.mem || 0) > limits.memBytes,
    };
  }
  return dev;
}

// One alert per server per reason. The key is stable for the life of the
// process, so a listener can announce each one exactly once.
function alertsFor(dev, now = Date.now()) {
  const out = [];
  for (const d of dev) {
    if (!d.flags) continue;
    const name = d.repo ? d.repo.name : 'A dev server';
    if (d.flags.stale) {
      out.push({ key: `${d.pid}:stale`, pid: d.pid, port: d.port, name, reason: 'stale', text: `${name} on :${d.port} has been running for ${fmtDuration(now - d.start)}.` });
    }
    if (d.flags.heavy) {
      out.push({ key: `${d.pid}:heavy`, pid: d.pid, port: d.port, name, reason: 'heavy', text: `${name} on :${d.port} is using ${fmtMem(d.mem)}.` });
    }
  }
  return out;
}

module.exports = { limitsFrom, flag, alertsFor, fmtDuration, DEFAULTS };
