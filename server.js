#!/usr/bin/env node
// Basement Cable: turns folders of videos into always-on TV channels.
// Usage: node server.js [mediaDir]     Env: PORT (8420), HOST (127.0.0.1)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const MEDIA_DIR = path.resolve(process.argv[2] || process.env.MEDIA_DIR || path.join(__dirname, 'media'));
const PORT = Number(process.env.PORT) || 8420;
const HOST = process.env.HOST || '127.0.0.1';
const CACHE_FILE = path.join(__dirname, '.cache', 'probe.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Spelunkr's channels, then the archive.org search channels. The first file to claim a number keeps it.
const STREAM_FILES = ['stream-channels.json', 'archive-channels.json'].map((f) => path.join(__dirname, f));
const RESCAN_MS = 5 * 60 * 1000;
const PROBE_WORKERS = 4;

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.ts', '.flv', '.ogv', '.3gp', '.vob']);
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };
const SAFE_VIDEO = { '.mp4': ['h264', 'av1'], '.m4v': ['h264', 'av1'], '.webm': ['vp8', 'vp9', 'av1'] };
const SAFE_AUDIO = ['aac', 'mp3', 'opus', 'vorbis'];

const library = { channels: [], scanning: false, scanned: 0, total: 0, ffprobeMissing: false };
const files = new Map(); // id -> { abs, ext, copyVideo }
const remotes = new Map(); // id -> archive.org videos that need converting, in the same shape
let probeCache = {};
try { probeCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch {}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(abs);
  }
  return out;
}

function probe(abs) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs],
      { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          if (err.code === 'ENOENT') library.ffprobeMissing = true;
          return resolve({ bad: true, missing: err.code === 'ENOENT' });
        }
        try {
          const info = JSON.parse(stdout);
          const v = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
          const a = info.streams.find((s) => s.codec_type === 'audio');
          const duration = Number(info.format.duration);
          if (!v || !(duration > 0)) return resolve({ bad: true });
          resolve({ duration, vcodec: v.codec_name, pix: v.pix_fmt, acodec: a?.codec_name || null });
        } catch { resolve({ bad: true }); }
      });
  });
}

