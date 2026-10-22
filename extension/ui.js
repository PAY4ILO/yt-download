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
    if (!s) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
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

  const ICON = {
    video: '<svg viewBox="0 0 24 24"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9.2v5.6c0 .4.4.6.7.4l4.5-2.8a.5.5 0 0 0 0-.8l-4.5-2.8c-.3-.2-.7 0-.7.4Z" fill="currentColor"/></svg>',
    music: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.8v12.4c0 .8.9 1.3 1.5.8l9.3-6.2a1 1 0 0 0 0-1.6L9.5 5c-.6-.5-1.5 0-1.5.8Z" fill="currentColor"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.1-5M19 4.5V8h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5.5 12.5 4 4 9-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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

  function jobStatusText(j) {
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
      return `<button class="ib" data-act="cancel" title="Отменить">${ICON.x}</button>`;
    }
    if (j.status === 'done' && !j.missing) {
      return `<button class="ib" data-act="open" title="Открыть">${ICON.play}</button>
              <button class="ib" data-act="reveal" title="Показать в папке">${ICON.folder}</button>`;
    }
    return `<button class="ib" data-act="retry" title="Скачать снова">${ICON.retry}</button>
            <button class="ib" data-act="remove" title="Убрать из списка">${ICON.x}</button>`;
  }

  function mountJobs(el, client, { filter, showTitle, empty }) {
    const rows = new Map(); // id -> {node, sig}
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const row = e.target.closest('[data-job]');
      if (!btn || !row) return;
      const job = (client.state.jobs || []).find((j) => j.id === row.dataset.job);
      if (!job) return;
      const act = btn.dataset.act;
      if (act === 'open' || act === 'reveal') client.call(act, { file: job.file });
      else client.call(act, { job: job.id });
    });

    return function render(st) {
      const jobs = (st.jobs || []).filter(filter);
      const seen = new Set();
      let prev = null;
      for (const j of jobs) {
        seen.add(j.id);
        let r = rows.get(j.id);
        const sig = j.status + '|' + !!j.missing + '|' + !!j.busy;
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
          r.node.innerHTML = `
            ${showTitle && j.thumb ? `<img class="jthumb" src="${esc(j.thumb)}" alt="">` : `<div class="jicon">${j.kind === 'video' ? ICON.video : ICON.music}</div>`}
            <div class="jbody">
              ${showTitle ? `<div class="jtitle" title="${esc(j.title)}">${esc(j.title)}</div>` : ''}
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
        // keep DOM order = list order
        const want = prev ? prev.nextSibling : el.firstChild;
        if (want !== r.node) el.insertBefore(r.node, want);
        prev = r.node;
      }
      for (const [id, r] of rows) {
        if (!seen.has(id)) { r.node.remove(); rows.delete(id); }
      }
      let e = el.querySelector(':scope > .empty');
      if (!jobs.length && empty) {
        if (!e) { e = document.createElement('div'); e.className = 'empty'; e.textContent = empty; el.appendChild(e); }
      } else if (e) e.remove();
      el.hidden = !jobs.length && !empty;
    };
  }

  // ---------- the video panel ----------

  function mountVideo(root, client, opts) {
    const url = opts.url;
    const videoId = opts.videoId;
    let info = null;
    let tab = 'video';

    root.innerHTML = `
      <div class="head">
        <div class="thumb"><img alt=""><span class="dur"></span></div>
        <div class="meta"><div class="title sk"></div><div class="chan sk"></div></div>
      </div>
      <div class="seg" role="tablist">
        <button data-tab="video" class="on">${ICON.video}<span>Видео</span></button>
        <button data-tab="audio">${ICON.music}<span>Только звук</span></button>
      </div>
      <div class="opts"><div class="opt sk"></div><div class="opt sk"></div><div class="opt sk"></div></div>
      <div class="msg" hidden></div>
      <div class="jobs mine"></div>
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
      const img = $('.thumb img');
      img.src = info.thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      $('.dur').textContent = info.isLive ? 'LIVE' : fmtTime(info.duration);
      const t = $('.title'), c = $('.chan');
      t.classList.remove('sk'); c.classList.remove('sk');
      t.textContent = info.title; t.title = info.title;
      c.textContent = info.channel;
    }

    function renderOpts() {
      if (!info) return;
      msgEl.hidden = true;
      if (info.isLive) return showError('Это идёт прямо сейчас. Скачать трансляцию можно после её окончания.');
      if (tab === 'video') {
        if (!info.options.length) return showError('У этого видео нет видеодорожки.');
        optsEl.innerHTML = info.options.map((o, i) => {
          const tag = qualityTag(o.height);
          return `<button class="opt" data-i="${i}">
            <span class="q">${o.height}p${o.fps ? `<sup>${o.fps}</sup>` : ''}</span>
            ${tag ? `<span class="tag${o.height >= 2160 ? ' hot' : ''}">${tag}</span>` : ''}
            ${o.hdr ? '<span class="tag">HDR</span>' : ''}
            <span class="size">${o.size ? '≈ ' + fmtSize(o.size) : ''}</span>
            <span class="go">${ICON.down}</span>
          </button>`;
        }).join('');
      } else {
        const mp3 = info.duration ? info.duration * 245000 / 8 : 0;
        optsEl.innerHTML = `
          <button class="opt" data-audio="mp3"><span class="q">MP3</span><span class="sub">играет везде</span><span class="size">${mp3 ? '≈ ' + fmtSize(mp3) : ''}</span><span class="go">${ICON.down}</span></button>
          <button class="opt" data-audio="m4a"><span class="q">M4A</span><span class="sub">оригинал, без перекодирования</span><span class="size">${info.audioSize ? '≈ ' + fmtSize(info.audioSize) : ''}</span><span class="go">${ICON.down}</span></button>`;
      }
    }

    function start(kind, height, label) {
      client.call('download', {
        url, videoId, kind, height, label,
        title: info.title,
        thumb: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      });
    }

    root.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        tab = tabBtn.dataset.tab;
        root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === tabBtn));
        renderOpts();
        return;
      }
      const opt = e.target.closest('.opt[data-i], .opt[data-audio]');
      if (opt && info) {
        if (opt.dataset.audio) start(opt.dataset.audio, 0, opt.dataset.audio.toUpperCase());
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

    const renderJobs = mountJobs($('.jobs'), client, {
      filter: (j) => j.videoId === videoId,
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
      // the thumbnail is known before yt-dlp answers
      $('.thumb img').src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      try {
        const r = await client.call('probe', { url, videoId });
        info = r.info;
        renderHead();
        renderOpts();
      } catch (e) {
        showError(e.message, true);
      }
    }
    load();

    return { destroy() { off(); root.innerHTML = ''; } };
  }

  return { createClient, mountVideo, mountJobs, videoIdOf, shortPath, fmtSize, esc, ICON };
})();
