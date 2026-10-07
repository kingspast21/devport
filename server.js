#!/usr/bin/env node
'use strict';
// devport: local dashboard for the dev servers running on this machine.
// Binds to 127.0.0.1 only. Mutating endpoints require a same-origin request
// (Host + Origin checks plus a custom header) so other sites can't drive it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { scan, killTree, parentMap, stopWorker } = require('./lib/scan');
const { listProjects } = require('./lib/projects');
const { Launches, readFrom, pruneLogs } = require('./lib/launch');

const PORT = Number(process.env.DEVPORT_PORT || 7777);
const HOST = '127.0.0.1';
const PROJECTS_ROOT = process.env.DEVPORT_ROOT || path.join(os.homedir(), 'projects');
const PUBLIC = path.join(__dirname, 'public');
const OPTS = { projectsRoot: PROJECTS_ROOT, selfPid: process.pid };
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
  return req.headers['x-devport'] === '1';
}

const launches = new Launches();
const pathKey = (p) => path.resolve(p).toLowerCase();

// Scan + launch attribution + project list, in one consistent snapshot.
async function fullScan() {
  const r = await scan(OPTS);
  const pending = launches.unresolved(r.dev);
  if (pending.length) {
    const parents = await parentMap().catch(() => null);
    if (parents) launches.resolve(pending, parents);
  }
  launches.decorate(r.dev);
  const running = new Map();
  for (const d of r.dev) {
    if (!d.repo) continue;
    const k = pathKey(d.repo.path);
    if (!running.has(k)) running.set(k, []);
    running.get(k).push({ pid: d.pid, port: d.port });
  }
  launches.update(new Set(running.keys()));
  const projects = listProjects(PROJECTS_ROOT, { exclude: [__dirname] }).map((p) => {
    const l = launches.get(p.path);
    return {
      ...p,
      running: running.get(pathKey(p.path)) || [],
      lastScript: launches.lastScript.get(pathKey(p.path)) || null,
      launch: l ? { state: l.state, script: l.script, since: l.since, reason: l.reason, log: l.log, logFile: l.out } : null,
    };
  });
  return { ...r, projects };
}

// Last full scan, for the tray: served instantly, refreshed in the background
// when older than 2s, so the tray's UI thread never waits on a scan.
let snapshot = null;
let refreshing = false;
function refreshSnapshot() {
  if (refreshing) return;
  refreshing = true;
  fullScan()
    .then((r) => (snapshot = r))
    .catch(() => {})
    .finally(() => (refreshing = false));
}
function summary() {
  if (!snapshot || Date.now() - snapshot.scannedAt > 2000) refreshSnapshot();
  if (!snapshot) return { ready: false, count: 0, servers: [] };
  return {
    ready: true,
    count: snapshot.dev.length,
    mem: snapshot.dev.reduce((a, d) => a + (d.mem || 0), 0),
    servers: snapshot.dev.map((d) => ({ pid: d.pid, port: d.port, name: d.repo ? d.repo.name : null, stack: d.stack })),
  };
}

// Re-scan right before acting, so a PID recycled since the page loaded can't be hit.
async function findDev(pid) {
  const { dev } = await fullScan();
  return dev.find((d) => d.pid === pid);
}

function detached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.on('error', () => {});
  child.unref();
}

