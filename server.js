// Gif Studio - local server. Serves the UI and runs ffmpeg for previews and conversions.
// Usage: node server.js [--open] [--port 47823] [--out "<folder>"] [--ffmpeg "<folder with ffmpeg.exe>"]
//   --open  opens the app window (Chrome app mode if Chrome is installed, else the default browser)
// Everything stays on this PC: it only listens on 127.0.0.1 and never contacts the internet.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const VERSION = '1.0.0';
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const PORT = Number(args.port) || 47823;
const IS_WIN = process.platform === 'win32';

// The real Desktop (it is often moved into OneDrive), falling back to ~/Desktop.
function desktopDir() {
  if (IS_WIN) {
    try {
      const d = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath("Desktop")'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      if (d && fs.existsSync(d)) return d;
    } catch (e) {}
  }
  return path.join(os.homedir(), 'Desktop');
}
const OUT_DIR = typeof args.out === 'string' ? args.out : path.join(desktopDir(), 'Gif Studio');
const TMP = path.join(os.tmpdir(), 'gif-studio');
const BYE_EXIT_MS = 20 * 1000;           // window closed: quit if it doesn't come back (a reload pings again)
const IDLE_EXIT_MS = 3 * 60 * 60 * 1000; // safety net: quit after 3 hours without any window
const LOG = path.join(os.tmpdir(), 'gif-studio', 'server.log');

