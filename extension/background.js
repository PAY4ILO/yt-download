// Owns the native port, the download list and settings. UIs (popup, in-page panel)
// connect with runtime.connect({name: 'ui'}) and get the whole state on every change.
'use strict';

// Firefox has api.*, Edge/Chrome have chrome.* (promise-based in MV3)
const api = globalThis.browser || globalThis.chrome;

const HOST = 'yt_download_host';
const MAX_JOBS = 300;   // playlists add many rows at once
const PARALLEL = 2;     // downloads running at the same time, the rest wait in the queue
const listCache = new Map(); // playlist url -> {at, list}

let port = null;
let reqSeq = 0;
const pending = new Map();     // request id -> {resolve, reject}
const probeCache = new Map();  // videoId -> {at, info}
const uis = new Set();

const state = {
  jobs: [],                    // newest first
  // quick: what one click on the page button downloads ('' = open the panel), e.g. 'v1080', 'mp3'
  settings: { dir: '', quick: '' },
  host: { ok: null, error: '', ytdlp: '', defaultDir: '', cookies: false },
  // extension self-update from GitHub (see update.json next to install.ps1)
  update: { current: api.runtime.getManifest().version, latest: '', available: false, checkedAt: 0, busy: '', error: '' },
};

const UPDATE_EVERY = 6 * 60 * 60 * 1000;

async function checkUpdate(force) {
  if (!force && Date.now() - state.update.checkedAt < UPDATE_EVERY) return;
  state.update = { ...state.update, busy: 'check', error: '' };
  changed(false);
  try {
    const r = await request('checkUpdate');
    state.update = { ...state.update, latest: r.latest, available: r.available, checkedAt: Date.now(), busy: '' };
  } catch (e) {
    state.update = { ...state.update, busy: '', error: e.message, checkedAt: force ? 0 : Date.now() };
  }
  api.storage.local.set({ update: { latest: state.update.latest, checkedAt: state.update.checkedAt } });
  changed(false);
}

const ready = (async () => {
  const s = await api.storage.local.get(['jobs', 'settings', 'update']);
  state.settings = { dir: '', quick: '', ...(s.settings || {}) };
  if (s.update) {
    const latest = s.update.latest || '';
    // after an update the cached "latest" may equal the new current version
    state.update = { ...state.update, latest, checkedAt: s.update.checkedAt || 0, available: !!latest && latest !== state.update.current && isNewer(latest, state.update.current) };
  }
  state.jobs = (s.jobs || []).map((j) =>
    j.status === 'running' || j.status === 'queued'
      ? { ...j, status: 'error', error: 'Загрузка прервалась: браузер был закрыт.' }
      : j);
})();

function isNewer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// ---------- native host ----------

function connect() {
  if (port) return port;
  port = api.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener((p) => {
    const err = (p.error && p.error.message) || (api.runtime.lastError && api.runtime.lastError.message) || '';
    port = null;
    const missing = /No such native application|not found|does not exist|Unable to start/i.test(err);
    state.host = {
      ...state.host,
      ok: false,
      error: missing
        ? 'Браузер не нашёл помощника. Запусти install.cmd из папки yt-download и полностью перезапусти браузер. (' + err + ')'
        : 'Помощник закрылся' + (err ? ': ' + err : '.'),
    };
    for (const { reject } of pending.values()) reject(new Error(state.host.error));
    pending.clear();
    for (const j of state.jobs) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'error';
        j.error = state.host.error;
      }
    }
    changed(true);
  });
  return port;
}

