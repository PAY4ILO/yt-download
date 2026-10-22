// Native messaging host: the extension talks to it over stdin/stdout
// (4-byte little-endian length + JSON), it drives yt-dlp.
'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.2.0';
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

// Windows-safe file/folder name
function safeName(s, max = 150) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, max).replace(/[. ]+$/, '');
}

// target folder: chosen dir, plus a playlist subfolder for playlist downloads
function jobDir(msg) {
  const dir = path.join(msg.dir || CONFIG.defaultDir, safeName(msg.subdir, 100));
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

// "01. " in front of playlist items keeps their order in Explorer
function indexPrefix(msg) {
  return msg.index ? String(msg.index).padStart(String(msg.count || 99).length < 2 ? 2 : String(msg.count).length, '0') + '. ' : '';
}

function dispatchDownload(msg) {
  if (msg.kind === 'thumb') return downloadThumb(msg);
  if (msg.section) return downloadFragment(msg, false);
  return startDownload(msg, false);
}

function startDownload(msg, withCookies) {
  const id = msg.id;
  const dir = jobDir(msg);
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
    '-o', indexPrefix(msg) + (msg.kind === 'video' ? '%(title).170B (%(height)sp) [%(id)s].%(ext)s' : '%(title).180B [%(id)s].%(ext)s'),
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

// ---------- fragment / GIF ----------
// yt-dlp --download-sections streams through ffmpeg, which YouTube throttles to a crawl.
// Instead: ask yt-dlp only for the stream URLs, pull the needed byte span (fragment.js),
// then cut precisely with ffmpeg.

const { downloadSection } = require('./fragment');

function ffmpegExe(name = 'ffmpeg') {
  return CONFIG.ffmpeg ? path.join(CONFIG.ffmpeg, name + '.exe') : name;
}

function clock(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + 'h' + String(m).padStart(2, '0') + 'm' : m + 'm') + String(s).padStart(2, '0') + 's';
}

// Only DASH mp4 (protocol https) has the sidx index fragment.js needs; some YouTube formats
// with ext=mp4 are HLS (m3u8) and must be skipped.
function sectionFormat(msg) {
  const dash = '[ext=mp4][protocol=https]';
  if (msg.kind === 'gif') return ['-f', `bv*${dash}`, '-S', 'res:480,fps,vcodec:h264'];
  if (msg.kind === 'mp3' || msg.kind === 'm4a') return ['-f', 'ba[ext=m4a][protocol=https]', '-S', 'abr'];
  const h = Number(msg.height) || 1080;
  return ['-f', `bv*${dash}+ba[ext=m4a][protocol=https]`, '-S', `res:${h},fps,vcodec:h264,acodec:aac`];
}

function runFfmpeg(job, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegExe(), ['-y', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    job.proc = proc;
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString('utf8'); });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).pop() || 'ffmpeg: ошибка ' + code))));
    proc.on('error', reject);
  });
}

