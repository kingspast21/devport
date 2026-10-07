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
const { scan, killTree, stopWorker } = require('./lib/scan');

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

// Re-scan right before acting, so a PID recycled since the page loaded can't be hit.
async function findDev(pid) {
  const { dev } = await scan(OPTS);
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
    return send(res, 200, { ...(await scan(OPTS)), projectsRoot: PROJECTS_ROOT });
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
    const { dev } = await scan(OPTS);
    const killed = [];
    for (const d of dev) {
      await killTree(d.pid).then(() => killed.push(d.pid), () => {});
    }
    return send(res, 200, { ok: true, killed });
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

server.listen(PORT, HOST, () => console.log(`devport on http://localhost:${PORT}  (projects root: ${PROJECTS_ROOT})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopWorker();
    process.exit(0);
  });
}
