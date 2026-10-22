// "Скачать" button in the watch page action bar + floating panel with the shared UI.
'use strict';

(function () {
  const B = typeof browser !== 'undefined' ? browser : chrome;
  let client = null;
  let btnHost = null;
  let panelHost = null;
  let panel = null; // {root, view, videoId}
  let quick = '';   // settings.quick: one click downloads this quality

  const isDark = () => document.documentElement.hasAttribute('dark');
  const player = () => document.querySelector('#movie_player video, video.html5-main-video');
  const QUICK_TEXT = { v2160: '4K', v1440: '1440p', v1080: '1080p', v720: '720p', v480: '480p', mp3: 'MP3', m4a: 'M4A' };

  function getClient() {
    if (!client) client = YTD.createClient();
    return client;
  }

  function pageTitle() {
    const h = document.querySelector('ytd-watch-metadata h1');
    return (h && h.textContent.trim()) || document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
  }

  // ---------- button ----------

  // Built from YouTube's own button classes (same as "Поделиться"), in the light DOM,
  // so the site's stylesheet draws it: size, tonal fill, hover, rim light, both themes.
  // Plain div wrappers on purpose: YouTube's custom element tags would get upgraded and emptied.
  const BASE = 'ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal ytSpecButtonShapeNextMono ytSpecButtonShapeNextSizeM'
    + ' ytSpecButtonShapeNextEnableBackdropFilterExperiment ytSpecButtonShapeNextMainstageIconSize ytSpecButtonShapeNextMainstagePadding';
  // With a favourite quality the button splits like Like|Dislike: [⤓ Скачать 1080p | ▾]
  const MAIN_CLASSES = BASE + ' ytSpecButtonShapeNextIconLeading';
  const ARROW_CLASSES = BASE + ' ytSpecButtonShapeNextIconButton ytSpecButtonShapeNextSegmentedEnd';

  const RIM = `<div aria-hidden="true" class="contribYtLightShapeHost contribYtLightShapeStaticRimLightTonal contribYtLightShapeStaticRimLight" style="--yt-light-wash-opacity: 0; --yt-light-wash-x: 0px; --yt-light-wash-y: 0px; --yt-light-wash-size: 0px;"><div class="contribYtLightShapeStaticWashLight contribYtLightShapeStaticWashLightTonal"></div></div>`;
  const icon = (d) => `
    <div aria-hidden="true" class="ytSpecButtonShapeNextIcon ytSpecButtonShapeNextElevatedContent">
      <span class="ytIconWrapperHost" style="width: 24px; height: 24px;">
        <span class="yt-icon-shape ytSpecIconShapeHost">
          <div style="width: 100%; height: 100%; display: block; fill: currentcolor;">
            <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true" style="pointer-events: none; display: inherit; width: 100%; height: 100%;"><path d="${d}"></path></svg>
          </div>
        </span>
      </span>
    </div>`;
  const DOWN = 'M12 2.5a1 1 0 0 1 1 1v10.09l3.8-3.8a1 1 0 1 1 1.4 1.42L12 17.4l-6.2-6.2a1 1 0 1 1 1.4-1.42L11 13.6V3.5a1 1 0 0 1 1-1ZM5 19.5h14a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2Z';
  const CHEVRON = 'M6.3 9.3a1 1 0 0 1 1.4 0L12 13.6l4.3-4.3a1 1 0 1 1 1.4 1.4L12 16.4l-5.7-5.7a1 1 0 0 1 0-1.4Z';

  function makeButton() {
    const hostEl = document.createElement('ytd-dl-button');
    hostEl.style.cssText = 'display:inline-flex;flex:none;margin-left:8px;';
    hostEl.innerHTML = `
      <div class="ytSpecButtonViewModelHost" style="display:flex">
        <button type="button" data-main class="${MAIN_CLASSES}" title="" aria-label="Скачать видео или звук" aria-haspopup="dialog" aria-expanded="false" aria-disabled="false">
          ${icon(DOWN)}
          <div class="ytSpecButtonShapeNextButtonTextContent ytSpecButtonShapeNextElevatedContent"><span class="ytd-dl-label" style="white-space: nowrap; font-variant-numeric: tabular-nums;">Скачать</span></div>
          ${RIM}
        </button>
        <button type="button" data-arrow hidden class="${ARROW_CLASSES}" title="Выбрать качество, фрагмент, обложку" aria-label="Выбрать качество" aria-haspopup="dialog" aria-expanded="false" style="margin-left:1px">
          ${icon(CHEVRON)}
          ${RIM}
        </button>
      </div>`;
    hostEl.querySelector('[data-main]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (quick) quickDownload();
      else panel ? closePanel() : openPanel();
    });
    hostEl.querySelector('[data-arrow]').addEventListener('click', (e) => {
      e.stopPropagation();
      panel ? closePanel() : openPanel();
    });
    applyQuick();
    return hostEl;
  }

  function applyQuick() {
    if (!btnHost) return;
    const main = btnHost.querySelector('[data-main]');
    const arrow = btnHost.querySelector('[data-arrow]');
    main.classList.toggle('ytSpecButtonShapeNextSegmentedStart', !!quick);
    arrow.hidden = !quick;
    main.title = quick ? `Скачать в ${QUICK_TEXT[quick]} одним кликом (Alt+Shift+D)` : '';
  }

  async function quickDownload() {
    const videoId = YTD.videoIdOf(location.href);
    try {
      const r = await getClient().call('quick', { videoId, title: pageTitle() });
      toast(r.dup ? 'Это уже скачивается' : `Скачиваю: ${r.label}`);
    } catch (e) {
      toast(e.message);
    }
  }

  function actionBar() {
    // Like/Share row under the player (new and old layouts)
    return document.querySelector('ytd-watch-metadata #top-level-buttons-computed')
      || document.querySelector('ytd-watch-metadata #actions-inner #menu ytd-menu-renderer')
      || document.querySelector('#info #menu-container ytd-menu-renderer');
  }

  function ensureButton() {
    if (!YTD.videoIdOf(location.href) || location.pathname !== '/watch') {
      if (btnHost) { btnHost.remove(); btnHost = null; }
      return;
    }
    const bar = actionBar();
    if (!bar) return;
    if (btnHost && btnHost.isConnected && btnHost.parentNode === bar) return;
    if (!btnHost) btnHost = makeButton();
    bar.appendChild(btnHost);
  }

  function setExpanded(v) {
    if (!btnHost) return;
    btnHost.querySelectorAll('button').forEach((b) => b.setAttribute('aria-expanded', String(v)));
  }

  // ---------- toast (like YouTube's own, bottom left) ----------

  let toastHost = null, toastTimer = null;
  function toast(text) {
    if (!toastHost) {
      toastHost = document.createElement('ytd-dl-toast');
      const sh = toastHost.attachShadow({ mode: 'open' });
      sh.innerHTML = `<style>
        div { position: fixed; left: 24px; bottom: 24px; z-index: 2400; max-width: 420px; padding: 14px 18px;
              border-radius: 8px; background: #f1f1f1; color: #0f0f0f; font: 400 14px/20px Roboto, Arial, sans-serif;
              box-shadow: 0 4px 16px rgba(0,0,0,.3); opacity: 0; transform: translateY(8px); transition: opacity .18s, transform .18s; pointer-events: none; }
        div.dark { background: #f1f1f1; color: #0f0f0f; }
        div.light { background: #212121; color: #fff; }
        div.in { opacity: 1; transform: none; }
      </style><div role="status"></div>`;
      document.documentElement.appendChild(toastHost);
    }
    const el = toastHost.shadowRoot.querySelector('div');
    el.className = isDark() ? 'dark' : 'light';
    el.textContent = text;
    requestAnimationFrame(() => el.classList.add('in'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('in'), 3000);
  }

  // ---------- panel ----------

  function openPanel() {
    const videoId = YTD.videoIdOf(location.href);
    if (!videoId || !btnHost) return;
    if (!panelHost) {
      panelHost = document.createElement('ytd-dl-panel');
      panelHost.style.cssText = 'position:fixed;z-index:2300;top:0;left:0;';
      const sh = panelHost.attachShadow({ mode: 'open' });
      sh.innerHTML = `<link rel="stylesheet" href="${B.runtime.getURL('ui.css')}">
        <style>
          .ytd { width: 380px; border-radius: 12px; box-shadow: var(--shadow); overflow-x: hidden; overflow-y: auto;
                 max-height: calc(100vh - 16px); overscroll-behavior: contain; scrollbar-width: thin;
                 opacity: 0; transform: translateY(-4px); transition: opacity .14s, transform .14s; }
          .ytd.in { opacity: 1; transform: none; }
          .ytd .jobs.mine { max-height: 150px; overflow-y: auto; scrollbar-width: thin; }
          @media (prefers-reduced-motion: reduce) { .ytd { transition: none; } }
        </style>
        <div class="ytd" role="dialog" aria-label="Скачать"></div>`;
      document.documentElement.appendChild(panelHost);
    }
    const root = panelHost.shadowRoot.querySelector('.ytd');
    root.classList.toggle('dark', isDark());
    const url = 'https://www.youtube.com/watch?v=' + videoId;
    const listUrl = new URL(location.href).searchParams.get('list') ? YTD.listUrlOf(location.href) : null;
    const view = YTD.mountVideo(root, getClient(), {
      url, videoId, listUrl,
      getTime: () => { const v = player(); return v ? v.currentTime : null; },
      onResize: () => requestAnimationFrame(place),
    });
    panel = { root, view, videoId };
    panelHost.style.display = '';
    place();
    requestAnimationFrame(() => root.classList.add('in'));
    setExpanded(true);
  }

  function closePanel() {
    if (!panel) return;
    panel.view.destroy();
    panel.root.classList.remove('in');
    panelHost.style.display = 'none';
    panel = null;
    setExpanded(false);
  }

  function place() {
    if (!panel || !btnHost) return;
    const r = btnHost.getBoundingClientRect();
    if (!r.width) return closePanel();
    const w = 380;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    let top = r.bottom + 8;
    const h = panel.root.offsetHeight || 420;
    if (top + h > window.innerHeight - 8) {
      // below doesn't fit: above if it fits there, otherwise pinned to the bottom edge
      top = r.top - h - 8 > 8 ? r.top - h - 8 : Math.max(8, window.innerHeight - 8 - h);
    }
    panelHost.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // close on outside click / Esc; follow the button on scroll
  document.addEventListener('click', (e) => {
    if (!panel) return;
    const path = e.composedPath();
    if (path.includes(panelHost) || path.includes(btnHost)) return;
    closePanel();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel) closePanel(); }, true);
  window.addEventListener('scroll', () => panel && place(), { passive: true });
  window.addEventListener('resize', () => panel && place());

  // messages from the popup (current time for the fragment) and the hotkey
  B.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'ytd-time') { const v = player(); sendResponse(v ? v.currentTime : null); }
    else if (m.type === 'ytd-open') { if (!panel) openPanel(); }
    else if (m.type === 'ytd-toast') toast(m.text);
  });

  // progress in the label, favourite quality, split button
  function watchState() {
    getClient().onState((st) => {
      if (quick !== (st.settings.quick || '')) { quick = st.settings.quick || ''; applyQuick(); }
      if (!btnHost) return;
      const vid = YTD.videoIdOf(location.href);
      // progress goes into the label itself, so the button stays a plain YouTube button
      const active = st.jobs.filter((j) => j.videoId === vid && (j.status === 'running' || j.status === 'queued'));
      const label = btnHost.querySelector('.ytd-dl-label');
      const base = quick ? 'Скачать ' + QUICK_TEXT[quick] : 'Скачать';
      if (!active.length) label.textContent = base;
      else {
        const pct = Math.floor(active.reduce((s, j) => s + (j.busy ? 100 : j.percent || 0), 0) / active.length);
        label.textContent = 'Скачиваю · ' + (pct ? pct + '%' : '…');
      }
      if (panel) place();
    });
  }

  // ---------- SPA navigation ----------

  function onNavigate() {
    if (panel && panel.videoId !== YTD.videoIdOf(location.href)) closePanel();
    ensureButton();
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  // the action bar is rendered late and re-rendered on navigation
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; ensureButton(); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  onNavigate();
  // Connect lazily: only once a watch page shows the button.
  const t = setInterval(() => { if (btnHost) { clearInterval(t); watchState(); } }, 500);
})();
