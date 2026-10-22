// Native messaging host: the extension talks to it over stdin/stdout
// (4-byte little-endian length + JSON), it drives yt-dlp.
'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.1.0';
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^﻿/, ''));
const LOG = path.join(__dirname, 'host.log');
const ROOT = path.dirname(__dirname); // the yt-download folder: extension/, host/, install.ps1
const UPDATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'update.json'), 'utf8').replace(/^﻿/, ''));

function log(...a) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {}
}

// ---------- framing ----------

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    handle(msg).catch((e) => send({ id: msg.id, ok: false, error: String(e && e.message || e) }));
  }
});
// Browser closed the port: stop everything we started.
process.stdin.on('end', () => {
  for (const job of jobs.values()) killTree(job.proc);
  // Exiting synchronously right after a fetch() trips a libuv assertion on Windows; let handles settle.
  setTimeout(() => process.exit(0), 100);
});

// ---------- yt-dlp ----------

function ytdlpArgs(extra) {
  const base = ['-m', 'yt_dlp', '--no-playlist', '--no-warnings', '--js-runtimes', 'node:' + CONFIG.node];
  if (CONFIG.ffmpeg) base.push('--ffmpeg-location', CONFIG.ffmpeg);
  return base.concat(extra);
}

function childEnv() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function cookieArgs() {
  return CONFIG.firefoxProfile ? ['--cookies-from-browser', 'firefox:' + CONFIG.firefoxProfile] : [];
}

// YouTube refuses some videos without a signed-in session (age gate, "not a bot").
function needsCookies(text) {
  return /Sign in to confirm|age-restricted|inappropriate for some users|members-only|Private video|login required/i.test(text);
}

function cleanError(text) {
  const lines = text.split(/\r?\n/).filter((l) => /^ERROR:/.test(l));
  let msg = (lines.pop() || text.trim().split(/\r?\n/).pop() || 'yt-dlp завершился с ошибкой')
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '');
  if (/Sign in to confirm you.re not a bot/i.test(msg)) msg = 'YouTube просит войти в аккаунт (проверка на бота). Войди в YouTube в Firefox и попробуй ещё раз.';
  else if (/Sign in to confirm your age|age-restricted/i.test(msg)) msg = 'Видео 18+: нужно войти в YouTube в Firefox.';
  else if (/Private video/i.test(msg)) msg = 'Это приватное видео.';
  else if (/members-only|Join this channel/i.test(msg)) msg = 'Видео только для спонсоров канала.';
  else if (/video (is )?unavailable|not available in your country/i.test(msg)) msg = 'Видео недоступно (удалено или закрыто в этой стране).';
  else if (/live event will begin|Premieres in/i.test(msg)) msg = 'Трансляция или премьера ещё не началась.';
  else if (/HTTP Error 403/i.test(msg)) msg = 'YouTube отдал 403 — скорее всего, yt-dlp устарел. Нажми «Обновить yt-dlp» в настройках.';
  return msg;
}

function run(args, { onLine, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(CONFIG.python, args, { env: childEnv(), windowsHide: true });
    let out = '', err = '';
    let pending = '';
    proc.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (!onLine) return;
      pending += s;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop();
      for (const l of parts) onLine(l);
    });
    proc.stderr.on('data', (d) => { err += d.toString('utf8'); });
    let timer = timeoutMs ? setTimeout(() => killTree(proc), timeoutMs) : null;
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && pending) onLine(pending);
      resolve({ code, out, err, proc });
    });
    proc.on('error', (e) => resolve({ code: -1, out, err: String(e), proc }));
    if (onLine) onLine.proc = proc;
  });
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

// ---------- probe: what can be downloaded ----------

function sizeOf(f) { return f.filesize || f.filesize_approx || 0; }