// Turns "Show.Name.S01E02.1080p.x264-GRP" into a readable title and year.
function parseTitle(file) {
  let name = path.basename(file, path.extname(file));
  if (!/\s/.test(name)) name = name.replace(/[._]+/g, ' ');
  name = name.replace(/[\[(]?\b(480p|576p|720p|1080p|2160p|4k|x264|x265|h264|h265|hevc|bluray|web-?dl|webrip|dvdrip|hdtv|xvid)\b.*$/i, '').trim();
  const m = name.match(/[(\s]((?:19|20)\d\d)\)?\s*$/) || name.match(/\(((?:19|20)\d\d)\)/);
  return { title: name.replace(/[\s\-_]+$/, '') || path.basename(file), year: m ? Number(m[1]) : null };
}

function readDescription(abs) {
  try {
    return fs.readFileSync(abs.slice(0, -path.extname(abs).length) + '.txt', 'utf8').trim().slice(0, 2000);
  } catch { return ''; }
}

function isDirect(ext, p) {
  return (SAFE_VIDEO[ext] || []).includes(p.vcodec)
    && (p.pix === 'yuv420p' || p.vcodec !== 'h264')
    && (!p.acodec || SAFE_AUDIO.includes(p.acodec));
}

function readStreamChannels() {
  return STREAM_FILES.flatMap((file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).channels;
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not read ${path.basename(file)}:`, err.message);
      return [];
    }
  });
}

async function scan() {
  if (library.scanning) return;
  library.scanning = true;
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const folders = fs.readdirSync(MEDIA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const jobs = [];
    for (const folder of folders) {
      for (const abs of walk(path.join(MEDIA_DIR, folder))) jobs.push({ folder, abs });
    }
    library.total = jobs.length;
    library.scanned = 0;

    const nextCache = {};
    let cursor = 0;
    await Promise.all(Array.from({ length: PROBE_WORKERS }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        const stat = fs.statSync(job.abs);
        const key = `${job.abs}|${stat.size}|${stat.mtimeMs}`;
        job.probe = probeCache[key] || await probe(job.abs);
        if (!job.probe.missing) nextCache[key] = job.probe;
        if (job.probe.bad && !job.probe.missing) console.warn(`Skipping unreadable video: ${job.abs}`);
        library.scanned++;
      }
    }));
    probeCache = nextCache;
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(probeCache));

    const used = new Set();
    const parsed = folders.map((folder) => {
      const m = folder.match(/^(\d+)[\s._-]+(.+)$/);
      if (m) used.add(Number(m[1]));
      return { folder, number: m ? Number(m[1]) : null, name: m ? m[2] : folder };
    });
    let auto = 2;
    const channels = [];
    files.clear();
    for (const p of parsed) {
      const dir = path.join(MEDIA_DIR, p.folder);
      const inOrder = fs.existsSync(path.join(dir, '.inorder'));
      const items = jobs.filter((j) => j.folder === p.folder && !j.probe.bad).map((j) => {
        const rel = path.relative(MEDIA_DIR, j.abs);
        const id = hash(rel).slice(0, 16);
        const ext = path.extname(j.abs).toLowerCase();
        files.set(id, {
          abs: j.abs, ext,
          copyVideo: j.probe.vcodec === 'h264' && j.probe.pix === 'yuv420p',
          hasAudio: !!j.probe.acodec,
        });
        return { id, rel, ...parseTitle(j.abs), description: readDescription(j.abs), duration: j.probe.duration, direct: isDirect(ext, j.probe) };
      });
      if (!items.length) continue;
      // The same order every time, so a channel's schedule survives server restarts.
      if (inOrder) items.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
      else items.sort((a, b) => hash(p.name + a.rel).localeCompare(hash(p.name + b.rel)));
      let number = p.number;
      if (number === null) {
        while (used.has(auto)) auto++;
        number = auto;
        used.add(number);
      }
      channels.push({ number, name: p.name, items: items.map(({ rel, ...item }) => item) });
    }
    const streams = [];
    for (const ch of readStreamChannels()) {
      const taken = channels.find((c) => c.number === ch.number) || streams.find((c) => c.number === ch.number);
      if (taken) console.warn(`Channel ${ch.number} ${ch.name} is skipped because ${taken.name} already uses that number`);
      else streams.push(ch);
    }
    remotes.clear();
    for (const item of streams.flatMap((ch) => ch.items)) {
      if (item.convert) remotes.set(item.id, { abs: item.url, hasAudio: true, copyVideo: false });
    }
    library.channels = [...channels, ...streams].sort((a, b) => a.number - b.number);
    console.log(`Scanned ${MEDIA_DIR}: ${channels.length} local channels, ${files.size} videos, ${streams.length} streamed channels`);
  } catch (err) {
    console.error('Scan failed:', err.message);
  } finally {
    library.scanning = false;
  }
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function serveFile(req, res, abs, type, cache = 'no-cache') {
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = stat.size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
      else start = Math.max(0, stat.size - Number(m[2]));
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    }
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

// Copied video can only start on a keyframe. Seeking audio to the same point keeps the two together.
function keyframeBefore(abs, t) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time', '-of', 'csv=p=0',
      '-read_intervals', `${Math.max(0, t - 60)}%${t + 0.1}`, abs],
      { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        const times = err ? [] : stdout.split(/\r?\n/).map(parseFloat).filter((n) => n <= t);
        resolve(times.length ? times[times.length - 1] : t);
      });
  });
}

// Converts formats browsers can't play as they're watched, starting from offset t.
async function serveLive(res, file, t) {
  if (file.copyVideo && t > 0) t = await keyframeBefore(file.abs, t) + 0.01;
  if (res.destroyed) return;
  // Streams from archive.org can drop mid-show, so ffmpeg picks the download back up.
  const input = /^https?:/.test(file.abs) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10'] : [];
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(t), ...input, '-i', file.abs, '-map', '0:v:0'];
  if (file.hasAudio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-ac', '2', '-b:a', '160k');
  if (file.copyVideo) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', "scale=-2:'min(1080,ih)'");
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.on('error', (err) => {
    console.error('ffmpeg failed to start:', err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  ff.stderr.on('data', (d) => console.error(`ffmpeg: ${String(d).trim()}`));
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL'));
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const [, route, id] = url.pathname.split('/');

  if (url.pathname === '/api/library') {
    return sendJson(res, { ...library, mediaDir: MEDIA_DIR, serverTime: Date.now() });
  }
  if (route === 'media') {
    const file = files.get(id);
    if (!file || !MIME[file.ext]) return notFound(res);
    return serveFile(req, res, file.abs, MIME[file.ext], 'public, max-age=3600');
  }
  if (route === 'live') {
    const file = files.get(id) || remotes.get(id);
    if (!file) return notFound(res);
    const t = Number(url.searchParams.get('t'));
    return serveLive(res, file, Number.isFinite(t) && t > 0 ? t : 0);
  }
  const asset = STATIC[url.pathname];
  if (asset) return serveFile(req, res, path.join(PUBLIC_DIR, asset[0]), asset[1]);
  notFound(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Basement Cable is on the air at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Media folder: ${MEDIA_DIR}`);
  scan();
  setInterval(scan, RESCAN_MS);
});
