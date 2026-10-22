// Owns the native port, the download list and settings. UIs (popup, in-page panel)
// connect with runtime.connect({name: 'ui'}) and get the whole state on every change.
'use strict';

// Firefox has api.*, Edge/Chrome have chrome.* (promise-based in MV3)
const api = globalThis.browser || globalThis.chrome;

const HOST = 'yt_download_host';
const MAX_JOBS = 40;

let port = null;
let reqSeq = 0;
const pending = new Map();     // request id -> {resolve, reject}
const probeCache = new Map();  // videoId -> {at, info}
const uis = new Set();

const state = {
  jobs: [],                    // newest first
  settings: { dir: '' },
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
  state.settings = { dir: '', ...(s.settings || {}) };
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
      break;
    case 'error':
      Object.assign(job, { status: 'error', error: msg.message, busy: false });
      changed(true);
      break;
    case 'cancelled':
      Object.assign(job, { status: 'cancelled', busy: false });
      changed(true);
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

function notify(job) {
  api.notifications.create('done:' + job.id, {
    type: 'basic',
    iconUrl: api.runtime.getURL('icons/icon96.png'),
    title: 'Скачано',
    message: job.title + '\n' + job.label,
  }).catch(() => {});
}

api.notifications.onClicked.addListener((nid) => {
  const job = state.jobs.find((j) => 'done:' + j.id === nid);
  if (job && job.file) request('reveal', { file: job.file }).catch(() => {});
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

function startJob(m) {
  const dup = state.jobs.find((j) => j.videoId === m.videoId && j.kind === m.kind && (j.height || 0) === (m.height || 0)
    && (j.status === 'running' || j.status === 'queued'));
  if (dup) return;
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    id,
    url: m.url,
    videoId: m.videoId,
    title: m.title || m.videoId,
    thumb: m.thumb || '',
    kind: m.kind,
    height: m.height || 0,
    label: m.label,
    status: 'queued',
    percent: 0,
    phase: 'В очереди',
    startedAt: Date.now(),
  };
  state.jobs.unshift(job);
  state.jobs = state.jobs.slice(0, MAX_JOBS);
  changed(true);
  try {
    connect().postMessage({
      id, cmd: 'download', url: m.url, videoId: m.videoId, kind: m.kind, height: m.height,
      dir: state.settings.dir || '',
    });
  } catch (e) {
    Object.assign(job, { status: 'error', error: e.message });
    changed(true);
  }
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
          if (state.jobs.some((j) => j.status === 'running' || j.status === 'queued')) {
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
        case 'cancel':
          await request('cancel', { job: m.job });
          return reply({});
        case 'retry': {
          const j = state.jobs.find((x) => x.id === m.job);
          if (j) {
            state.jobs = state.jobs.filter((x) => x !== j);
            startJob(j);
          }
          return reply({});
        }
        case 'remove':
          state.jobs = state.jobs.filter((x) => x.id !== m.job);
          changed(true);
          return reply({});
        case 'clear':
          state.jobs = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
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