// Never die on a stray error; write it to the log instead.
function logErr(e) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${(e && e.stack) || e}\n`); } catch (x) {}
}
process.on('uncaughtException', logErr);
process.on('unhandledRejection', logErr);

// ffmpeg: --ffmpeg folder, an "ffmpeg" folder next to this app, one two levels up (Svenni Scripts\ffmpeg), else PATH.
function findBin(name) {
  const exe = IS_WIN ? name + '.exe' : name;
  const dirs = [typeof args.ffmpeg === 'string' ? args.ffmpeg : null,
    path.join(__dirname, 'ffmpeg'), path.join(__dirname, 'ffmpeg', 'bin'), path.join(__dirname, '..', '..', 'ffmpeg')];
  for (const d of dirs) if (d && fs.existsSync(path.join(d, exe))) return path.join(d, exe);
  return name;
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');
let ffmpegOk = false;
execFile(FFMPEG, ['-hide_banner', '-version'], { windowsHide: true }, (err) => { ffmpegOk = !err; });

fs.mkdirSync(TMP, { recursive: true });
// Clear leftovers from earlier sessions (older than a day).
for (const f of fs.readdirSync(TMP)) {
  try {
    const p = path.join(TMP, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {}
}

const sources = new Map(); // id -> { path, name, info, proxy, strip }
const jobs = new Map();    // id -> { progress, stage, done, error, outputs, proc, cancelled }
let pendingOpen = null;    // file path pushed by the launcher, picked up by the page's ping
let lastPing = Date.now();
let byeAt = 0;             // when the window last said it was closing

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.gif': 'image/gif', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ico': 'image/x-icon',
};

const newId = () => crypto.randomBytes(8).toString('hex');

// ---------- helpers ----------
function send(res, code, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8','Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return send(res, 404, { error: 'not found' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    if (isNaN(start) || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
    });
    pipeFile(fs.createReadStream(file, { start, end }), res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    pipeFile(fs.createReadStream(file), res);
  }
}

function pipeFile(rs, res) {
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy()); // the video element aborts range requests all the time when seeking
  rs.pipe(res);
}

function run(bin, argv) {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { maxBuffer: 32 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-3).join('\n')));
      else resolve(stdout);
    });
  });
}

function parseRate(r) {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a || 0;
}

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=duration',
    '-of', 'json', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('No video stream found in this file.');
  let rot = 0;
  for (const sd of v.side_data_list || []) if (sd.rotation != null) rot = Number(sd.rotation);
  if (!rot && v.tags && v.tags.rotate) rot = Number(v.tags.rotate);
  let w = v.width, h = v.height;
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  let fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30;
  if (fps > 240) fps = 30;
  return {
    duration: Number(j.format && j.format.duration) || 0,
    width: w, height: h, fps: Math.round(fps * 1000) / 1000, codec: v.codec_name,
    hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

async function addSource(file, name) {
  const info = await probe(file);
  const id = newId();
  sources.set(id, { path: file, name: name || path.basename(file), info });
  return { id, name: name || path.basename(file), info };
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
  return p;
}

function safeBase(name) {
  const b = path.parse(name).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/&amp;/g, '&').trim();
  return (b || 'clip').slice(0, 120);
}

// ffmpeg wants "C\:/Windows/..." inside filter option values.
const ffPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

// ---------- conversion ----------
const num = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

function buildFilter(s, fmt, capFiles) {
  const f = [];
  const c = s.crop;
  if (c && (c.w < 0.9999 || c.h < 0.9999)) {
    const r = (n) => n.toFixed(6);
    f.push(`crop=w=iw*${r(c.w)}:h=ih*${r(c.h)}:x=iw*${r(c.x)}:y=ih*${r(c.y)}`);
  }
  if (s.rotate === 90) f.push('transpose=1');
  else if (s.rotate === 270) f.push('transpose=2');
  else if (s.rotate === 180) f.push('hflip,vflip');
  if (s.flipH) f.push('hflip');
  if (s.flipV) f.push('vflip');
  if (s.speed !== 1) f.push(`setpts=PTS/${s.speed}`);
  f.push(`fps=${s.fps}`);
  f.push(`scale=${s.outW}:-2:flags=lanczos`);
  const F = 'C:\\Windows\\Fonts\\';
  const pick = (...names) => ffPath(F + (names.find((n) => fs.existsSync(F + n)) || 'arialbd.ttf'));
  for (const cap of capFiles) {
    const fpx = cap.pos === 'top' ? s.topPx : s.bottomPx, bw = Math.max(1, Math.round(fpx / 12)), m = Math.round(fpx * 0.3);
    // Impact has Latin only; Malgun Gothic covers Korean/CJK and most other scripts.
    const font = /[^\x00-\u024f\u2000-\u206f]/.test(cap.text) ? pick('malgunbd.ttf', 'arialbd.ttf') : pick('impact.ttf', 'arialbd.ttf');
    const y = cap.pos === 'top' ? `${m}` : `h-text_h-${m}`;
    f.push(`drawtext=fontfile='${font}':textfile='${ffPath(cap.file)}':expansion=none:fontsize=${fpx}:fontcolor=white:borderw=${bw}:bordercolor=black:x=(w-text_w)/2:y=${y}`);
  }
  let g = `[0:v]${f.join(',')}`;
  if (s.mode === 'reverse') g += ',reverse[v]';
  else if (s.mode === 'boomerang') g += ',split[f0][r0];[r0]reverse[r1];[f0][r1]concat=n=2:v=1:a=0[v]';
  else g += '[v]';
  if (fmt === 'gif') {
    const d = s.dither === 'bayer' ? 'dither=bayer:bayer_scale=3' : `dither=${s.dither}`;
    g += `;[v]split[a][b];[a]palettegen=max_colors=${s.colors}:stats_mode=diff[p];[b][p]paletteuse=${d}:diff_mode=rectangle[out]`;
  } else if (fmt === 'mp4') {
    g += ';[v]format=yuv420p[out]';
  } else {
    g += ';[v]null[out]';
  }
  return g;
}

function sanitizeSettings(b, src) {
  const dur = src.info.duration || 0;
  const start = num(b.start, 0, dur || 1e9, 0);
  const end = num(b.end, start + 0.05, dur || 1e9, dur || start + 1);
  const crop = b.crop ? {
    x: num(b.crop.x, 0, 1, 0), y: num(b.crop.y, 0, 1, 0), w: num(b.crop.w, 0.01, 1, 1), h: num(b.crop.h, 0.01, 1, 1),
  } : null;
  if (crop) { crop.w = Math.min(crop.w, 1 - crop.x); crop.h = Math.min(crop.h, 1 - crop.y); }
  const formats = (Array.isArray(b.formats) ? b.formats : ['gif']).filter((x) => ['gif', 'webp', 'mp4'].includes(x));
  return {
    start, end, crop, formats: formats.length ? formats : ['gif'],
    outW: Math.round(num(b.outW, 16, 4096, 480) / 2) * 2,
    fps: num(b.fps, 1, 60, 15),
    speed: num(b.speed, 0.1, 8, 1),
    mode: ['normal', 'reverse', 'boomerang'].includes(b.mode) ? b.mode : 'normal',
    rotate: [0, 90, 180, 270].includes(Number(b.rotate)) ? Number(b.rotate) : 0,
    flipH: !!b.flipH, flipV: !!b.flipV,
    top: String(b.top || '').slice(0, 200), bottom: String(b.bottom || '').slice(0, 200),
    topPx: Math.round(num(b.topPx, 6, 400, 32)),
    bottomPx: Math.round(num(b.bottomPx, 6, 400, 32)),
    colors: Math.round(num(b.colors, 2, 256, 256)),
    dither: ['sierra2_4a', 'floyd_steinberg', 'bayer', 'none'].includes(b.dither) ? b.dither : 'sierra2_4a',
    loop: Math.round(num(b.loop, -1, 100, 0)),
    webpQ: Math.round(num(b.webpQ, 1, 100, 80)),
    mp4Audio: !!b.mp4Audio,
  };
}

function ffArgs(src, s, fmt, outFile, capFiles) {
  const a = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-loglevel', 'error'];
  if (s.start > 0) a.push('-ss', s.start.toFixed(3));
  a.push('-t', (s.end - s.start).toFixed(3), '-i', src.path);
  a.push('-filter_complex', buildFilter(s, fmt, capFiles), '-map', '[out]');
  if (fmt === 'gif') {
    a.push('-loop', String(s.loop));
  } else if (fmt === 'webp') {
    a.push('-c:v', 'libwebp_anim', '-lossless', '0', '-quality', String(s.webpQ), '-compression_level', '4', '-loop', String(Math.max(0, s.loop === -1 ? 1 : s.loop)));
  } else {
    a.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart');
    const audioOk = s.mp4Audio && src.info.hasAudio && s.mode === 'normal' && s.speed >= 0.5 && s.speed <= 2;
    if (audioOk) {
      a.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '160k');
      if (s.speed !== 1) a.push('-af', `atempo=${s.speed}`);
      a.push('-shortest');
    } else a.push('-an');
  }
  a.push(outFile);
  return a;
}

async function runJob(job, src, s) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const capFiles = [];
  for (const pos of ['top', 'bottom']) {
    const text = s[pos].trim();
    if (!text) continue;
    const file = path.join(TMP, `cap-${newId()}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    capFiles.push({ pos, file, text });
  }
  const outDur = ((s.end - s.start) / s.speed) * (s.mode === 'boomerang' ? 2 : 1);
  const base = safeBase(src.name);
  try {
    for (let i = 0; i < s.formats.length; i++) {
      if (job.cancelled) throw new Error('Cancelled');
      const fmt = s.formats[i];
      const outFile = uniquePath(OUT_DIR, base, '.' + fmt);
      job.stage = `Making ${fmt.toUpperCase()}` + (s.formats.length > 1 ? ` (${i + 1}/${s.formats.length})` : '');
      await new Promise((resolve, reject) => {
        const p = spawn(FFMPEG, ffArgs(src, s, fmt, outFile, capFiles), { windowsHide: true });
        job.proc = p;
        let err = '';
        let buf = '';
        p.stdout.on('data', (d) => {
          buf += d;
          let k;
          while ((k = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, k).trim();
            buf = buf.slice(k + 1);
            const m = /^out_time_us=(\d+)/.exec(line);
            if (m && outDur > 0) {
              const part = Math.min(1, Number(m[1]) / 1e6 / outDur);
              job.progress = (i + part) / s.formats.length;
            }
          }
        });
        p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
        p.on('error', reject);
        p.on('close', (code) => {
          job.proc = null;
          if (job.cancelled) { fs.rm(outFile, { force: true }, () => {}); return reject(new Error('Cancelled')); }
          if (code === 0) resolve();
          else reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `ffmpeg exited with ${code}`));
        });
      });
      const st = fs.statSync(outFile);
      job.outputs.push({ format: fmt, file: outFile, name: path.basename(outFile), size: st.size, url: `/out/${job.id}/${job.outputs.length}` });
      job.progress = (i + 1) / s.formats.length;
    }
    job.done = true;
  } catch (e) {
    job.error = e.message;
    job.done = true;
  } finally {
    for (const c of capFiles) fs.rm(c.file, { force: true }, () => {});
  }
}

