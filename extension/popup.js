'use strict';

(async function () {
  const app = document.getElementById('app');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const theme = () => app.classList.toggle('dark', dark.matches);
  theme();
  dark.addEventListener('change', theme);

  const client = YTD.createClient();
  const $ = (id) => document.getElementById(id);

  const api = globalThis.browser || chrome;

  // current tab: a video gets the video panel (with a playlist tab when opened from one),
  // a playlist or channel page gets the playlist picker
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const videoId = tab && tab.url ? YTD.videoIdOf(tab.url) : null;
  const listUrl = tab && tab.url ? YTD.listUrlOf(tab.url) : null;
  if (videoId) {
    YTD.mountVideo($('video'), client, {
      url: 'https://www.youtube.com/watch?v=' + videoId,
      videoId,
      listUrl: listUrl && new URL(tab.url).searchParams.get('list') ? listUrl : null,
      // the player lives in the page: ask the content script
      getTime: () => api.tabs.sendMessage(tab.id, { type: 'ytd-time' }),
    });
  } else if (listUrl) {
    YTD.mountList($('list'), client, { url: listUrl });
  } else {
    $('novideo').hidden = false;
  }

  $('quick').addEventListener('change', (e) => client.call('setSetting', { key: 'quick', value: e.target.value }));
  $('keys').addEventListener('click', () => {
    // Edge/Chrome have a shortcuts page; Firefox manages them in about:addons
    const firefox = typeof browser !== 'undefined' && /Firefox/.test(navigator.userAgent);
    const url = firefox ? 'about:addons' : (/Edg\//.test(navigator.userAgent) ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts');
    api.tabs.create({ url }).catch(() => {});
  });
  if (api.commands && api.commands.getAll) {
    api.commands.getAll().then((cmds) => {
      const c = cmds.find((x) => x.name === 'quick-download');
      $('keys').textContent = c && c.shortcut ? c.shortcut.replace(/\s/g, '') : 'клавиша не задана';
    }).catch(() => {});
  }

  const renderJobs = YTD.mountJobs($('jobs'), client, {
    filter: () => true,
    showTitle: true,
    groups: true,
    empty: 'Пока ничего не скачано',
  });

  let updating = false;
  client.onState((st) => {
    renderJobs(st);
    if (document.activeElement !== $('quick')) $('quick').value = st.settings.quick || '';
    $('clear').hidden = !st.jobs.some((j) => j.status !== 'running' && j.status !== 'queued');
    const dir = st.settings.dir || st.host.defaultDir;
    $('dir').textContent = YTD.shortPath(dir) || '—';
    $('dir').title = dir || '';
    $('reset').hidden = !st.settings.dir;
    if (!updating) {
      $('ver').textContent = st.host.ok ? (st.host.ytdlp || '?') : (st.host.ok === false ? 'помощник не найден' : '…');
      $('ver').title = st.host.ok === false ? st.host.error : '';
    }
    $('update').disabled = updating || st.host.ok !== true;

    const u = st.update;
    const busy = st.jobs.some((j) => j.status === 'running' || j.status === 'queued');
    $('extrow').classList.toggle('has', !!u.available);
    if (u.busy === 'apply') $('extver').textContent = 'обновляю…';
    else if (u.busy === 'check') $('extver').textContent = u.current + ' · проверяю…';
    else if (u.error) $('extver').textContent = u.current + ' · ' + u.error;
    else if (u.available) $('extver').textContent = u.current + ' → ' + u.latest;
    else $('extver').textContent = u.current + (u.checkedAt ? ' · последняя' : '');
    $('extver').title = u.error || '';
    $('extcheck').hidden = !!u.available;
    $('extcheck').disabled = !!u.busy || st.host.ok !== true;
    $('extapply').hidden = !u.available;
    $('extapply').textContent = 'Обновить';
    $('extapply').disabled = !!u.busy || busy;
    $('extapply').title = busy ? 'Дождись окончания загрузок' : 'Скачать версию ' + u.latest + ' с GitHub';
  });

  $('extcheck').addEventListener('click', () => client.call('checkUpdate').catch(() => {}));
  $('extapply').addEventListener('click', () => client.call('applyUpdate').catch(() => {}));

  $('clear').addEventListener('click', () => client.call('clear'));
  $('pick').addEventListener('click', () => client.call('pickFolder').catch(() => {}));
  $('reset').addEventListener('click', () => client.call('resetFolder'));
  $('update').addEventListener('click', async () => {
    updating = true;
    $('update').disabled = true;
    $('ver').textContent = 'обновляю…';
    try {
      await client.call('update');
      setTimeout(() => { updating = false; client.call('reconnect').catch(() => {}); }, 26000);
    } catch (e) {
      updating = false;
      $('ver').textContent = e.message;
    }
  });
})();
