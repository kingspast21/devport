'use strict';
// I/O side: reads listening TCP ports (netstat) and their processes (CIM via a
// long-lived PowerShell worker, so each scan skips PowerShell's ~1.5s startup).
const { execFile, spawn } = require('node:child_process');
const { classify } = require('./classify');

function run(file, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function listeners() {
  const out = await run('netstat.exe', ['-ano']);
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    const local = cols[1];
    const i = local.lastIndexOf(':');
    const addr = local.slice(0, i).replace(/^\[|\]$/g, '');
    const port = Number(local.slice(i + 1));
    const pid = Number(cols[4]);
    if (Number.isFinite(port) && Number.isFinite(pid)) rows.push({ addr, port, pid });
  }
  return rows;
}

// Reads one line of comma-separated PIDs, answers with one line of JSON.
const WORKER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq 'tree') {
    $pairs = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0}:{1}' -f $_.ProcessId, $_.ParentProcessId })
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject ($pairs -join ',') -Compress))
    [Console]::Out.Flush()
    continue
  }
  $ids = @($line -split ',' | Where-Object { $_ -match '^\\d+$' })
  $out = @()
  if ($ids.Count) {
    $f = 'ProcessId=' + ($ids -join ' OR ProcessId=')
    $out = @(Get-CimInstance Win32_Process -Filter $f | ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine
        start = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
        mem = [int64]$_.WorkingSetSize
      }
    })
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 3))
  [Console]::Out.Flush()
}
`;

class PsWorker {
  constructor() {
    this.proc = null;
    this.queue = [];
    this.buf = '';
  }

  ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    const encoded = Buffer.from(WORKER_SCRIPT, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        const job = this.queue.shift();
        if (!job) continue;
        clearTimeout(job.timer);
        try {
          job.resolve(JSON.parse(line || '[]'));
        } catch (e) {
          job.reject(e);
        }
      }
    });
    const fail = (err) => {
      if (this.proc !== proc) return;
      for (const job of this.queue.splice(0)) {
        clearTimeout(job.timer);
        job.reject(err);
      }
      this.proc = null;
    };
    proc.on('exit', () => fail(new Error('PowerShell worker exited')));
    proc.on('error', fail);
  }

  query(pids) {
    return this.send(pids.join(','));
  }

  send(line) {
    this.ensure();
    return new Promise((resolve, reject) => {
      const job = { resolve, reject };
      job.timer = setTimeout(() => {
        // A stuck worker would desync every later answer, so restart it.
        this.queue = this.queue.filter((j) => j !== job);
        this.stop();
        reject(new Error('PowerShell worker timed out'));
      }, 15000);
      this.queue.push(job);
      this.proc.stdin.write(line + '\n');
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new Error('PowerShell worker stopped'));
    }
    if (proc) {
      try {
        proc.kill();
      } catch {}
    }
  }
}

const worker = new PsWorker();

async function processes(pids) {
  const ids = [...new Set(pids)].filter((p) => p > 0);
  const map = new Map();
  if (!ids.length) return map;
  const parsed = await worker.query(ids);
  for (const p of Array.isArray(parsed) ? parsed : [parsed]) if (p) map.set(p.pid, p);
  return map;
}

// Scans are serialised: concurrent callers share the in-flight one.
let inflight = null;
function scan(opts) {
  if (inflight) return inflight;
  inflight = (async () => {
    const t0 = Date.now();
    const ls = await listeners();
    const procs = await processes(ls.map((l) => l.pid));
    const result = classify(ls, procs, opts);
    return { ...result, scannedAt: Date.now(), tookMs: Date.now() - t0 };
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function killTree(pid) {
  return run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
}

// pid -> parent pid for every process on the machine.
async function parentMap() {
  const s = await worker.send('tree');
  const map = new Map();
  for (const pair of String(s || '').split(',')) {
    const [pid, ppid] = pair.split(':').map(Number);
    if (pid) map.set(pid, ppid);
  }
  return map;
}

module.exports = { scan, killTree, listeners, processes, parentMap, stopWorker: () => worker.stop() };