function request(cmd, data = {}) {
  return new Promise((resolve, reject) => {
    const id = 'r' + (++reqSeq);
    pending.set(id, { resolve, reject });
    try {
      connect().postMessage({ id, cmd, ...data });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

function onHostMessage(msg) {
  if (pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok === false) reject(new Error(msg.error || 'Ошибка помощника'));
    else resolve(msg);
    return;
  }
  const job = state.jobs.find((j) => j.id === msg.id);
  if (!job || !msg.ev) return;
  switch (msg.ev) {
    case 'progress':
      job.status = 'running';
      job.percent = msg.percent;
      job.phase = msg.phase;
      job.speed = msg.speed || 0;
      job.eta = msg.eta || 0;
      job.busy = !!msg.busy;
      changed(false);
      break;
    case 'done':
      Object.assign(job, { status: 'done', percent: 100, file: msg.file, finishedAt: Date.now(), busy: false });
      changed(true);
      notify(job);
      pump();
      break;
    case 'error':
      Object.assign(job, { status: 'error', error: msg.message, busy: false });
      changed(true);
      notify(job);
      pump();
      break;
    case 'cancelled':
      Object.assign(job, { status: 'cancelled', busy: false });
      changed(true);
      pump();
      break;
  }
}

async function hello() {
  try {
    const r = await request('hello');
    state.host = { ok: true, error: '', ytdlp: r.ytdlp, defaultDir: r.defaultDir, cookies: r.cookies };
  } catch (e) {
    state.host = { ...state.host, ok: false, error: state.host.error || e.message };
  }
  changed(true);
}

// ---------- state broadcast ----------

let saveTimer = null;
let pushTimer = null;

function changed(persist) {
  if (persist) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.storage.local.set({ jobs: state.jobs.slice(0, MAX_JOBS), settings: state.settings });
    }, 200);
  }
  updateBadge();
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const msg = { type: 'state', state };
    for (const p of uis) { try { p.postMessage(msg); } catch {} }
  }, 60);
}

function updateBadge() {
  const active = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  api.action.setBadgeText({ text: active ? String(active) : '' });
  api.action.setBadgeBackgroundColor({ color: '#cc0000' });
}

const isActive = (j) => j.status === 'running' || j.status === 'queued';

// One notification per finished video; a playlist notifies once, when its last item ends.
function notify(job) {
  let title, message;
  if (job.group) {
    const items = state.jobs.filter((j) => j.group === job.group);
    if (items.some(isActive)) return;
    const ok = items.filter((j) => j.status === 'done').length;
    title = ok === items.length ? 'Плейлист скачан' : `Плейлист: скачано ${ok} из ${items.length}`;
    message = job.groupTitle;
  } else if (job.status === 'done') {
    title = 'Скачано';
    message = job.title + '\n' + job.label;
  } else return;
  api.notifications.create('done:' + job.id, {
    type: 'basic',
    iconUrl: api.runtime.getURL('icons/icon96.png'),
    title,
    message,
  }).catch(() => {});
}

api.notifications.onClicked.addListener((nid) => {
  const job = state.jobs.find((j) => 'done:' + j.id === nid);
  const file = job && (job.file || (state.jobs.find((j) => j.group && j.group === job.group && j.file) || {}).file);
  if (file) request('reveal', { file }).catch(() => {});
});

// ---------- actions from UIs ----------

async function probe(url, videoId) {
  const hit = probeCache.get(videoId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.info;
  const r = await request('probe', { url });
  probeCache.set(videoId, { at: Date.now(), info: r.info });
  if (state.host.ok !== true) hello();
  return r.info;
}

const sectionKey = (s) => (s ? s.start + '-' + s.end : '');

function startJob(m) {
  const dup = state.jobs.find((j) => j.videoId === m.videoId && j.kind === m.kind && (j.height || 0) === (m.height || 0)
    && sectionKey(j.section) === sectionKey(m.section) && isActive(j));
  if (dup) return null;
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    id,
    url: m.url,
    videoId: m.videoId,
    title: m.title || m.videoId,
    thumb: m.thumb || `https://i.ytimg.com/vi/${m.videoId}/mqdefault.jpg`,
    kind: m.kind,
    height: m.height || 0,
    label: m.label,
    section: m.section || null,
    group: m.group || '',
    groupTitle: m.groupTitle || '',
    index: m.index || 0,
    count: m.count || 0,
    status: 'queued',
    sent: false,
    percent: 0,
    phase: 'В очереди',
    startedAt: Date.now(),
  };
  state.jobs.unshift(job);
  trimJobs();
  changed(true);
  pump();
  return job;
}

