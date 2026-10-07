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