async function downloadFragment(msg, withCookies) {
  const id = msg.id;
  const st = { cancelled: false };
  const abort = new AbortController();
  const job = { id, proc: null, st, msg, abort };
  jobs.set(id, job);
  const start = Math.max(0, Number(msg.section.start) || 0);
  const end = Number(msg.section.end);
  const dur = end - start;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytd-frag-'));
  try {
    if (!(dur > 0)) throw new Error('Конец фрагмента должен быть позже начала.');
    send({ id, ev: 'progress', phase: 'Подключаюсь к YouTube', percent: 0 });
    const r = await run(ytdlpArgs([...sectionFormat(msg), ...(withCookies ? cookieArgs() : []), '-J', msg.url]), { timeoutMs: 90000 });
    if (st.cancelled) throw new Error('cancelled');
    if (r.code !== 0) {
      if (!withCookies && needsCookies(r.err) && CONFIG.firefoxProfile) {
        jobs.delete(id);
        fs.rmSync(tmp, { recursive: true, force: true });
        return downloadFragment(msg, true);
      }
      if (/Requested format is not available/i.test(r.err)) throw new Error('У этого видео фрагмент вырезать нельзя (нет подходящего формата). Скачай целиком.');
      throw new Error(cleanError(r.err));
    }
    const info = JSON.parse(r.out);
    const fmts = info.requested_formats || [info];

    // download the byte spans, one stream after another
    const parts = [];
    const totals = new Array(fmts.length).fill(0), dones = new Array(fmts.length).fill(0);
    const t0 = Date.now();
    let lastSent = 0;
    for (let i = 0; i < fmts.length; i++) {
      const file = path.join(tmp, `part${i}.mp4`);
      const res = await downloadSection(fmts[i], start, end, file, {
        signal: abort.signal,
        onBytes(done, total) {
          dones[i] = done; totals[i] = total;
          const now = Date.now();
          if (now - lastSent < 250) return;
          lastSent = now;
          // later streams' sizes aren't known yet: each stream is an equal share of the bar
          const pct = (i + done / total) / fmts.length * 100;
          const d = dones.reduce((a, b) => a + b, 0);
          send({ id, ev: 'progress', phase: 'Скачиваю фрагмент', percent: Math.min(95, pct), speed: d / ((now - t0) / 1000) });
        },
      });
      parts.push({ file, offset: res.offset, fmt: fmts[i] });
    }
    if (st.cancelled) throw new Error('cancelled');

    const dir = jobDir(msg);
    const title = safeName(info.title || msg.title || info.id);
    const range = clock(start) + '-' + clock(end);
    let out, args;
    if (msg.kind === 'gif') {
      out = path.join(dir, `${title} (GIF, ${range}) [${info.id}].gif`);
      send({ id, ev: 'progress', phase: 'Делаю GIF', percent: 100, busy: true });
      args = ['-ss', parts[0].offset.toFixed(3), '-i', parts[0].file, '-t', dur.toFixed(3),
        '-vf', 'fps=15,scale=480:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        '-loop', '0', out];
    } else if (msg.kind === 'mp3' || msg.kind === 'm4a') {
      out = path.join(dir, `${title} (${range}) [${info.id}].${msg.kind}`);
      send({ id, ev: 'progress', phase: 'Вырезаю фрагмент', percent: 100, busy: true });
      args = ['-ss', parts[0].offset.toFixed(3), '-i', parts[0].file, '-t', dur.toFixed(3), '-vn',
        ...(msg.kind === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '0'] : ['-c:a', 'aac', '-b:a', '192k']),
        '-metadata', `title=${info.title || ''}`, '-metadata', `artist=${info.channel || info.uploader || ''}`, out];
    } else {
      const v = parts.find((p) => p.fmt.vcodec && p.fmt.vcodec !== 'none') || parts[0];
      const a = parts.find((p) => p !== v);
      out = path.join(dir, `${title} (${v.fmt.height || ''}p, ${range}) [${info.id}].mp4`);
      send({ id, ev: 'progress', phase: 'Вырезаю фрагмент', percent: 100, busy: true });
      // re-encode: the cut lands exactly on the requested second, not on the previous keyframe
      args = ['-ss', v.offset.toFixed(3), '-i', v.file];
      if (a) args.push('-ss', a.offset.toFixed(3), '-i', a.file);
      args.push('-t', dur.toFixed(3), '-map', '0:v:0');
      if (a) args.push('-map', '1:a:0');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
      if (a) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
      args.push('-movflags', '+faststart', '-metadata', `title=${info.title || ''}`, out);
    }
    await runFfmpeg(job, args);
    if (st.cancelled) { try { fs.unlinkSync(out); } catch {} throw new Error('cancelled'); }
    send({ id, ev: 'done', file: out });
  } catch (e) {
    if (st.cancelled || e.name === 'AbortError') send({ id, ev: 'cancelled' });
    else { log('fragment failed', id, e.stack || e); send({ id, ev: 'error', message: e.message }); }
  } finally {
    jobs.delete(id);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- cover ----------

async function downloadThumb(msg) {
  const id = msg.id;
  const job = { id, proc: null, st: { cancelled: false }, msg, abort: new AbortController() };
  jobs.set(id, job);
  try {
    send({ id, ev: 'progress', phase: 'Скачиваю обложку', percent: 0, busy: true });
    let buf = null;
    // maxres (1280x720 or more) exists for most HD videos; fall back down the list
    for (const name of ['maxresdefault', 'sddefault', 'hqdefault']) {
      const res = await fetch(`https://i.ytimg.com/vi/${msg.videoId}/${name}.jpg`, { signal: job.abort.signal });
      if (res.ok) { buf = Buffer.from(await res.arrayBuffer()); break; }
    }
    if (!buf) throw new Error('У видео нет обложки.');
    const out = path.join(jobDir(msg), `${indexPrefix(msg)}${safeName(msg.title || msg.videoId)} [${msg.videoId}].jpg`);
    fs.writeFileSync(out, buf);
    send({ id, ev: 'done', file: out });
  } catch (e) {
    if (job.st.cancelled || e.name === 'AbortError') send({ id, ev: 'cancelled' });
    else send({ id, ev: 'error', message: e.message });
  } finally {
    jobs.delete(id);
  }
}

// ---------- playlists / channels ----------

function listUrl(url) {
  const u = new URL(url);
  const list = u.searchParams.get('list');
  if (list && u.pathname !== '/playlist') return 'https://www.youtube.com/playlist?list=' + list;
  // a channel page without a tab: take its uploads
  if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.test(u.pathname)) return u.origin + u.pathname.replace(/\/$/, '') + '/videos';
  return url;
}

async function probeList(url) {
  const target = listUrl(url);
  let r = await run(ytdlpArgs(['--flat-playlist', '-J', '-I', '1:500', target]).filter((a) => a !== '--no-playlist'), { timeoutMs: 120000 });
  if (r.code !== 0 && needsCookies(r.err) && CONFIG.firefoxProfile) {
    r = await run(ytdlpArgs(['--flat-playlist', '-J', '-I', '1:500', ...cookieArgs(), target]).filter((a) => a !== '--no-playlist'), { timeoutMs: 120000 });
  }
  if (r.code !== 0) throw new Error(cleanError(r.err));
  const info = JSON.parse(r.out);
  const entries = (info.entries || []).filter((e) => e && e.id && e.id.length === 11).map((e) => ({
    id: e.id,
    title: e.title || e.id,
    duration: e.duration || 0,
    unavailable: /^\[(Private|Deleted) video\]$/.test(e.title || ''),
  }));
  return {
    id: info.id,
    url: target,
    title: (info.title || 'Плейлист').replace(/ - Videos$/, ''),
    channel: info.channel || info.uploader || '',
    isChannel: /\/videos$/.test(target),
    entries,
  };
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
    case 'probeList':
      return send({ id: msg.id, ok: true, list: await probeList(msg.url) });
    case 'download':
      return dispatchDownload(msg);
    case 'cancel': {
      const job = jobs.get(msg.job);
      if (job) { job.st.cancelled = true; if (job.abort) job.abort.abort(); killTree(job.proc); }
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