// ---------- preview helpers ----------
const busy = new Map(); // dedupe concurrent proxy/strip work per source
function once(key, fn) {
  if (!busy.has(key)) busy.set(key, fn().finally(() => busy.delete(key)));
  return busy.get(key);
}

async function makeProxy(src) {
  if (src.proxy && fs.existsSync(src.proxy)) return src.proxy;
  const out = path.join(TMP, `proxy-${newId()}.mp4`);
  await run(FFMPEG, ['-hide_banner', '-y', '-loglevel', 'error', '-i', src.path,
    '-vf', "scale='min(1280,iw)':-2,format=yuv420p", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
  src.proxy = out;
  return out;
}

async function makeStrip(src) {
  if (src.strip && fs.existsSync(src.strip)) return src.strip;
  const dur = src.info.duration || 1;
  const n = 24;
  const out = path.join(TMP, `strip-${newId()}.jpg`);
  const pre = dur > 90 ? ['-skip_frame', 'nokey'] : [];
  await run(FFMPEG, ['-hide_banner', '-y', '-loglevel', 'error', ...pre, '-i', src.path, '-an',
    '-vf', `fps=${n}/${dur.toFixed(3)},scale=-2:64,tile=${n}x1`, '-frames:v', '1', '-q:v', '5', out]);
  src.strip = out;
  return out;
}

// ---------- routes ----------
function allowed(req) {
  // Block other websites from driving this server (DNS rebinding / cross-site POSTs).
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  // /api/bye comes from navigator.sendBeacon, which can't set headers; it only arms the exit timer.
  if (req.method === 'POST' && req.headers['x-gif-studio'] !== '1' && req.url !== '/api/bye') return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    let m;

    if (p === '/' || p === '/index.html') return serveFile(req, res, path.join(__dirname, 'index.html'));
    if (p === '/favicon.ico') {
      const ico = path.join(__dirname, '..', '..', '..', 'icon.ico');
      return fs.existsSync(ico) ? serveFile(req, res, ico) : send(res, 204, '');
    }
    if (p === '/api/hello') return send(res, 200, { app: 'gif-studio', version: VERSION, outDir: OUT_DIR, ffmpegOk });

    if (p === '/api/bye' && req.method === 'POST') {
      byeAt = Date.now();
      req.resume();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/ping') {
      lastPing = Date.now();
      byeAt = 0;
      const open = pendingOpen;
      pendingOpen = null;
      return send(res, 200, { open, outDir: OUT_DIR, ffmpegOk });
    }

    if (p === '/api/pending' && req.method === 'POST') {
      let s = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (s += c));
      req.on('end', () => { pendingOpen = decodeURIComponent(s.trim()); send(res, 200, { ok: true }); });
      return;
    }

    if (p === '/api/open' && req.method === 'POST') {
      const b = await readJson(req);
      const file = String(b.path || '').trim().replace(/^"|"$/g, '');
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 400, { error: 'File not found: ' + file });
      return send(res, 200, await addSource(file));
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const name = url.searchParams.get('name') || 'clip.mp4';
      const ext = (path.extname(name) || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '');
      const file = path.join(TMP, `up-${newId()}${ext}`);
      const ws = fs.createWriteStream(file);
      req.pipe(ws);
      ws.on('finish', async () => {
        try { send(res, 200, await addSource(file, name)); }
        catch (e) { fs.rm(file, { force: true }, () => {}); send(res, 400, { error: e.message }); }
      });
      ws.on('error', (e) => send(res, 500, { error: e.message }));
      return;
    }

    if ((m = /^\/media\/([0-9a-f]+)$/.exec(p))) {
      const src = sources.get(m[1]);
      if (!src) return send(res, 404, { error: 'unknown source' });
      return serveFile(req, res, url.searchParams.get('proxy') && src.proxy ? src.proxy : src.path);
    }

    if ((m = /^\/api\/proxy\/([0-9a-f]+)$/.exec(p)) && req.method === 'POST') {
      const src = sources.get(m[1]);
      if (!src) return send(res, 404, { error: 'unknown source' });
      await once('proxy' + m[1], () => makeProxy(src));
      return send(res, 200, { url: `/media/${m[1]}?proxy=1` });
    }

    if ((m = /^\/api\/strip\/([0-9a-f]+)$/.exec(p))) {
      const src = sources.get(m[1]);
      if (!src) return send(res, 404, { error: 'unknown source' });
      return serveFile(req, res, await once('strip' + m[1], () => makeStrip(src)));
    }

    if (p === '/api/render' && req.method === 'POST') {
      const b = await readJson(req);
      const src = sources.get(b.id);
      if (!src) return send(res, 404, { error: 'The video is no longer loaded. Open it again.' });
      const s = sanitizeSettings(b, src);
      const job = { id: newId(), progress: 0, stage: 'Starting', done: false, error: null, outputs: [], proc: null, cancelled: false };
      jobs.set(job.id, job);
      runJob(job, src, s);
      return send(res, 200, { job: job.id });
    }

    if ((m = /^\/api\/job\/([0-9a-f]+)$/.exec(p))) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'unknown job' });
      const { progress, stage, done, error, outputs } = job;
      return send(res, 200, { progress, stage, done, error, outputs });
    }

    if ((m = /^\/api\/cancel\/([0-9a-f]+)$/.exec(p)) && req.method === 'POST') {
      const job = jobs.get(m[1]);
      if (job) { job.cancelled = true; if (job.proc) job.proc.kill(); }
      return send(res, 200, { ok: true });
    }

    if ((m = /^\/out\/([0-9a-f]+)\/(\d+)$/.exec(p))) {
      const job = jobs.get(m[1]);
      const o = job && job.outputs[Number(m[2])];
      if (!o) return send(res, 404, { error: 'not found' });
      return serveFile(req, res, o.file);
    }

    if (p === '/api/file-action' && req.method === 'POST') {
      const b = await readJson(req);
      if (b.action === 'folder') {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        spawn('explorer.exe', [`"${OUT_DIR}"`], { windowsVerbatimArguments: true, detached: true }).unref();
        return send(res, 200, { ok: true });
      }
      const job = jobs.get(b.job);
      const o = job && job.outputs[Number(b.index)];
      if (!o || !fs.existsSync(o.file)) return send(res, 404, { error: 'File is gone.' });
      if (b.action === 'reveal') {
        spawn('explorer.exe', [`/select,"${o.file}"`], { windowsVerbatimArguments: true, detached: true }).unref();
      } else if (b.action === 'open') {
        spawn('explorer.exe', [`"${o.file}"`], { windowsVerbatimArguments: true, detached: true }).unref();
      } else if (b.action === 'copy') {
        // Puts the file itself on the clipboard, so Ctrl+V in Discord/Explorer pastes the file.
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Set-Clipboard -LiteralPath '${o.file.replace(/'/g, "''")}'`]);
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

// Opens the app: a clean Chrome app window if Chrome is installed, otherwise the default browser.
function openWindow() {
  const url = `http://127.0.0.1:${PORT}/`;
  if (!IS_WIN) {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const env = process.env;
  const chrome = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
    .filter(Boolean).map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => fs.existsSync(p));
  if (chrome) spawn(chrome, [`--app=${url}`, '--window-size=1400,900'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd.exe', ['/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Gif Studio is already running.');
    if (args.open) openWindow();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Gif Studio ${VERSION} is running on http://127.0.0.1:${PORT}`);
  console.log(`Clips are saved to: ${OUT_DIR}`);
  console.log('Keep this window open while you use it. It closes by itself after you close Gif Studio.');
  if (args.open) openWindow();
});

setInterval(() => {
  const working = [...jobs.values()].some((j) => !j.done) || busy.size > 0;
  if (working) return;
  if (byeAt && Date.now() - byeAt > BYE_EXIT_MS && lastPing < byeAt) process.exit(0);
  if (Date.now() - lastPing > IDLE_EXIT_MS) process.exit(0);
}, 5000);