function summarize(info) {
  const formats = info.formats || [];
  const audio = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const bestAudio = audio.filter((f) => f.ext === 'm4a').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]
    || audio.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  const audioSize = bestAudio ? sizeOf(bestAudio) : 0;

  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    if (f.protocol && /m3u8|mhtml/.test(f.protocol) && !info.is_live) continue;
    const h = Math.min(f.height, f.width || f.height); // vertical videos: 1080x1920 is "1080p"
    const cur = byHeight.get(h);
    // Same preference as the download sort: highest fps, then h264, then bitrate.
    const score = (x) => (x.fps || 0) * 1e6 + (/^avc1/.test(x.vcodec) ? 1e5 : 0) + (x.tbr || 0);
    if (!cur || score(f) > score(cur)) byHeight.set(h, f);
  }
  const options = [...byHeight.entries()]
    .filter(([h]) => h >= 144)
    .sort((a, b) => b[0] - a[0])
    .map(([h, f]) => {
      const v = sizeOf(f);
      const muxed = f.acodec && f.acodec !== 'none';
      return {
        height: h,
        fps: f.fps && f.fps > 30 ? Math.round(f.fps) : 0,
        hdr: f.dynamic_range && f.dynamic_range !== 'SDR',
        size: v ? v + (muxed ? 0 : audioSize) : 0,
      };
    });

  return {
    id: info.id,
    title: info.title,
    channel: info.channel || info.uploader || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    isLive: !!info.is_live,
    options,
    audioSize,
  };
}

async function probe(url) {
  let r = await run(ytdlpArgs(['-J', url]), { timeoutMs: 90000 });
  if (r.code !== 0 && needsCookies(r.err) && CONFIG.firefoxProfile) {
    r = await run(ytdlpArgs(['-J', ...cookieArgs(), url]), { timeoutMs: 90000 });
  }
  if (r.code !== 0) throw new Error(cleanError(r.err));
  return summarize(JSON.parse(r.out));
}

// ---------- download ----------

const jobs = new Map();

const PP_LABEL = {
  Merger: 'Склеиваю видео и звук',
  FFmpegMerger: 'Склеиваю видео и звук',
  ExtractAudio: 'Конвертирую звук',
  FFmpegExtractAudio: 'Конвертирую звук',
  EmbedThumbnail: 'Вставляю обложку',
  FFmpegMetadata: 'Записываю теги',
  Metadata: 'Записываю теги',
  MoveFiles: 'Переношу файл',
};