// drop the oldest finished rows, never active ones
function trimJobs() {
  if (state.jobs.length <= MAX_JOBS) return;
  let extra = state.jobs.length - MAX_JOBS;
  for (let i = state.jobs.length - 1; i >= 0 && extra > 0; i--) {
    if (!isActive(state.jobs[i])) { state.jobs.splice(i, 1); extra--; }
  }
}

// Send queued jobs to the host, oldest first, at most PARALLEL at a time.
function pump() {
  let running = state.jobs.filter((j) => isActive(j) && j.sent).length;
  for (let i = state.jobs.length - 1; i >= 0 && running < PARALLEL; i--) {
    const job = state.jobs[i];
    if (job.status !== 'queued' || job.sent) continue;
    job.sent = true;
    running++;
    try {
      connect().postMessage({
        id: job.id, cmd: 'download', url: job.url, videoId: job.videoId, kind: job.kind, height: job.height,
        title: job.title, section: job.section, dir: state.settings.dir || '',
        subdir: job.group ? job.groupTitle : '', index: job.index, count: job.count,
      });
    } catch (e) {
      Object.assign(job, { status: 'error', error: e.message });
    }
  }
  changed(false);
}

async function cancelJobs(list) {
  for (const j of list) {
    if (!isActive(j)) continue;
    if (!j.sent) { j.status = 'cancelled'; continue; }
    await request('cancel', { job: j.id }).catch(() => {});
  }
  changed(true);
  pump();
}

function restartJob(j) {
  state.jobs = state.jobs.filter((x) => x !== j);
  startJob(j);
}

// ---------- one-click download / hotkey ----------

const QUICK = {
  v2160: { kind: 'video', height: 2160 },
  v1440: { kind: 'video', height: 1440 },
  v1080: { kind: 'video', height: 1080 },
  v720: { kind: 'video', height: 720 },
  v480: { kind: 'video', height: 480 },
  mp3: { kind: 'mp3', height: 0 },
  m4a: { kind: 'm4a', height: 0 },
};

function quickLabel(q) {
  const o = QUICK[q];
  if (!o) return '';
  return o.kind === 'video' ? `до ${o.height}p · MP4` : o.kind.toUpperCase();
}

function startQuick(videoId, title) {
  const o = QUICK[state.settings.quick];
  if (!o || !videoId) return null;
  return startJob({
    url: 'https://www.youtube.com/watch?v=' + videoId, videoId, title, kind: o.kind, height: o.height,
    label: quickLabel(state.settings.quick),
  });
}

function videoIdOf(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|live)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch { return null; }
}

if (api.commands) {
  api.commands.onCommand.addListener(async (cmd) => {
    if (cmd !== 'quick-download') return;
    await ready;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const videoId = tab && tab.url && videoIdOf(tab.url);
    if (!videoId) return;
    const send = (m) => api.tabs.sendMessage(tab.id, m).catch(() => {});
    if (!state.settings.quick) return send({ type: 'ytd-open' });
    const title = (tab.title || '').replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
    const job = startQuick(videoId, title);
    send({ type: 'ytd-toast', text: job ? `Скачиваю: ${job.label}` : 'Уже скачивается' });
  });
}

async function checkFiles() {
  const done = state.jobs.filter((j) => j.status === 'done' && j.file);
  if (!done.length) return;
  try {
    const r = await request('exists', { files: done.map((j) => j.file) });
    let any = false;
    done.forEach((j, i) => {
      const missing = !r.exists[i];
      if (!!j.missing !== missing) { j.missing = missing; any = true; }
    });
    if (any) changed(true);
  } catch {}
}

