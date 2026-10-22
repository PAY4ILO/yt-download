// Downloads only the part of a YouTube DASH stream that covers [start, end] seconds.
// YouTube throttles long-running requests (ffmpeg, yt-dlp --download-sections hang), but
// serves &range=a-b chunks fast. DASH mp4 streams carry a segment index (sidx): from it we
// know which byte span holds which seconds, fetch just that span plus the init header,
// and get a small fragmented mp4 that ffmpeg can cut precisely.
'use strict';
const fs = require('fs');

const CHUNK = 9 * 1024 * 1024;

function withRange(url, a, b) {
  return url + (url.includes('?') ? '&' : '?') + `range=${a}-${b}`;
}

async function fetchRange(fmt, a, b, signal) {
  const res = await fetch(withRange(fmt.url, a, b), { headers: fmt.http_headers || {}, signal });
  if (!res.ok) throw new Error(`YouTube ответил ${res.status} на кусок видео`);
  return Buffer.from(await res.arrayBuffer());
}

// Walk top-level boxes until sidx; returns {initEnd, segments: [{t0, t1, a, b}]}
function parseIndex(head) {
  let pos = 0, initEnd = 0;
  while (pos + 8 <= head.length) {
    let size = head.readUInt32BE(pos);
    const type = head.toString('latin1', pos + 4, pos + 8);
    let hdr = 8;
    if (size === 1) { size = Number(head.readBigUInt64BE(pos + 8)); hdr = 16; }
    if (type === 'moov') initEnd = pos + size;
    if (type === 'sidx') {
      if (pos + size > head.length) return null; // need more bytes
      let p = pos + hdr;
      const version = head[p]; p += 4;
      p += 4; // reference_ID
      const timescale = head.readUInt32BE(p); p += 4;
      let ept, firstOffset;
      if (version === 0) { ept = head.readUInt32BE(p); firstOffset = head.readUInt32BE(p + 4); p += 8; }
      else { ept = Number(head.readBigUInt64BE(p)); firstOffset = Number(head.readBigUInt64BE(p + 8)); p += 16; }
      p += 2;
      const count = head.readUInt16BE(p); p += 2;
      let offset = pos + size + firstOffset;
      let t = ept / timescale;
      const segments = [];
      for (let i = 0; i < count; i++) {
        const refSize = head.readUInt32BE(p) & 0x7fffffff;
        const dur = head.readUInt32BE(p + 4) / timescale;
        segments.push({ t0: t, t1: t + dur, a: offset, b: offset + refSize - 1 });
        offset += refSize; t += dur; p += 12;
      }
      return { initEnd, segments };
    }
    if (size < 8) break;
    pos += size;
  }
  return null;
}

// Writes init + segments covering [start, end] to outFile.
// Returns {offset}: seconds from the file start to `start` (segments begin at keyframes, a bit earlier).
async function downloadSection(fmt, start, end, outFile, { onBytes, signal } = {}) {
  let head = await fetchRange(fmt, 0, 256 * 1024 - 1, signal);
  let idx = parseIndex(head);
  if (!idx) {
    head = await fetchRange(fmt, 0, 4 * 1024 * 1024 - 1, signal);
    idx = parseIndex(head);
  }
  if (!idx || !idx.initEnd || !idx.segments.length) throw new Error('У этого формата нет индекса сегментов');
  const segs = idx.segments.filter((s) => s.t1 > start && s.t0 < end);
  if (!segs.length) throw new Error('Фрагмент за пределами видео');
  const a = segs[0].a, b = segs[segs.length - 1].b;
  const total = idx.initEnd + (b - a + 1);
  const out = fs.openSync(outFile, 'w');
  try {
    fs.writeSync(out, head.subarray(0, idx.initEnd));
    let done = idx.initEnd;
    for (let x = a; x <= b; x += CHUNK) {
      const y = Math.min(b, x + CHUNK - 1);
      const buf = await fetchRange(fmt, x, y, signal);
      fs.writeSync(out, buf);
      done += buf.length;
      if (onBytes) onBytes(done, total);
    }
  } finally {
    fs.closeSync(out);
  }
  return { offset: Math.max(0, start - segs[0].t0), total };
}

module.exports = { downloadSection };
