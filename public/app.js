'use strict';
(() => {
  const CYCLE_MS = 3000;
  const ARM_MS = 3000;
  const $ = (id) => document.getElementById(id);
  const els = {
    servers: $('servers'), empty: $('empty'), summary: $('summary'), meta: $('scanMeta'),
    killAll: $('killAll'), notice: $('notice'), otherRows: $('otherRows'), otherCount: $('otherCount'),
    pulse: $('pulseBar'), mark: document.querySelector('.mark'), tpl: $('rowTpl'),
  };
  const rows = new Map(); // pid -> li
  let firstRender = true;
  let timer = null;
  let noticeTimer = null;

  // Formatting
  const fmtUptime = (start) => {
    if (!start) return '?';
    const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  };
  const fmtMem = (b) => (!b ? '?' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
  const BIND = { local: 'localhost', 'ipv6-only': 'IPv6 only', all: 'LAN visible' };
  const STALE_MS = 8 * 3600 * 1000;

  function notice(msg, ok = false) {
    clearTimeout(noticeTimer);
    els.notice.textContent = msg;
    els.notice.classList.toggle('ok', ok);
    els.notice.hidden = !msg;
    if (msg) noticeTimer = setTimeout(() => (els.notice.hidden = true), ok ? 3500 : 7000);
  }

  async function post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Devport': '1' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  // Two-step destructive buttons: first click arms, second click within ARM_MS fires.
  function armable(btn, label, armedLabel, fire) {
    let armed = null;
    const text = btn.querySelector('span');
    btn.addEventListener('click', async () => {
      if (!armed) {
        btn.classList.add('is-arming');
        text.textContent = armedLabel;
        armed = setTimeout(() => {
          armed = null;
          btn.classList.remove('is-arming');
          text.textContent = label;
        }, ARM_MS);
        return;
      }
      clearTimeout(armed);
      armed = null;
      btn.classList.remove('is-arming');
      btn.classList.add('is-busy');
      text.textContent = 'Stopping…';
      try {
        await fire();
      } catch (e) {
        notice(e.message);
      } finally {
        btn.classList.remove('is-busy');
        text.textContent = label;
      }
    });
    btn.addEventListener('blur', () => {
      if (!armed) return;
      clearTimeout(armed);
      armed = null;
      btn.classList.remove('is-arming');
      text.textContent = label;
    });
  }

  function buildRow(d) {
    const li = els.tpl.content.firstElementChild.cloneNode(true);
    li.dataset.pid = d.pid;
    const q = (s) => li.querySelector(s);
    armable(q('.act-kill'), 'Stop', 'Confirm', async () => {
      await post('/api/kill', { pid: d.pid });
      removeRow(d.pid);
      notice(`Stopped ${li.dataset.label}.`, true);
      schedule(400);
    });
    q('.act-folder').addEventListener('click', () => post('/api/open', { pid: d.pid, with: 'folder' }).catch((e) => notice(e.message)));
    q('.act-editor').addEventListener('click', () => post('/api/open', { pid: d.pid, with: 'editor' }).catch((e) => notice(e.message)));
    return li;
  }

  function fillRow(li, d) {
    const q = (s) => li.querySelector(s);
    const href = `http://localhost:${d.port}/`;
    const portEl = q('.port');
    portEl.textContent = d.port;
    portEl.href = href;
    portEl.setAttribute('aria-label', `Open localhost:${d.port}`);
    q('.act-open').href = href;
    q('.extra-ports').textContent = d.ports.length > 1 ? `+ ${d.ports.slice(1).join(', ')}` : '';

    const name = q('.repo-name');
    name.textContent = d.repo ? d.repo.name : 'Unknown repo';
    name.classList.toggle('is-unknown', !d.repo);
    name.title = d.repo ? d.repo.path : 'No project path in the command line';
    const tag = q('.tag');
    tag.className = 'tag';
    tag.textContent = '';
    if (d.repo && d.repo.group === 'work') { tag.textContent = 'work'; tag.classList.add('work'); }
    if (d.repo && d.repo.group === 'other') { tag.textContent = 'outside projects'; tag.classList.add('other'); }

    q('.stack').textContent = d.stack;
    q('.pid').textContent = `pid ${d.pid}`;
    const bind = q('.bind');
    bind.textContent = BIND[d.binding] || d.binding;
    bind.classList.toggle('warn', d.binding === 'all');
    bind.title = d.binding === 'all' ? 'Reachable from other devices on your network' : d.binding === 'ipv6-only' ? 'Listening on ::1 only. Use localhost, not 127.0.0.1' : '';
    q('.cmd').textContent = d.display || d.cmd;
    q('.cmd').title = d.cmd;

    const up = q('.uptime');
    up.textContent = fmtUptime(d.start);
    const stale = d.start && Date.now() - d.start > STALE_MS;
    up.classList.toggle('stale', !!stale);
    up.title = stale ? 'Running for over 8 hours. Forgotten?' : '';
    q('.mem').textContent = fmtMem(d.mem);

    const noRepo = !d.repo;
    for (const b of [q('.act-folder'), q('.act-editor')]) b.disabled = noRepo;
    li.dataset.label = `${d.repo ? d.repo.name : 'the server'} on :${d.port}`;
  }

  function removeRow(pid) {
    const li = rows.get(pid);
    if (!li) return;
    rows.delete(pid);
    li.classList.add('is-leaving');
    li.addEventListener('animationend', () => li.remove(), { once: true });
    setTimeout(() => li.remove(), 600);
  }

  function renderDev(dev) {
    const seen = new Set();
    let prev = null;
    for (const d of dev) {
      seen.add(d.pid);
      let li = rows.get(d.pid);
      if (!li) {
        li = buildRow(d);
        rows.set(d.pid, li);
        if (!firstRender) li.classList.add('is-new');
      }
      fillRow(li, d);
      const want = prev ? prev.nextSibling : els.servers.firstChild;
      if (li !== want) els.servers.insertBefore(li, want);
      prev = li;
    }
    for (const pid of [...rows.keys()]) if (!seen.has(pid)) removeRow(pid);

    const n = dev.length;
    els.empty.hidden = n > 0;
    els.killAll.hidden = n < 2;
    els.mark.classList.toggle('is-live', n > 0);
    const totalMem = dev.reduce((a, d) => a + (d.mem || 0), 0);
    els.summary.innerHTML = '';
    if (!n) {
      els.summary.textContent = 'No dev servers running';
    } else {
      const strong = document.createElement('strong');
      strong.textContent = `${n} dev server${n === 1 ? '' : 's'}`;
      els.summary.append(strong, ` running, using ${fmtMem(totalMem)}`);
    }
    document.title = n ? `(${n}) devport` : 'devport';
  }

  // ---- Projects -------------------------------------------------------
  const proj = {
    section: $('projects'), list: $('projList'), count: $('projCount'), filter: $('projFilter'),
    empty: $('projEmpty'), tpl: $('projTpl'), rows: new Map(), data: [],
  };
  proj.filter.value = localStorage.getItem('devport.filter') || '';
  proj.filter.addEventListener('input', () => {
    localStorage.setItem('devport.filter', proj.filter.value);
    renderProjects(proj.data);
  });

  function svgIcon(id) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ico');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', `#${id}`);
    s.append(u);
    return s;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function scriptLabel(p, s) {
    return `${p.pm} run ${s.name}`;
  }

  function buildProject(p) {
    const li = proj.tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = p.id;
    li.querySelector('.pn').textContent = p.name;
    const tag = li.querySelector('.tag');
    if (p.group === 'work') {
      tag.textContent = 'work';
      tag.classList.add('work');
    }
    const box = li.querySelector('.proj-script');
    if (p.scripts.length > 1) {
      const sel = el('select', 'script-select');
      sel.setAttribute('aria-label', `Script for ${p.name}`);
      for (const s of p.scripts) {
        const o = el('option', null, scriptLabel(p, s));
        o.value = s.name;
        sel.append(o);
      }
      box.append(sel);
    } else {
      box.append(el('span', 'script-one', scriptLabel(p, p.scripts[0])));
    }
    box.append(el('span', 'script-port'));
    const sel = box.querySelector('select');
    if (sel) sel.addEventListener('change', () => updatePortHint(li, p));
    li.querySelector('.act-dismiss').addEventListener('click', () =>
      post('/api/dismiss', { id: p.id }).then(() => schedule(0), (e) => notice(e.message)),
    );
    return li;
  }

  function selectedScript(li, p) {
    const sel = li.querySelector('select');
    return p.scripts.find((s) => s.name === (sel ? sel.value : p.scripts[0].name)) || p.scripts[0];
  }

  function updatePortHint(li, p) {
    const s = selectedScript(li, p);
    li.querySelector('.script-port').textContent = s.port ? `:${s.port}` : '';
  }

  async function startProject(li, p, btn) {
    btn.classList.add('is-busy');
    btn.querySelector('span').textContent = 'Starting…';
    try {
      await post('/api/start', { id: p.id, script: selectedScript(li, p).name });
      schedule(300);
    } catch (e) {
      notice(e.message);
      btn.classList.remove('is-busy');
      btn.querySelector('span').textContent = 'Start';
    }
  }

  function stateOf(p) {
    if (p.running.length) return 'running';
    if (p.launch) return p.launch.state; // starting | failed
    if (!p.installed) return 'uninstalled';
    return 'idle';
  }

  function fillProject(li, p) {
    li.querySelector('.proj-stack').textContent = p.stack;
    updatePortHint(li, p);
    const state = stateOf(p);
    const sig = `${state}|${p.running.map((r) => r.port).join(',')}|${p.launch ? p.launch.since : ''}`;
    li.dataset.state = state;
    const box = li.querySelector('.proj-state');
    if (state === 'starting') {
      // Live elapsed counter, no rebuild.
      const t = box.querySelector('.elapsed');
      if (t) t.textContent = `${Math.max(0, Math.round((Date.now() - p.launch.since) / 1000))}s`;
    }
    if (li.dataset.sig === sig) return;
    li.dataset.sig = sig;
    box.replaceChildren();
    const fail = li.querySelector('.proj-fail');
    fail.hidden = state !== 'failed';
    const sel = li.querySelector('select');
    if (sel) {
      sel.disabled = state === 'running' || state === 'starting';
      if (p.lastScript && p.scripts.some((s) => s.name === p.lastScript)) sel.value = p.lastScript;
      updatePortHint(li, p);
    }

    if (state === 'running') {
      const r = p.running[0];
      const a = el('a', 'run-link');
      a.href = `http://localhost:${r.port}/`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.append(el('span', 'dot'), el('span', null, `Running on :${r.port}`));
      box.append(a);
    } else if (state === 'starting') {
      const s = el('span', 'starting');
      s.append(el('span', 'dot pulse-dot'), el('span', null, 'Starting '), el('span', 'elapsed', `${Math.max(0, Math.round((Date.now() - p.launch.since) / 1000))}s`));
      box.append(s);
    } else if (state === 'uninstalled') {
      box.append(el('span', 'muted-note', `Run ${p.pm} install first`));
    } else {
      const btn = el('button', 'btn btn-go');
      btn.type = 'button';
      btn.append(svgIcon('i-play'), el('span', null, state === 'failed' ? 'Retry' : 'Start'));
      btn.addEventListener('click', () => startProject(li, p, btn));
      box.append(btn);
      if (state === 'failed') {
        const l = p.launch;
        li.querySelector('.fail-msg').textContent =
          l.reason === 'timeout'
            ? `${scriptLabel(p, { name: l.script })} is still running but nothing has started listening after 2 minutes. If it isn't a server, stop it from Task Manager.`
            : `${scriptLabel(p, { name: l.script })} exited before it started listening.`;
        const log = li.querySelector('.fail-log');
        log.textContent = (l.log && l.log.length ? l.log.join('\n') : 'No output.') + (l.logFile ? `\n\nFull log: ${l.logFile}` : '');
      }
    }
  }

  function renderProjects(projects) {
    proj.data = projects;
    proj.section.hidden = projects.length === 0;
    const q = proj.filter.value.trim().toLowerCase();
    const seen = new Set();
    let prev = null;
    let shown = 0;
    for (const p of projects) {
      seen.add(p.id);
      let li = proj.rows.get(p.id);
      if (!li) {
        li = buildProject(p);
        proj.rows.set(p.id, li);
      }
      fillProject(li, p);
      const match = !q || p.name.toLowerCase().includes(q) || p.stack.toLowerCase().includes(q) || (q === 'work' && p.group === 'work');
      li.hidden = !match;
      if (match) shown++;
      const want = prev ? prev.nextSibling : proj.list.firstChild;
      if (li !== want) proj.list.insertBefore(li, want);
      prev = li;
    }
    for (const [id, li] of proj.rows) {
      if (!seen.has(id)) {
        li.remove();
        proj.rows.delete(id);
      }
    }
    proj.count.textContent = q ? `${shown} of ${projects.length}` : projects.length;
    proj.empty.hidden = shown > 0 || !projects.length;
    proj.empty.textContent = `No projects match “${proj.filter.value.trim()}”.`;
  }

  function renderOther(other) {
    els.otherCount.textContent = other.length;
    const frag = document.createDocumentFragment();
    for (const o of other) {
      const tr = document.createElement('tr');
      const cell = (text, cls) => {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.append(td);
        return td;
      };
      cell(o.ports.join(', '), 'num');
      cell(o.label);
      const kindTd = cell('');
      const k = document.createElement('span');
      k.className = `kind ${o.kind}`;
      k.textContent = { tooling: 'tooling', self: 'this app', system: 'system', app: 'app' }[o.kind];
      kindTd.append(k);
      cell(o.pid, 'mono');
      cell(BIND[o.binding] || o.binding, 'mono');
      frag.append(tr);
    }
    els.otherRows.replaceChildren(frag);
  }

  function restartPulse(ms) {
    els.pulse.classList.remove('run');
    void els.pulse.offsetWidth;
    els.pulse.style.setProperty('--cycle', `${ms}ms`);
    els.pulse.classList.add('run');
  }

  async function tick() {
    timer = null;
    try {
      const r = await fetch('/api/scan', { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Scan failed');
      renderDev(data.dev);
      renderProjects(data.projects || []);
      renderOther(data.other);
      els.meta.textContent = `scan ${data.tookMs} ms`;
      firstRender = false;
    } catch (e) {
      els.summary.textContent = 'Lost contact with the devport server';
      els.meta.textContent = '';
      els.mark.classList.remove('is-live');
    }
    schedule(CYCLE_MS);
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(tick, ms);
    restartPulse(ms);
  }

  armable(els.killAll, 'Stop all', 'Confirm stop all', async () => {
    const r = await post('/api/kill-all');
    for (const pid of r.killed) removeRow(pid);
    notice(`Stopped ${r.killed.length} server${r.killed.length === 1 ? '' : 's'}.`, true);
    schedule(400);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else schedule(0);
  });

  tick();
})();