api.runtime.onConnect.addListener((p) => {
  if (p.name !== 'ui') return;
  uis.add(p);
  p.onDisconnect.addListener(() => uis.delete(p));
  p.onMessage.addListener(async (m) => {
    await ready;
    const reply = (data) => { try { p.postMessage({ type: 'reply', rid: m.rid, ...data }); } catch {} };
    try {
      switch (m.type) {
        case 'hello':
          p.postMessage({ type: 'state', state });
          if (state.host.ok !== true) await hello();
          checkFiles();
          if (p.sender && p.sender.url && p.sender.url.includes('popup.html')) checkUpdate(false);
          return;
        case 'checkUpdate':
          await checkUpdate(true);
          return reply({});
        case 'applyUpdate': {
          if (state.jobs.some(isActive)) {
            return reply({ error: 'Дождись окончания загрузок — обновление их прервёт.' });
          }
          state.update = { ...state.update, busy: 'apply', error: '' };
          changed(false);
          try {
            await request('applyUpdate');
          } catch (e) {
            state.update = { ...state.update, busy: '', error: e.message };
            changed(false);
            return reply({ error: e.message });
          }
          await api.storage.local.set({ jobs: state.jobs.slice(0, MAX_JOBS), settings: state.settings });
          reply({});
          // the files on disk are new now; reload picks them up (unpacked extension)
          setTimeout(() => api.runtime.reload(), 400);
          return;
        }
        case 'probe':
          return reply({ info: await probe(m.url, m.videoId) });
        case 'download':
          startJob(m);
          return reply({});
        case 'quick': {
          const job = startQuick(m.videoId, m.title);
          return reply({ label: job ? job.label : '', dup: !job });
        }
        case 'setSetting':
          state.settings[m.key] = m.value;
          changed(true);
          return reply({});
        case 'probeList': {
          const hit = listCache.get(m.url);
          if (hit && Date.now() - hit.at < 10 * 60 * 1000) return reply({ list: hit.list });
          const r = await request('probeList', { url: m.url });
          listCache.set(m.url, { at: Date.now(), list: r.list });
          return reply({ list: r.list });
        }
        case 'downloadList': {
          // one group = one playlist download; items keep their playlist number in the file name
          const group = 'g' + Date.now().toString(36);
          const count = m.count || m.items.length;
          for (const it of m.items) {
            startJob({
              url: 'https://www.youtube.com/watch?v=' + it.id, videoId: it.id, title: it.title,
              kind: m.kind, height: m.height, label: m.label,
              group, groupTitle: m.title, index: it.index, count,
            });
          }
          return reply({ group });
        }
        case 'cancel':
          await cancelJobs(state.jobs.filter((x) => x.id === m.job));
          return reply({});
        case 'retry': {
          const j = state.jobs.find((x) => x.id === m.job);
          if (j) restartJob(j);
          return reply({});
        }
        case 'remove':
          state.jobs = state.jobs.filter((x) => x.id !== m.job);
          changed(true);
          return reply({});
        case 'cancelGroup':
          await cancelJobs(state.jobs.filter((x) => x.group === m.group));
          return reply({});
        case 'retryGroup':
          state.jobs.filter((x) => x.group === m.group && (x.status === 'error' || x.status === 'cancelled')).reverse().forEach(restartJob);
          return reply({});
        case 'removeGroup':
          state.jobs = state.jobs.filter((x) => x.group !== m.group || isActive(x));
          changed(true);
          return reply({});
        case 'clear':
          state.jobs = state.jobs.filter(isActive);
          changed(true);
          return reply({});
        case 'reveal':
        case 'open':
          await request(m.type, { file: m.file });
          return reply({});
        case 'pickFolder': {
          const r = await request('pickFolder', { current: state.settings.dir || state.host.defaultDir });
          if (r.dir) { state.settings.dir = r.dir; changed(true); }
          return reply({ dir: r.dir });
        }
        case 'resetFolder':
          state.settings.dir = '';
          changed(true);
          return reply({});
        case 'update': {
          await request('update');
          probeCache.clear();
          // pip needs a moment; ask for the new version afterwards
          setTimeout(() => { state.host.ok = null; hello(); }, 25000);
          return reply({});
        }
        case 'reconnect':
          state.host = { ...state.host, ok: null, error: '' };
          await hello();
          return reply({});
      }
    } catch (e) {
      reply({ error: e.message || String(e) });
    }
  });
});