function formatArgs(o) {
  if (o.kind === 'mp3') {
    return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-thumbnail', '--embed-metadata'];
  }
  if (o.kind === 'm4a') {
    return ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--embed-thumbnail', '--embed-metadata'];
  }
  const h = Number(o.height) || 1080;
  // res:H = best not above H; codec:h264 = prefer h264 (plays everywhere) when it exists at that height.
  return ['-f', 'bv*+ba/b', '-S', `res:${h},fps,vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4', '--embed-metadata', '--embed-chapters'];
}

function startDownload(msg, withCookies) {
  const id = msg.id;
  const dir = msg.dir || CONFIG.defaultDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const args = ytdlpArgs([
    ...formatArgs(msg),
    ...(withCookies ? cookieArgs() : []),
    '--no-simulate', '--newline', '--progress', '--no-mtime', '--windows-filenames',
    '--print', 'before_dl:@@S%(format_id)s|%(filesize,filesize_approx)s',
    '--print', 'after_move:@@F%(filepath)s',
    '--progress-template', 'download:@@P%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s',
    '--progress-template', 'postprocess:@@PP%(progress.postprocessor)s|%(progress.status)s',
    '-P', dir,
    // quality in the name: 720p and 1080p of one video can download side by side
    '-o', msg.kind === 'video' ? '%(title).170B (%(height)sp) [%(id)s].%(ext)s' : '%(title).180B [%(id)s].%(ext)s',
    msg.url,
  ]);

  const st = { parts: new Map(), total: 0, nParts: 1, file: '', lastSent: 0, cancelled: false };
  const job = { id, proc: null, st, msg, dir };
  jobs.set(id, job);
  send({ id, ev: 'progress', phase: 'Подключаюсь к YouTube', percent: 0 });

  const onLine = (line) => {
    if (line.startsWith('@@S')) {
      const [fmt, size] = line.slice(3).split('|');
      st.nParts = fmt.split('+').length;
      st.total = Number(size) || 0;
    } else if (line.startsWith('@@PP')) {
      const [pp, status] = line.slice(4).split('|');
      if (status === 'started') send({ id, ev: 'progress', phase: PP_LABEL[pp] || 'Обработка', percent: 100, busy: true });
    } else if (line.startsWith('@@P')) {
      const [done, total, est, speed, eta, fmt] = line.slice(3).split('|');
      const t = Number(total) || Number(est) || 0;
      st.parts.set(fmt, { done: Number(done) || 0, total: t });
      const now = Date.now();
      if (now - st.lastSent < 250 && Number(done) < t) return;
      st.lastSent = now;
      send({ id, ev: 'progress', ...overall(st), speed: Number(speed) || 0, eta: Number(eta) || 0 });
    } else if (line.startsWith('@@F')) {
      st.file = line.slice(3).trim();
    }
  };

  const p = run(args, { onLine });
  job.proc = onLine.proc;
  p.then(({ code, err }) => {
    jobs.delete(id);
    if (st.cancelled) {
      cleanupParts(dir, msg.videoId);
      return send({ id, ev: 'cancelled' });
    }
    if (code === 0 && st.file) return send({ id, ev: 'done', file: st.file });
    if (!withCookies && needsCookies(err) && CONFIG.firefoxProfile) {
      log('retry with cookies', id);
      return startDownload(msg, true);
    }
    log('download failed', id, err.slice(-2000));
    send({ id, ev: 'error', message: cleanError(err) });
  });
}

function overall(st) {
  const parts = [...st.parts.values()];
  const done = parts.reduce((s, x) => s + x.done, 0);
  const idx = parts.length; // parts seen so far, the last one is in progress
  let percent;
  if (st.total > 0) {
    percent = (done / st.total) * 100;
  } else {
    const cur = parts[parts.length - 1];
    const curPct = cur && cur.total ? cur.done / cur.total : 0;
    percent = ((idx - 1 + curPct) / st.nParts) * 100;
  }
  const phase = st.nParts > 1 ? (idx <= 1 ? 'Скачиваю видео' : 'Скачиваю звук') : 'Скачиваю';
  return { percent: Math.max(0, Math.min(99.5, percent)), phase, done, total: st.total };
}

// Remove leftovers (.part, .ytdl, unmerged pieces) of a cancelled download.
function cleanupParts(dir, videoId) {
  if (!videoId) return;
  setTimeout(() => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.includes(`[${videoId}]`) && /\.(part|ytdl|f\d+\.\w+|temp\.\w+)$|\.f\d+\.\w+\.part$|\.part-Frag\d+/.test(f)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
      }
    } catch {}
  }, 800);
}

// ---------- small OS helpers ----------

function pickFolder(current) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Куда сохранять видео'
$d.UseDescriptionForTitle = $true
$d.SelectedPath = $env:YTD_CUR
$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; WindowState='Minimized'}
if ($d.ShowDialog($f) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
      env: { ...process.env, YTD_CUR: current || CONFIG.defaultDir }, windowsHide: true, encoding: 'utf8',
    }, (e, out) => resolve((out || '').trim() || null));
  });
}

function reveal(file) {
  if (file && fs.existsSync(file)) spawn('explorer.exe', ['/select,', file], { detached: true, windowsHide: false }).unref();
  else if (file) spawn('explorer.exe', [path.dirname(file)], { detached: true }).unref();
}

function openFile(file) {
  if (file && fs.existsSync(file)) spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, windowsHide: true }).unref();
}

function ytdlpVersion() {
  return new Promise((resolve) => {
    execFile(CONFIG.python, ['-m', 'yt_dlp', '--version'], { env: childEnv(), windowsHide: true }, (e, out) => resolve((out || '').trim() || null));
  });
}

// pip must run outside Firefox's MSIX container, otherwise its writes land in the
// container's private copy of AppData. A scheduled task runs as a normal process.
function updateYtdlp() {
  return new Promise((resolve) => {
    execFile('schtasks.exe', ['/Run', '/TN', CONFIG.updateTask], { windowsHide: true }, (e, out, err) => {
      resolve(e ? { ok: false, error: (err || String(e)).trim() } : { ok: true });
    });
  });
}

// ---------- self-update from GitHub ----------
// The extension is loaded unpacked from ROOT/extension, so replacing the files on disk
// and calling runtime.reload() in the browser is a full update.

function localVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8').replace(/^﻿/, '')).version;
}

function newer(a, b) { // a > b
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

async function checkUpdate() {
  const url = `https://raw.githubusercontent.com/${UPDATE.repo}/${UPDATE.branch}/extension/manifest.json?t=${Date.now()}`;
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status} — репозиторий ${UPDATE.repo} недоступен?`);
  const latest = JSON.parse((await res.text()).replace(/^﻿/, '')).version;
  const current = localVersion();
  return { current, latest, available: newer(latest, current), git: fs.existsSync(path.join(ROOT, '.git')) };
}

function fileHash(f) {
  try { return require('crypto').createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; }
}

function execP(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', ...opts }, (e, out, err) => {
      if (e) reject(new Error((err || out || String(e)).trim().split(/\r?\n/).pop()));
      else resolve(out);
    });
  });
}

async function applyUpdate() {
  const installBefore = fileHash(path.join(ROOT, 'install.ps1'));
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    // a working copy (the author's): never overwrite local edits with a zip
    await execP('git', ['-C', ROOT, 'pull', '--ff-only']);
  } else {
    const res = await fetch(`https://codeload.github.com/${UPDATE.repo}/zip/refs/heads/${UPDATE.branch}`);
    if (!res.ok) throw new Error(`Не удалось скачать обновление (${res.status})`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytd-update-'));
    const zip = path.join(tmp, 'update.zip');
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    await execP('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath $env:YTD_ZIP -DestinationPath $env:YTD_OUT -Force`],
      { env: { ...process.env, YTD_ZIP: zip, YTD_OUT: path.join(tmp, 'x') } });
    const top = fs.readdirSync(path.join(tmp, 'x'))[0]; // "<repo>-<branch>"
    // config.json, host.bat and the native manifests are generated per machine and not in the repo,
    // so copying over the tree keeps them.
    fs.cpSync(path.join(tmp, 'x', top), ROOT, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // New install steps (deps, registry) ship in install.ps1: rerun it when it changed.
  const reinstall = fileHash(path.join(ROOT, 'install.ps1')) !== installBefore;
  if (reinstall) {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'install.ps1'), '-Quiet'],
      { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  }
  log('updated to', localVersion(), reinstall ? '(install.ps1 rerun)' : '');
  return { version: localVersion(), reinstall };
}

// ---------- dispatch ----------

async function handle(msg) {
  switch (msg.cmd) {
    case 'hello':
      return send({ id: msg.id, ok: true, version: VERSION, ytdlp: await ytdlpVersion(), defaultDir: CONFIG.defaultDir, cookies: !!CONFIG.firefoxProfile });
    case 'probe':
      return send({ id: msg.id, ok: true, info: await probe(msg.url) });
    case 'download':
      return startDownload(msg, false);
    case 'cancel': {
      const job = jobs.get(msg.job);
      if (job) { job.st.cancelled = true; killTree(job.proc); }
      return send({ id: msg.id, ok: true });
    }
    case 'pickFolder':
      return send({ id: msg.id, ok: true, dir: await pickFolder(msg.current) });
    case 'reveal':
      reveal(msg.file);
      return send({ id: msg.id, ok: true });
    case 'open':
      openFile(msg.file);
      return send({ id: msg.id, ok: true });
    case 'exists':
      return send({ id: msg.id, ok: true, exists: (msg.files || []).map((f) => !!f && fs.existsSync(f)) });
    case 'update':
      return send({ id: msg.id, ...(await updateYtdlp()) });
    case 'checkUpdate':
      return send({ id: msg.id, ok: true, ...(await checkUpdate()) });
    case 'applyUpdate':
      if (jobs.size) throw new Error('Дождись окончания загрузок — обновление их прервёт.');
      return send({ id: msg.id, ok: true, ...(await applyUpdate()) });
    default:
      return send({ id: msg.id, ok: false, error: 'unknown cmd ' + msg.cmd });
  }
}

// Firefox suspends an idle MV3 background page, which would close this port and
// kill the downloads. Long silent phases (merging a 4K video) still produce traffic.
setInterval(() => { if (jobs.size) send({ ev: 'tick' }); }, 10000);

log('host started', VERSION, process.argv.slice(2).join(' '));
