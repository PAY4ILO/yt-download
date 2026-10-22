// "Скачать" button in the watch page action bar + floating panel with the shared UI.
'use strict';

(function () {
  const B = typeof browser !== 'undefined' ? browser : chrome;
  let client = null;
  let btnHost = null;
  let panelHost = null;
  let panel = null; // {root, view, videoId}

  const isDark = () => document.documentElement.hasAttribute('dark');

  function getClient() {
    if (!client) client = YTD.createClient();
    return client;
  }

  // ---------- button ----------

  // Built from YouTube's own button classes (same as "Поделиться"), in the light DOM,
  // so the site's stylesheet draws it: size, tonal fill, hover, rim light, both themes.
  // Plain div wrappers on purpose: YouTube's custom element tags would get upgraded and emptied.
  const BTN_CLASSES = 'ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal ytSpecButtonShapeNextMono ytSpecButtonShapeNextSizeM'
    + ' ytSpecButtonShapeNextIconLeading ytSpecButtonShapeNextEnableBackdropFilterExperiment'
    + ' ytSpecButtonShapeNextMainstageIconSize ytSpecButtonShapeNextMainstagePadding';

  function makeButton() {
    const hostEl = document.createElement('ytd-dl-button');
    hostEl.style.cssText = 'display:inline-flex;flex:none;margin-left:8px;';
    hostEl.innerHTML = `
      <div class="ytSpecButtonViewModelHost">
        <button type="button" class="${BTN_CLASSES}" title="" aria-label="Скачать видео или звук" aria-haspopup="dialog" aria-expanded="false" aria-disabled="false">
          <div aria-hidden="true" class="ytSpecButtonShapeNextIcon ytSpecButtonShapeNextElevatedContent">
            <span class="ytIconWrapperHost" style="width: 24px; height: 24px;">
              <span class="yt-icon-shape ytSpecIconShapeHost">
                <div style="width: 100%; height: 100%; display: block; fill: currentcolor;">
                  <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true" style="pointer-events: none; display: inherit; width: 100%; height: 100%;"><path d="M12 2.5a1 1 0 0 1 1 1v10.09l3.8-3.8a1 1 0 1 1 1.4 1.42L12 17.4l-6.2-6.2a1 1 0 1 1 1.4-1.42L11 13.6V3.5a1 1 0 0 1 1-1ZM5 19.5h14a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2Z"></path></svg>
                </div>
              </span>
            </span>
          </div>
          <div class="ytSpecButtonShapeNextButtonTextContent ytSpecButtonShapeNextElevatedContent"><span class="ytd-dl-label" style="white-space: nowrap; font-variant-numeric: tabular-nums;">Скачать</span></div>
          <div aria-hidden="true" class="contribYtLightShapeHost contribYtLightShapeStaticRimLightTonal contribYtLightShapeStaticRimLight" style="--yt-light-wash-opacity: 0; --yt-light-wash-x: 0px; --yt-light-wash-y: 0px; --yt-light-wash-size: 0px;">
            <div class="contribYtLightShapeStaticWashLight contribYtLightShapeStaticWashLightTonal"></div>
          </div>
        </button>
      </div>`;
    hostEl.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      panel ? closePanel() : openPanel();
    });
    return hostEl;
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
    const b = btnHost && btnHost.querySelector('button');
    if (b) b.setAttribute('aria-expanded', String(v));
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
          .ytd { width: 360px; border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
                 max-height: calc(100vh - 16px); display: flex; flex-direction: column;
                 opacity: 0; transform: translateY(-4px); transition: opacity .14s, transform .14s; }
          .ytd.in { opacity: 1; transform: none; }
          .ytd > * { flex: none; }
          .ytd > .opts { flex: 1 1 auto; min-height: 80px; }
          .ytd > .jobs { max-height: 150px; overflow-y: auto; scrollbar-width: thin; }
          @media (prefers-reduced-motion: reduce) { .ytd { transition: none; } }
        </style>
        <div class="ytd" role="dialog" aria-label="Скачать"></div>`;
      document.documentElement.appendChild(panelHost);
    }
    const root = panelHost.shadowRoot.querySelector('.ytd');
    root.classList.toggle('dark', isDark());
    const url = 'https://www.youtube.com/watch?v=' + videoId;
    const view = YTD.mountVideo(root, getClient(), { url, videoId });
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
    const w = 360;
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

  // active download count on the button
  function watchCount() {
    getClient().onState((st) => {
      if (!btnHost) return;
      const vid = YTD.videoIdOf(location.href);
      // progress goes into the label itself, so the button stays a plain YouTube button
      const active = st.jobs.filter((j) => j.videoId === vid && (j.status === 'running' || j.status === 'queued'));
      const label = btnHost.querySelector('.ytd-dl-label');
      if (!active.length) label.textContent = 'Скачать';
      else {
        const pct = Math.floor(active.reduce((s, j) => s + (j.busy ? 100 : j.percent || 0), 0) / active.length);
        label.textContent = 'Скачать · ' + (pct ? pct + '%' : '…');
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
  const t = setInterval(() => { if (btnHost) { clearInterval(t); watchCount(); } }, 500);
})();
