'use strict';
// Pure classification: turns raw listener + process data into dashboard entries.
// No I/O here, so it is unit-testable (see test/classify.test.js).

const DEV_RUNTIMES = new Set(['node', 'python', 'python3', 'pythonw', 'php', 'bun', 'deno', 'ruby']);

// Processes that run on a dev runtime but are tooling, not your dev servers.
// Killing these would take down Hermes, editor extensions or MCP servers.
// Matched against the arguments only, never the executable: the node/python on
// PATH may itself live inside a tool's folder (Hermes ships its own runtimes).
const TOOLING = [
  [/\\appdata\\local\\hermes\\|hermes_cli|hermes\.exe/i, 'Hermes'],
  [/\\\.vscode\\extensions\\/i, 'VS Code extension'],
  [/\\\.cursor\\extensions\\/i, 'Cursor extension'],
  [/\\\.gemini\\/i, 'Antigravity'],
  [/@modelcontextprotocol|mcp-server|[\\/ -]mcp\b/i, 'MCP server'],
];

// Order matters: frameworks before the bundler they wrap.
const STACKS = [
  [/node_modules[\\/]next[\\/]|\bnext(\.cmd)?\s+(dev|start)\b/i, 'Next.js'],
  [/node_modules[\\/]nuxi?[\\/]|\bnuxi?\s+dev\b/i, 'Nuxt'],
  [/node_modules[\\/]astro[\\/]|\bastro\s+dev\b/i, 'Astro'],
  [/node_modules[\\/]@remix-run[\\/]/i, 'Remix'],
  [/node_modules[\\/]@angular[\\/]cli|\bng\s+serve\b/i, 'Angular'],
  [/node_modules[\\/]vite[\\/]|\bvite(\.js|\.cmd)?\b/i, 'Vite'],
  [/webpack-dev-server|webpack[\\/]bin.*serve/i, 'Webpack'],
  [/react-scripts/i, 'CRA'],
  [/wrangler/i, 'Wrangler'],
  [/netlify-cli|\bnetlify\s+dev\b/i, 'Netlify Dev'],
  [/json-server/i, 'json-server'],
  [/live-server/i, 'live-server'],
  [/http-server/i, 'http-server'],
  [/node_modules[\\/]serve[\\/]|\bserve(\.cmd)?\s/i, 'serve'],
  [/nodemon/i, 'nodemon'],
  [/\btsx\b|ts-node/i, 'tsx'],
  [/-m\s+http\.server/i, 'http.server'],
  [/uvicorn/i, 'Uvicorn'],
  [/\bflask\b/i, 'Flask'],
  [/manage\.py\s+runserver/i, 'Django'],
  [/\bartisan\b/i, 'Laravel'],
  [/php(\.exe)?"?\s+-S\s/i, 'PHP server'],
  [/\brails\b|\bpuma\b/i, 'Rails'],
];

function runtimeOf(name) {
  return String(name || '').toLowerCase().replace(/\.exe$/, '');
}

function detectStack(cmd, runtime) {
  for (const [re, label] of STACKS) if (re.test(cmd || '')) return label;
  return runtime || 'unknown';
}

// Command line minus its first token (the executable, quoted or not).
function argsOf(cmd) {
  const s = String(cmd || '').trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end === -1 ? '' : s.slice(end + 1);
  }
  const sp = s.search(/\s/);
  return sp === -1 ? '' : s.slice(sp);
}

function toolingOf(cmd) {
  const args = argsOf(cmd);
  for (const [re, label] of TOOLING) if (re.test(args)) return label;
  return null;
}

