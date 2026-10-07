'use strict';
// Starts a project's dev script in a hidden window and tracks it until it
// listens (shows up in a scan) or dies (its log tail becomes the error).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LOG_DIR = path.join(process.env.LOCALAPPDATA || require('node:os').tmpdir(), 'devport', 'logs');
const GIVE_UP_MS = 120000;

// Start-Process -WindowStyle Hidden keeps every child (npm, node, esbuild)
// windowless; a detached Node spawn would flash a console per child.
// Values arrive through env vars, so nothing is ever quoted into the script.
// The PID goes to a file, not stdout: Start-Process lets the child inherit
// handles, so a stdout pipe would stay open for the dev server's whole life.
const PS = `
$ErrorActionPreference = 'Stop'
$p = Start-Process -PassThru -WindowStyle Hidden -FilePath $env:ComSpec \`
  -ArgumentList ('/d /s /c "' + $env:DEVPORT_CMD + '"') -WorkingDirectory $env:DEVPORT_DIR \`
  -RedirectStandardOutput $env:DEVPORT_OUT -RedirectStandardError $env:DEVPORT_ERR
Set-Content -LiteralPath $env:DEVPORT_PIDFILE -Value $p.Id -NoNewline
`;

function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
}

function launch(project, scriptName) {
  const cmd = `${project.pm} run ${scriptName}`;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const base = path.join(LOG_DIR, `${slug(project.id)}-${Date.now()}`);
  const out = `${base}.out.log`;
  const err = `${base}.err.log`;
  const encoded = Buffer.from(PS, 'utf16le').toString('base64');
  const pidFile = `${base}.pid`;
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, DEVPORT_CMD: cmd, DEVPORT_DIR: project.path, DEVPORT_OUT: out, DEVPORT_ERR: err, DEVPORT_PIDFILE: pidFile },
    });
    const timer = setTimeout(() => ps.kill(), 20000);
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on('exit', () => {
      clearTimeout(timer);
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        fs.unlinkSync(pidFile);
      } catch {}
      if (!pid) return reject(new Error('Could not start the process.'));
      resolve({ pid, cmd, out, err });
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function tail(file, lines = 12) {
  try {
    const s = fs.readFileSync(file, 'utf8').replace(ANSI, '').replace(/\r/g, '');
    return s.split('\n').filter((l) => l.trim()).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Tracks launches by project path. update() is called with each scan:
 * a project whose repo now has a listening server is done; one whose
 * shell exited without listening has failed, with its log tail.
 */
class Launches {
  constructor() {
    this.byPath = new Map();
    // Root pid of each launch (the hidden cmd.exe) -> project. Lets a server
    // whose command line has no path ("node server.js") still be attributed.
    this.roots = new Map();
    // Last script started per project, so the row shows what's actually running.
    this.lastScript = new Map();
  }

  // Give repo-less dev servers the project of the launch they descend from.
  attribute(dev, parents) {
    for (const d of dev) {
      if (d.repo) continue;
      let pid = d.pid;
      for (let i = 0; i < 12 && pid; i++) {
        const project = this.roots.get(pid);
        if (project) {
          d.repo = { name: project.name, path: project.path, group: project.group };
          break;
        }
        pid = parents.get(pid);
      }
    }
  }

  key(p) {
    return path.resolve(p).toLowerCase();
  }

  get(projectPath) {
    return this.byPath.get(this.key(projectPath));
  }

  async start(project, scriptName) {
    const info = await launch(project, scriptName);
    const entry = { state: 'starting', script: scriptName, since: Date.now(), ...info };
    this.byPath.set(this.key(project.path), entry);
    this.lastScript.set(this.key(project.path), scriptName);
    this.roots.set(info.pid, { name: project.name, path: project.path, group: project.group });
    return entry;
  }

  update(runningPaths) {
    for (const pid of this.roots.keys()) if (!alive(pid)) this.roots.delete(pid);
    for (const [k, e] of this.byPath) {
      if (runningPaths.has(k)) {
        this.byPath.delete(k);
        continue;
      }
      if (e.state !== 'starting') {
        // Failures stay visible for 5 minutes, then clear.
        if (Date.now() - e.since > 300000) this.byPath.delete(k);
        continue;
      }
      const lines = [...tail(e.out), ...tail(e.err)];
      if (!alive(e.pid)) {
        e.state = 'failed';
        e.reason = 'exited';
        e.log = lines.slice(-14);
      } else if (Date.now() - e.since > GIVE_UP_MS) {
        e.state = 'failed';
        e.reason = 'timeout';
        e.log = lines.slice(-14);
      }
    }
  }

  dismiss(projectPath) {
    this.byPath.delete(this.key(projectPath));
  }
}

module.exports = { Launches, launch, tail, LOG_DIR };