const CODE_CMD = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/scan') {
    const r = await fullScan();
    snapshot = r;
    return send(res, 200, { ...r, projectsRoot: PROJECTS_ROOT });
  }
  // Reads below also need the custom header: logs can hold secrets, and a
  // cross-origin page can't send it without a (refused) CORS preflight.
  if (req.method === 'GET' && url.pathname === '/api/summary') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused' });
    return send(res, 200, summary());
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused' });
    const pid = Number(url.searchParams.get('pid'));
    const files = launches.logsFor(pid);
    if (!files) return send(res, 404, { error: 'No logs for this server. devport only has logs for servers it started.' });
    const num = (k) => {
      const v = Number(url.searchParams.get(k));
      return Number.isFinite(v) ? v : -1;
    };
    return send(res, 200, { file: files.out, out: readFrom(files.out, num('out')), err: readFrom(files.err, num('err')) });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused' });
  const body = await readJson(req).catch(() => null);
  if (!body) return send(res, 400, { error: 'Body must be JSON' });

  if (url.pathname === '/api/kill') {
    const pid = Number(body.pid);
    const target = await findDev(pid);
    if (!target) return send(res, 404, { error: `PID ${pid} is no longer a dev server. Refresh and try again.` });
    await killTree(pid).catch(() => {});
    return send(res, 200, { ok: true, killed: [pid] });
  }

  if (url.pathname === '/api/kill-all') {
    const { dev } = await fullScan();
    const killed = [];
    for (const d of dev) {
      await killTree(d.pid).then(() => killed.push(d.pid), () => {});
    }
    return send(res, 200, { ok: true, killed });
  }

  if (url.pathname === '/api/start') {
    // Only a project from a fresh listing, and only one of its allowlisted scripts.
    const { projects, dev, other } = await fullScan();
    const project = projects.find((p) => p.id === body.id);
    if (!project) return send(res, 404, { error: 'Project not found. Refresh and try again.' });
    const script = project.scripts.find((s) => s.name === body.script) || project.scripts[0];
    if (!project.installed) {
      return send(res, 409, { error: `${project.name} has no node_modules. Run ${project.pm} install in it first.` });
    }
    if (project.running.length) {
      return send(res, 409, { error: `${project.name} is already running on :${project.running[0].port}.` });
    }
    if (project.launch && project.launch.state === 'starting') {
      return send(res, 409, { error: `${project.name} is already starting.` });
    }
    const port = script.port;
    if (port && dev.concat(other).some((d) => d.ports.includes(port))) {
      return send(res, 409, { error: `Port ${port} is already taken, and ${project.name}'s ${script.name} script needs it.` });
    }
    try {
      await launches.start(project, script.name);
    } catch (e) {
      return send(res, 500, { error: `Couldn't start ${project.name}: ${e.message}` });
    }
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/dismiss') {
    const { projects } = await fullScan();
    const project = projects.find((p) => p.id === body.id);
    if (project) launches.dismiss(project.path);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/shutdown') {
    send(res, 200, { ok: true });
    setTimeout(() => {
      stopWorker();
      process.exit(0);
    }, 100);
    return;
  }

  if (url.pathname === '/api/open') {
    const target = await findDev(Number(body.pid));
    if (!target) return send(res, 404, { error: 'That server is gone. Refresh and try again.' });
    if (!target.repo) return send(res, 422, { error: 'No repo folder detected for this server.' });
    const dir = target.repo.path;
    if (!fs.existsSync(dir)) return send(res, 404, { error: `Folder not found: ${dir}` });
    if (body.with === 'editor') {
      if (!fs.existsSync(CODE_CMD)) return send(res, 404, { error: 'VS Code not found.' });
      detached('cmd.exe', ['/d', '/c', CODE_CMD, dir]);
    } else {
      detached('explorer.exe', [dir]);
    }
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'Misdirected request', 'text/plain');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return send(res, 500, { error: e.message || 'Scan failed' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`devport: port ${PORT} is taken. Set DEVPORT_PORT to use another.`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`devport on http://localhost:${PORT}  (projects root: ${PROJECTS_ROOT})`);
  pruneLogs();
  startTray();
});

// Tray icon (Windows only). tray.ps1 is single-instance via a named mutex,
// polls /api/summary and exits by itself when this server goes away.
function startTray() {
  if (process.platform !== 'win32' || process.env.DEVPORT_TRAY === '0') return;
  const script = path.join(__dirname, 'tray', 'tray.ps1');
  if (!fs.existsSync(script)) return;
  // Not detached: a detached (console-less) powershell.exe exits before running
  // the script. The tray outlives this server anyway and exits on its own.
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Port', String(PORT)],
    { stdio: 'ignore', windowsHide: true },
  );
  child.on('error', () => {});
  child.unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopWorker();
    process.exit(0);
  });
}