// Find the repo a command line belongs to.
// 1. Anything under the projects root: projects\<name> or projects\work\<name>.
// 2. Otherwise the folder that holds node_modules.
function detectRepo(cmd, projectsRoot) {
  if (!cmd) return null;
  const norm = cmd.replace(/\//g, '\\');
  const lower = norm.toLowerCase();
  const root = projectsRoot.replace(/\//g, '\\').replace(/\\+$/, '');
  const at = lower.indexOf(root.toLowerCase() + '\\');
  if (at !== -1) {
    const rest = norm.slice(at + root.length + 1);
    const segs = splitSegments(rest);
    if (segs.length) {
      const isWork = segs[0].toLowerCase() === 'work' && segs.length > 1;
      const name = isWork ? segs[1] : segs[0];
      const rel = isWork ? `${segs[0]}\\${segs[1]}` : segs[0];
      return { name, path: `${norm.slice(at, at + root.length)}\\${rel}`, group: isWork ? 'work' : 'personal' };
    }
  }
  const nm = lower.indexOf('\\node_modules\\');
  if (nm !== -1) {
    const before = norm.slice(0, nm);
    const start = Math.max(before.lastIndexOf('"') + 1, before.search(/[A-Za-z]:\\[^"]*$/));
    const dir = before.slice(start);
    if (/^[A-Za-z]:\\/.test(dir)) {
      return { name: dir.split('\\').pop(), path: dir, group: 'other' };
    }
  }
  return null;
}

// Path segments after the projects root, stopping at a quote or the end of the path.
function splitSegments(rest) {
  const q = rest.indexOf('"');
  let s = q === -1 ? rest : rest.slice(0, q);
  const out = [];
  for (let i = 0; i < 2; i++) {
    const slash = s.indexOf('\\');
    if (slash === -1) {
      // Last segment with no backslash after it: unquoted, so it ends at whitespace.
      const seg = s.split(/\s/)[0];
      if (seg) out.push(seg);
      break;
    }
    out.push(s.slice(0, slash));
    s = s.slice(slash + 1);
    if (s.toLowerCase().startsWith('node_modules')) break;
  }
  return out.filter(Boolean);
}

const SYSTEM = new Set(['system', 'svchost', 'lsass', 'wininit', 'services', 'spoolsv', 'csrss', 'smss', 'winlogon']);

// What ran, minus the runtime path, with the repo folder shortened to ".".
function displayCmd(cmd, repo, runtime) {
  let s = argsOf(cmd).trim().replace(/"/g, '');
  if (repo && repo.path) {
    const esc = repo.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '[\\\\/]');
    s = s.replace(new RegExp(esc, 'gi'), '.');
  }
  return `${runtime} ${s}`.trim();
}

function bindingOf(addrs) {
  const any = addrs.some((a) => a === '0.0.0.0' || a === '::');
  if (any) return 'all';
  const v4 = addrs.includes('127.0.0.1');
  const v6 = addrs.includes('::1');
  if (v6 && !v4) return 'ipv6-only';
  return 'local';
}

/**
 * @param {Array<{port:number,addr:string,pid:number}>} listeners
 * @param {Map<number, {pid,ppid,name,cmd,start,mem}>} procs
 * @param {{projectsRoot:string, selfPid:number}} opts
 */
function classify(listeners, procs, opts) {
  const byPid = new Map();
  for (const l of listeners) {
    if (!byPid.has(l.pid)) byPid.set(l.pid, { ports: new Set(), addrs: new Set() });
    const e = byPid.get(l.pid);
    e.ports.add(l.port);
    e.addrs.add(l.addr);
  }

  const dev = [];
  const other = [];
  for (const [pid, { ports, addrs }] of byPid) {
    const p = procs.get(pid) || { pid, name: pid === 4 ? 'System' : '?', cmd: '' };
    const runtime = runtimeOf(p.name);
    const portList = [...ports].sort((a, b) => a - b);
    const addrList = [...addrs];
    const base = {
      pid,
      ppid: p.ppid || 0,
      ports: portList,
      port: portList[0],
      binding: bindingOf(addrList),
      name: p.name,
      runtime,
      cmd: p.cmd || '',
      start: p.start || 0,
      mem: p.mem || 0,
    };
    if (pid === opts.selfPid) {
      other.push({ ...base, kind: 'self', label: 'devport (this dashboard)', killable: false });
      continue;
    }
    const tooling = toolingOf(p.cmd);
    if (DEV_RUNTIMES.has(runtime) && !tooling) {
      const repo = detectRepo(p.cmd, opts.projectsRoot);
      dev.push({ ...base, kind: 'dev', stack: detectStack(p.cmd, runtime), repo, display: displayCmd(p.cmd, repo, runtime), killable: true });
    } else {
      other.push({
        ...base,
        kind: tooling ? 'tooling' : SYSTEM.has(runtime) || pid <= 4 ? 'system' : 'app',
        label: tooling || p.name.replace(/\.exe$/i, ''),
        killable: false,
      });
    }
  }
  dev.sort((a, b) => a.port - b.port);
  other.sort((a, b) => a.port - b.port);
  return { dev, other };
}

module.exports = { classify, detectRepo, detectStack, toolingOf, runtimeOf, bindingOf, DEV_RUNTIMES };
