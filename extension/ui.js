// Shared UI for the popup and the panel under the YouTube player.
'use strict';

var YTD = (function () {
  const B = typeof browser !== 'undefined' ? browser : chrome;

  // ---------- helpers ----------

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSize(b) {
    if (!b) return '';
    if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e10 ? 0 : 1).replace('.', ',') + ' ГБ';
    if (b >= 1e6) return Math.round(b / 1e6) + ' МБ';
    return Math.max(1, Math.round(b / 1e3)) + ' КБ';
  }

  function fmtSpeed(b) {
    if (!b) return '';
    if (b >= 1e6) return (b / 1e6).toFixed(1).replace('.', ',') + ' МБ/с';
    return Math.round(b / 1e3) + ' КБ/с';
  }

  function fmtTime(s) {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }

  // "1:20", "01:02:03", "95" -> seconds; null when it doesn't parse
  function parseTime(str) {
    const s = String(str || '').trim().replace(',', '.');
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (!m) return null;
    return (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  function fmtEta(s) {
    s = Math.round(s || 0);
    if (!s) return '';
    if (s < 60) return s + ' с';
    if (s < 3600) return Math.round(s / 60) + ' мин';
    return Math.floor(s / 3600) + ' ч ' + Math.round((s % 3600) / 60) + ' мин';
  }

  function videoIdOf(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)youtu\.be$/.test(u.hostname)) return u.pathname.slice(1, 12) || null;
      if (!/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) return null;
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{11})/);
      return m ? m[2] : null;
    } catch { return null; }
  }

  // playlist (also a video opened from a playlist) or a channel page -> URL the host can list
  function listUrlOf(url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
      const list = u.searchParams.get('list');
      // RD… are endless auto-mixes, not real playlists
      if (list && !/^RD/.test(list)) return 'https://www.youtube.com/playlist?list=' + list;
      const m = u.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
      return m ? 'https://www.youtube.com/' + m[1] + '/videos' : null;
    } catch { return null; }
  }

  function qualityTag(h) {
    if (h >= 4320) return '8K';
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K';
    if (h >= 1080) return 'Full HD';
    if (h >= 720) return 'HD';
    return '';
  }

  function shortPath(p) {
    if (!p) return '';
    const m = p.match(/^[A-Z]:\\Users\\[^\\]+\\(.*)$/i);
    return m ? m[1] : p;
  }

  const GIF_MAX = 30; // seconds; longer GIFs get huge

  const ICON = {
    video: '<svg viewBox="0 0 24 24"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9.2v5.6c0 .4.4.6.7.4l4.5-2.8a.5.5 0 0 0 0-.8l-4.5-2.8c-.3-.2-.7 0-.7.4Z" fill="currentColor"/></svg>',
    music: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6.5h11M4 11.5h11M4 16.5h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15.5 14.2v5.6c0 .4.4.6.7.4l4.2-2.8a.5.5 0 0 0 0-.8l-4.2-2.8c-.3-.2-.7 0-.7.4Z" fill="currentColor"/></svg>',
    cut: '<svg viewBox="0 0 24 24"><circle cx="6.5" cy="7" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="6.5" cy="17" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.7 8.4 20 17.5M8.7 15.6 20 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    now: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="m5 17.5 4.5-4.5 3 3 2.5-2.5 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.8v12.4c0 .8.9 1.3 1.5.8l9.3-6.2a1 1 0 0 0 0-1.6L9.5 5c-.6-.5-1.5 0-1.5.8Z" fill="currentColor"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.1-5M19 4.5V8h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5v5.5m0 3.2v.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  // ---------- connection to the background ----------

  function createClient() {
    const port = B.runtime.connect({ name: 'ui' });
    let rid = 0;
    const waiting = new Map();
    const listeners = new Set();
    let last = null;
    port.onMessage.addListener((m) => {
      if (m.type === 'state') {
        last = m.state;
        listeners.forEach((f) => f(last));
      } else if (m.type === 'reply' && waiting.has(m.rid)) {
        const { resolve, reject } = waiting.get(m.rid);
        waiting.delete(m.rid);
        m.error ? reject(new Error(m.error)) : resolve(m);
      }
    });
    port.postMessage({ type: 'hello' });
    return {
      call(type, data) {
        return new Promise((resolve, reject) => {
          const id = ++rid;
          waiting.set(id, { resolve, reject });
          port.postMessage({ type, rid: id, ...(data || {}) });
        });
      },
      onState(f) { listeners.add(f); if (last) f(last); return () => listeners.delete(f); },
      get state() { return last; },
      disconnect() { try { port.disconnect(); } catch {} },
    };
  }

  // ---------- job rows (keyed, so buttons survive progress updates) ----------

  const isActive = (j) => j.status === 'running' || j.status === 'queued';

  // a whole playlist download shows as one row
  function groupRow(items) {
    const first = items[items.length - 1]; // oldest = first in the playlist order
    const done = items.filter((j) => j.status === 'done').length;
    const failed = items.filter((j) => j.status === 'error' || j.status === 'cancelled').length;
    const active = items.filter(isActive);
    const running = active.filter((j) => j.status === 'running');
    const percent = (done + running.reduce((s, j) => s + (j.busy ? 1 : (j.percent || 0) / 100), 0)) / items.length * 100;
    return {
      id: 'g:' + first.group,
      group: first.group,
      isGroup: true,
      title: first.groupTitle,
      thumb: first.thumb,
      kind: first.kind,
      label: first.label,
      status: active.length ? 'running' : (failed ? 'error' : 'done'),
      percent,
      done, failed, total: items.length,
      file: (items.find((j) => j.file) || {}).file,
      error: failed ? `не скачалось: ${failed} из ${items.length}` : '',
    };
  }

  function jobStatusText(j) {
    if (j.isGroup) {
      if (j.status === 'running') return `скачано ${j.done} из ${j.total} · ${Math.floor(j.percent)}%`;
      if (j.status === 'done') return `Готово · ${j.total} видео`;
      return esc(j.error);
    }
    switch (j.status) {
      case 'queued': return 'В очереди';
      case 'running': {
        if (j.busy) return esc(j.phase) + '…';
        const bits = [Math.floor(j.percent || 0) + '%'];
        if (j.speed) bits.push(fmtSpeed(j.speed));
        if (j.eta) bits.push('осталось ' + fmtEta(j.eta));
        return (j.phase ? esc(j.phase) + ' · ' : '') + bits.join(' · ');
      }
      case 'done': return j.missing ? 'Файл удалён или перемещён' : 'Готово';
      case 'cancelled': return 'Отменено';
      case 'error': return esc(j.error || 'Ошибка');
    }
    return '';
  }

  function jobActions(j) {
    if (j.status === 'running' || j.status === 'queued') {
      return `<button class="ib" data-act="cancel" title="${j.isGroup ? 'Отменить весь плейлист' : 'Отменить'}">${ICON.x}</button>`;
    }
    if (j.isGroup) {
      return `${j.file ? `<button class="ib" data-act="reveal" title="Открыть папку">${ICON.folder}</button>` : ''}
        ${j.failed ? `<button class="ib" data-act="retry" title="Докачать то, что не скачалось">${ICON.retry}</button>` : ''}
        <button class="ib" data-act="remove" title="Убрать из списка">${ICON.x}</button>`;
    }
    if (j.status === 'done' && !j.missing) {
      return `<button class="ib" data-act="open" title="Открыть">${ICON.play}</button>
              <button class="ib" data-act="reveal" title="Показать в папке">${ICON.folder}</button>`;
    }
    return `<button class="ib" data-act="retry" title="Скачать снова">${ICON.retry}</button>
            <button class="ib" data-act="remove" title="Убрать из списка">${ICON.x}</button>`;
  }

  function mountJobs(el, client, { filter, showTitle, empty, groups }) {
    const rows = new Map(); // id -> {node, sig}
    let current = new Map(); // id -> row data
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const row = e.target.closest('[data-job]');
      if (!btn || !row) return;
      const job = current.get(row.dataset.job);
      if (!job) return;
      const act = btn.dataset.act;
      if (act === 'open' || act === 'reveal') client.call(act, { file: job.file });
      else if (job.isGroup) client.call(act + 'Group', { group: job.group });
      else client.call(act, { job: job.id });
    });

    return function render(st) {
      const jobs = (st.jobs || []).filter(filter);
      // collapse playlist items into one row per group, at the place of its newest item
      const list = [];
      const seenGroups = new Set();
      for (const j of jobs) {
        if (groups && j.group) {
          if (seenGroups.has(j.group)) continue;
          seenGroups.add(j.group);
          list.push(groupRow(jobs.filter((x) => x.group === j.group)));
        } else list.push(j);
      }
      current = new Map(list.map((j) => [j.id, j]));
      const seen = new Set();
      let prev = null;
      for (const j of list) {
        seen.add(j.id);
        let r = rows.get(j.id);
        const sig = j.status + '|' + !!j.missing + '|' + !!j.busy + '|' + (j.isGroup ? j.failed + '|' + !!j.file : '');
        if (!r) {
          const node = document.createElement('div');
          node.className = 'job';
          node.dataset.job = j.id;
          r = { node, sig: '' };
          rows.set(j.id, r);
        }
        if (r.sig !== sig) {
          r.sig = sig;
          r.node.dataset.status = j.status;
          const icon = j.kind === 'video' ? ICON.video : j.kind === 'gif' || j.kind === 'thumb' ? ICON.image : ICON.music;
          r.node.innerHTML = `
            ${showTitle && j.thumb ? `<div class="jthumbw">${j.isGroup ? `<span class="jstack">${ICON.list}</span>` : ''}<img class="jthumb" src="${esc(j.thumb)}" alt=""></div>` : `<div class="jicon">${j.isGroup ? ICON.list : icon}</div>`}
            <div class="jbody">
              ${showTitle || j.isGroup ? `<div class="jtitle" title="${esc(j.title)}">${esc(j.title)}</div>` : ''}
              <div class="jline"><span class="jlabel">${esc(j.label)}</span><span class="jstat"></span></div>
              <div class="bar"><i></i></div>
            </div>
            <div class="jact">${jobActions(j)}</div>`;
        }
        r.node.querySelector('.jstat').innerHTML = jobStatusText(j);
        r.node.querySelector('.jstat').title = j.status === 'error' ? (j.error || '') : (j.file || '');
        const bar = r.node.querySelector('.bar');
        bar.classList.toggle('busy', !!j.busy || (j.status === 'running' && !j.percent));
        bar.querySelector('i').style.width = (j.status === 'done' ? 100 : (j.percent || 0)) + '%';
        const want = prev ? prev.nextSibling : el.firstChild;
        if (want !== r.node) el.insertBefore(r.node, want);
        prev = r.node;
      }
      for (const [id, r] of rows) {
        if (!seen.has(id)) { r.node.remove(); rows.delete(id); }
      }
      let e = el.querySelector(':scope > .empty');
      if (!list.length && empty) {
        if (!e) { e = document.createElement('div'); e.className = 'empty'; e.textContent = empty; el.appendChild(e); }
      } else if (e) e.remove();
      el.hidden = !list.length && !empty;
    };
  }

  // ---------- playlist / channel ----------

  const LIST_QUALITY = [
    ['video:2160', 'Видео до 2160p (4K)'], ['video:1440', 'Видео до 1440p'], ['video:1080', 'Видео до 1080p'],
    ['video:720', 'Видео до 720p'], ['video:480', 'Видео до 480p'], ['video:360', 'Видео до 360p'],
    ['mp3:0', 'Только звук · MP3'], ['m4a:0', 'Только звук · M4A'], ['thumb:0', 'Только обложки · JPG'],
  ];

  function mountList(root, client, { url }) {
    let list = null;
    const sel = new Set();
    root.innerHTML = `
      <div class="lhead">
        <span class="licon">${ICON.list}</span>
        <div class="meta"><div class="title sk"></div><div class="chan sk"></div></div>
      </div>
      <div class="lbar" hidden>
        <label class="chk"><input type="checkbox" data-all><span>Все</span></label>
        <span class="lcount"></span>
      </div>
      <div class="litems"><div class="opt sk"></div><div class="opt sk"></div><div class="opt sk"></div></div>
      <div class="msg" hidden></div>
      <div class="lgo" hidden>
        <select class="sel" data-q>${LIST_QUALITY.map(([v, t]) => `<option value="${v}"${v === 'video:1080' ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <button class="primary" data-go>${ICON.down}<span>Скачать</span></button>
      </div>
      <div class="jobs mine"></div>`;
    const $ = (s) => root.querySelector(s);

    function counts() {
      if (!list) return;
      const avail = list.entries.filter((e) => !e.unavailable);
      const total = avail.filter((e) => sel.has(e.id));
      const dur = total.reduce((s, e) => s + (e.duration || 0), 0);
      $('.lcount').textContent = `выбрано ${total.length} из ${avail.length}` + (dur ? ` · ${fmtTime(dur)}` : '');
      const all = $('[data-all]');
      all.checked = total.length === avail.length && avail.length > 0;
      all.indeterminate = total.length > 0 && total.length < avail.length;
      const go = $('[data-go]');
      go.disabled = !total.length;
      go.querySelector('span').textContent = total.length ? `Скачать ${total.length}` : 'Скачать';
    }

    function render() {
      const t = $('.title'), c = $('.chan');
      t.classList.remove('sk'); c.classList.remove('sk');
      t.textContent = list.title; t.title = list.title;
      c.textContent = (list.isChannel ? 'Канал · ' : '') + `${list.entries.length} видео` + (list.channel && !list.isChannel ? ' · ' + list.channel : '');
      $('.lbar').hidden = false;
      $('.lgo').hidden = false;
      $('.litems').innerHTML = list.entries.map((e, i) => `
        <label class="litem${e.unavailable ? ' off' : ''}" title="${esc(e.title)}">
          <input type="checkbox" data-id="${esc(e.id)}"${sel.has(e.id) ? ' checked' : ''}${e.unavailable ? ' disabled' : ''}>
          <span class="ln">${i + 1}</span>
          <img loading="lazy" src="https://i.ytimg.com/vi/${esc(e.id)}/default.jpg" alt="">
          <span class="lt">${esc(e.title)}</span>
          <span class="ld">${e.duration ? fmtTime(e.duration) : ''}</span>
        </label>`).join('');
      counts();
    }

    root.addEventListener('change', (e) => {
      if (!list) return;
      if (e.target.matches('[data-all]')) {
        const on = e.target.checked;
        for (const en of list.entries) if (!en.unavailable) on ? sel.add(en.id) : sel.delete(en.id);
        root.querySelectorAll('.litem input[data-id]:not(:disabled)').forEach((c) => { c.checked = on; });
      } else if (e.target.matches('input[data-id]')) {
        e.target.checked ? sel.add(e.target.dataset.id) : sel.delete(e.target.dataset.id);
      }
      counts();
    });

    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-retry]')) { load(); return; }
      if (!e.target.closest('[data-go]') || !list) return;
      const [kind, h] = $('[data-q]').value.split(':');
      const label = kind === 'video' ? `до ${h}p · MP4` : kind === 'thumb' ? 'Обложка JPG' : kind.toUpperCase();
      const items = list.entries.map((en, i) => ({ ...en, index: i + 1 })).filter((en) => sel.has(en.id));
      if (!items.length) return;
      client.call('downloadList', { title: list.title, kind, height: Number(h), label, items, count: list.entries.length });
      const go = $('[data-go]');
      go.classList.add('pressed');
      setTimeout(() => go.classList.remove('pressed'), 400);
    });

    const renderJobs = mountJobs($('.jobs'), client, {
      filter: (j) => list && j.group && j.groupTitle === list.title,
      showTitle: false,
      groups: true,
    });
    const off = client.onState(renderJobs);

    async function load() {
      $('.msg').hidden = true;
      try {
        const r = await client.call('probeList', { url });
        list = r.list;
        // a playlist starts fully selected; a channel can have hundreds of videos, so it starts empty
        if (!list.isChannel) for (const e of list.entries) if (!e.unavailable) sel.add(e.id);
        render();
        if (client.state) renderJobs(client.state);
      } catch (e) {
        $('.litems').innerHTML = '';
        $('.msg').hidden = false;
        $('.msg').innerHTML = `<span class="mic">${ICON.alert}</span><div><div>${esc(e.message)}</div><button class="link" data-retry>Попробовать снова</button></div>`;
      }
    }
    load();
    return { destroy() { off(); root.innerHTML = ''; } };
  }

  // ---------- the video panel ----------

  function mountVideo(root, client, opts) {
    const url = opts.url;
    const videoId = opts.videoId;
    const listUrl = opts.listUrl || null;
    let info = null;
    let tab = 'video';
    let listView = null;
    const cut = { on: false, from: 0, to: 0 };

    root.innerHTML = `
      <div class="vview">
        <div class="head">
          <div class="thumb">
            <img alt=""><span class="dur"></span>
            <button class="cover" data-cover title="Скачать обложку в максимальном разрешении">${ICON.image}<span>Обложка</span></button>
          </div>
          <div class="meta"><div class="title sk"></div><div class="chan sk"></div></div>
        </div>
      </div>
      <div class="seg" role="tablist">
        <button data-tab="video" class="on">${ICON.video}<span>Видео</span></button>
        <button data-tab="audio">${ICON.music}<span>Звук</span></button>
        ${listUrl ? `<button data-tab="list">${ICON.list}<span>Плейлист</span></button>` : ''}
      </div>
      <div class="vview">
        <div class="cutrow">
          <button class="cuttoggle" data-cut aria-pressed="false">${ICON.cut}<span>Только фрагмент</span></button>
          <div class="cut" hidden>
            <label><span>с</span><input data-from inputmode="numeric" spellcheck="false"><button class="ib sm" data-now="from" title="Текущий момент видео">${ICON.now}</button></label>
            <span class="dash">—</span>
            <label><span>по</span><input data-to inputmode="numeric" spellcheck="false"><button class="ib sm" data-now="to" title="Текущий момент видео">${ICON.now}</button></label>
            <span class="cutlen"></span>
          </div>
        </div>
        <div class="opts"><div class="opt sk"></div><div class="opt sk"></div><div class="opt sk"></div></div>
        <div class="msg" hidden></div>
        <div class="jobs mine"></div>
      </div>
      <div class="lview" hidden></div>
      <div class="foot">
        <span class="fic">${ICON.folder}</span>
        <span class="dir" title=""></span>
        <button class="link" data-folder>Изменить</button>
      </div>`;

    const $ = (s) => root.querySelector(s);
    const optsEl = $('.opts');
    const msgEl = $('.msg');

    function showError(text, retry) {
      optsEl.innerHTML = '';
      msgEl.hidden = false;
      msgEl.innerHTML = `<span class="mic">${ICON.alert}</span><div><div>${esc(text)}</div>
        ${retry ? '<button class="link" data-retry>Попробовать снова</button>' : ''}</div>`;
    }

    function renderHead() {
      if (!info) return;
      $('.thumb img').src = info.thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      $('.dur').textContent = info.isLive ? 'LIVE' : fmtTime(info.duration);
      const t = $('.title'), c = $('.chan');
      t.classList.remove('sk'); c.classList.remove('sk');
      t.textContent = info.title; t.title = info.title;
      c.textContent = info.channel;
    }

    // ---- fragment ----

    function cutLen() { return cut.on ? cut.to - cut.from : 0; }

    function cutValid() {
      if (!cut.on) return true;
      return cut.from >= 0 && cut.to > cut.from && (!info || !info.duration || cut.to <= info.duration + 1);
    }

    function renderCut() {
      $('[data-cut]').setAttribute('aria-pressed', String(cut.on));
      $('[data-cut]').classList.toggle('on', cut.on);
      $('.cut').hidden = !cut.on;
      if (!cut.on) return;
      const from = $('[data-from]'), to = $('[data-to]');
      if (document.activeElement !== from && root.getRootNode().activeElement !== from) from.value = fmtTime(cut.from);
      if (document.activeElement !== to && root.getRootNode().activeElement !== to) to.value = fmtTime(cut.to);
      const ok = cutValid();
      $('.cut').classList.toggle('bad', !ok);
      $('.cutlen').textContent = ok ? fmtTime(cutLen()) : 'неверно';
    }

    async function currentTime() {
      try { const t = await opts.getTime(); return typeof t === 'number' && isFinite(t) ? Math.floor(t) : null; } catch { return null; }
    }

    async function toggleCut() {
      cut.on = !cut.on;
      if (cut.on) {
        const now = await currentTime();
        const max = info && info.duration ? info.duration : Infinity;
        cut.from = Math.min(now != null ? now : 0, Math.max(0, max - 1));
        cut.to = Math.min(cut.from + 15, max);
      }
      renderCut();
      renderOpts();
      if (cut.on) setTimeout(() => $('[data-from]').focus(), 0);
    }

    function readCutInput(which) {
      const v = parseTime($(which === 'from' ? '[data-from]' : '[data-to]').value);
      if (v == null) { $('.cut').classList.add('bad'); $('.cutlen').textContent = 'неверно'; return; }
      cut[which] = v;
      $('.cut').classList.toggle('bad', !cutValid());
      $('.cutlen').textContent = cutValid() ? fmtTime(cutLen()) : 'неверно';
      renderOpts();
    }

    // ---- options ----

    function renderOpts() {
      if (!info) return;
      msgEl.hidden = true;
      if (info.isLive) return showError('Это идёт прямо сейчас. Скачать трансляцию можно после её окончания.');
      const share = cut.on && info.duration ? Math.max(0, cutLen()) / info.duration : 1;
      const disabled = cutValid() ? '' : ' disabled';
      const size = (b) => (b ? '≈ ' + fmtSize(b * share) : '');
      if (tab === 'video') {
        if (!info.options.length) return showError('У этого видео нет видеодорожки.');
        let html = '';
        if (cut.on) {
          const long = cutLen() > GIF_MAX;
          html += `<button class="opt" data-gif${long || !cutValid() ? ' disabled' : ''} title="${long ? `GIF — не длиннее ${GIF_MAX} секунд` : 'Анимация 480px, 15 кадров/с'}">
            <span class="q">GIF</span><span class="sub">${long ? `до ${GIF_MAX} с` : '480p · без звука'}</span><span class="size"></span><span class="go">${ICON.down}</span></button>`;
        }
        html += info.options.map((o, i) => {
          const tag = qualityTag(o.height);
          return `<button class="opt" data-i="${i}"${disabled}>
            <span class="q">${o.height}p${o.fps ? `<sup>${o.fps}</sup>` : ''}</span>
            ${tag ? `<span class="tag${o.height >= 2160 ? ' hot' : ''}">${tag}</span>` : ''}
            ${o.hdr ? '<span class="tag">HDR</span>' : ''}
            <span class="size">${size(o.size)}</span>
            <span class="go">${ICON.down}</span>
          </button>`;
        }).join('');
        optsEl.innerHTML = html;
      } else {
        const mp3 = info.duration ? info.duration * 245000 / 8 : 0;
        optsEl.innerHTML = `
          <button class="opt" data-audio="mp3"${disabled}><span class="q">MP3</span><span class="sub">играет везде</span><span class="size">${size(mp3)}</span><span class="go">${ICON.down}</span></button>
          <button class="opt" data-audio="m4a"${disabled}><span class="q">M4A</span><span class="sub">${cut.on ? 'AAC 192 кбит/с' : 'оригинал, без перекодирования'}</span><span class="size">${size(info.audioSize)}</span><span class="go">${ICON.down}</span></button>`;
      }
    }

    function start(kind, height, label) {
      const section = cut.on && kind !== 'thumb' ? { start: cut.from, end: cut.to } : null;
      client.call('download', {
        url, videoId, kind, height, section,
        label: section ? `${label} · ${fmtTime(section.start)}–${fmtTime(section.end)}` : label,
        title: info ? info.title : '',
        thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      });
    }

    function setTab(t) {
      tab = t;
      root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      const list = t === 'list';
      root.querySelectorAll('.vview').forEach((v) => { v.hidden = list; });
      $('.lview').hidden = !list;
      if (list && !listView) listView = mountList($('.lview'), client, { url: listUrl });
      if (!list) renderOpts();
      if (opts.onResize) opts.onResize();
    }

    root.addEventListener('click', async (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
      if (e.target.closest('[data-cut]')) { toggleCut(); return; }
      const nowBtn = e.target.closest('[data-now]');
      if (nowBtn) {
        const t = await currentTime();
        if (t == null) return;
        cut[nowBtn.dataset.now] = t;
        if (nowBtn.dataset.now === 'from' && cut.to <= t) cut.to = Math.min(t + 15, info && info.duration ? info.duration : t + 15);
        renderCut(); renderOpts();
        return;
      }
      if (e.target.closest('[data-cover]')) {
        start('thumb', 0, 'Обложка JPG');
        const b = e.target.closest('[data-cover]');
        b.classList.add('pressed');
        setTimeout(() => b.classList.remove('pressed'), 400);
        return;
      }
      const opt = e.target.closest('.opt[data-i], .opt[data-audio], .opt[data-gif]');
      if (opt && info && !opt.disabled) {
        if (opt.hasAttribute('data-gif')) start('gif', 480, 'GIF');
        else if (opt.dataset.audio) start(opt.dataset.audio, 0, opt.dataset.audio.toUpperCase());
        else {
          const o = info.options[+opt.dataset.i];
          start('video', o.height, `${o.height}p${o.fps || ''} · MP4`);
        }
        opt.classList.add('pressed');
        setTimeout(() => opt.classList.remove('pressed'), 400);
        return;
      }
      if (e.target.closest('[data-folder]')) { client.call('pickFolder').catch(() => {}); return; }
      if (e.target.closest('[data-retry]')) { load(); return; }
      if (e.target.closest('[data-install]')) { client.call('reconnect').then(load).catch(() => {}); }
    });

    root.addEventListener('input', (e) => {
      if (e.target.matches('[data-from]')) readCutInput('from');
      else if (e.target.matches('[data-to]')) readCutInput('to');
    });
    root.addEventListener('focusout', (e) => { if (e.target.matches('[data-from], [data-to]')) renderCut(); });
    root.addEventListener('keydown', (e) => {
      // keep YouTube's single-key shortcuts (space, k, j, l, f…) out of the time fields
      if (e.target.matches('input')) e.stopPropagation();
    });

    const renderJobs = mountJobs($('.jobs.mine'), client, {
      filter: (j) => j.videoId === videoId && !j.group,
      showTitle: false,
    });

    const off = client.onState((st) => {
      renderJobs(st);
      const dir = st.settings.dir || st.host.defaultDir;
      $('.dir').textContent = shortPath(dir) || '…';
      $('.dir').title = dir || '';
      if (st.host.ok === false && !info) {
        optsEl.innerHTML = '';
        msgEl.hidden = false;
        msgEl.innerHTML = `<span class="mic">${ICON.alert}</span><div><div>${esc(st.host.error)}</div>
          <button class="link" data-install>Проверить ещё раз</button></div>`;
      }
    });

    async function load() {
      msgEl.hidden = true;
      optsEl.innerHTML = '<div class="opt sk"></div><div class="opt sk"></div><div class="opt sk"></div>';
      $('.thumb img').src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      try {
        const r = await client.call('probe', { url, videoId });
        info = r.info;
        renderHead();
        renderCut();
        renderOpts();
      } catch (e) {
        showError(e.message, true);
      }
    }
    load();
    if (opts.startTab) setTab(opts.startTab);

    return { destroy() { off(); if (listView) listView.destroy(); root.innerHTML = ''; } };
  }

  return { createClient, mountVideo, mountList, mountJobs, videoIdOf, listUrlOf, shortPath, fmtSize, esc, ICON };
})();
