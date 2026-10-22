'use strict';

(async function () {
  const app = document.getElementById('app');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const theme = () => app.classList.toggle('dark', dark.matches);
  theme();
  dark.addEventListener('change', theme);

  const client = YTD.createClient();
  const $ = (id) => document.getElementById(id);

  // current tab: show the video panel if it is a YouTube video
  const [tab] = await (globalThis.browser || chrome).tabs.query({ active: true, currentWindow: true });
  const videoId = tab && tab.url ? YTD.videoIdOf(tab.url) : null;
  if (videoId) {
    YTD.mountVideo($('video'), client, { url: 'https://www.youtube.com/watch?v=' + videoId, videoId });
  } else {
    $('novideo').hidden = false;
  }

  const renderJobs = YTD.mountJobs($('jobs'), client, {
    filter: () => true,
    showTitle: true,
    empty: 'Пока ничего не скачано',
  });

  let updating = false;
  client.onState((st) => {
    renderJobs(st);
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
