// Downloads spelunkr.tv channels from archive.org into the player's media folder,
// converted to early-90s TV quality: 4:3, 640x480, up to 29.97 fps, stereo.
// Usage: node download-channels.js [--plan] [--dest dir] [--budget-gb n] [--limit n] dial [dial ...]
// Takes turns between the channels until the budget runs out. Safe to stop and rerun.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const PLAN_ONLY = args.includes('--plan');
const MEDIA_DIR = path.resolve(option('--dest') || path.join(__dirname, 'media'));
const BUDGET_BYTES = Number(option('--budget-gb') || Infinity) * 1e9;
const LIMIT = Number(option('--limit')) || 0;
const DIALS = args.filter((a) => /^\d+$/.test(a)).map(Number);
const WORK_DIR = path.join(__dirname, '.cache', 'incoming');
const META_DIR = path.join(__dirname, '.cache', 'ia-meta');
const DATA = 'https://data.spelunkr.tv/';
const WORKERS = 2;
const MIN_LOCAL_FREE = 10e9;
const BUDGET_MARGIN = 5e9;
const CONVERTED_BYTES_PER_SEC = 0.6e9 / 3600;
const MAX_KEEP_BITRATE = 3e6;
const HEADERS = { 'User-Agent': 'basement-cable-personal-archive/1.0' };

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;
const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 150);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])(\w)/g, (m, a, b) => a + b.toUpperCase());
const fileUrl = (id, file) => `https://archive.org/download/${id}/${file.split('/').map(encodeURIComponent).join('/')}`;

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
      await sleep(3000 * 2 ** attempt);
    }
  }
}

async function itemMeta(id) {
  const cached = path.join(META_DIR, `${crypto.createHash('sha1').update(id).digest('hex')}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf8'));
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  const slim = (meta.files || []).map((f) => ({ name: f.name, size: Number(f.size) || 0, width: Number(f.width) || 0, height: Number(f.height) || 0 }));
  fs.writeFileSync(cached, JSON.stringify(slim));
  return slim;
}

async function buildJobs(lineup) {
  const jobs = [];
  const skipped = [];
  for (const dial of DIALS) {
    const ch = lineup.channels.find((c) => c.dial === dial);
    if (!ch) throw new Error(`No channel ${dial}`);
    const version = ch.versions[ch.versions.length - 1];
    const manifest = await getJson(DATA + version.manifest);
    const details = version.details ? await getJson(DATA + version.details) : { items: [] };
    const folder = `${String(ch.dial).padStart(2, '0')} ${titleCase(ch.name)}`;
    const used = new Set();
    manifest.items.forEach((item, i) => {
      if (item.offAir) return skipped.push(`${folder}: ${item.title}`);
      const base = safeName(item.title) || item.id;
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      used.add(name.toLowerCase());
      jobs.push({
        id: item.id, file: item.file || item.mp4, folder, name, duration: item.duration,
        inS: item.inS, outS: item.outS, description: details.items[i]?.description || '',
        final: path.join(MEDIA_DIR, folder, `${name}.mp4`),
        key: crypto.createHash('sha1').update(`${folder}/${name}`).digest('hex').slice(0, 16),
      });
    });
  }
  return { jobs, skipped };
}

// Takes one video from each channel in turn, so the budget is shared between them.
function alternate(jobs) {
  const channels = new Map();
  for (const job of jobs) {
    if (!channels.has(job.folder)) channels.set(job.folder, []);
    channels.get(job.folder).push(job);
  }
  const out = [];
  while (out.length < jobs.length) {
    for (const list of channels.values()) {
      if (list.length) out.push(list.shift());
    }
  }
  return out;
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8e6 }, (err, out) => {
      if (err) return reject(err);
      resolve(JSON.parse(out));
    });
  });
}

const ratio = (s, fallback = 1) => {
  const [a, b] = String(s || '').split(/[:/]/).map(Number);
  return a > 0 && b > 0 ? a / b : fallback;
};

// Crops wider pictures to 4:3 from the center and pads narrower ones.
function videoFilter(v) {
  const sar = ratio(v.sample_aspect_ratio);
  const shown = (v.width * sar) / v.height;
  const fps = ratio(v.avg_frame_rate, 30);
  const f = ['yadif=deint=interlaced'];
  if (shown > 4 / 3 + 0.02) f.push(`crop=${Math.round((v.height * 4) / 3 / sar / 2) * 2}:${v.height}`);
  if (shown < 4 / 3 - 0.02) f.push('scale=640:480:force_original_aspect_ratio=decrease', 'pad=640:480:(ow-iw)/2:(oh-ih)/2');
  else f.push('scale=640:480');
  f.push('setsar=1');
  if (fps > 30.5) f.push('fps=30000/1001');
  return f.join(',');
}

function alreadyGood(job, source, info, v, a) {
  if (job.inS || job.outS || path.extname(source).toLowerCase() !== '.mp4') return false;
  const shown = (v.width * ratio(v.sample_aspect_ratio)) / v.height;
  return v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && v.height <= 480
    && Math.abs(shown - 4 / 3) <= 0.02 && ratio(v.avg_frame_rate, 30) <= 30.5
    && (!a || ['aac', 'mp3'].includes(a.codec_name)) && Number(info.format.bit_rate) <= MAX_KEEP_BITRATE;
}

function convert(job, source, target, info, v, a) {
  return new Promise((resolve, reject) => {
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (job.inS) ffArgs.push('-ss', String(job.inS));
    if (job.outS) ffArgs.push('-to', String(job.outS));
    ffArgs.push('-i', source, '-map', '0:v:0', '-vf', videoFilter(v), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p');
    if (a) ffArgs.push('-map', '0:a:0', '-c:a', 'aac', '-ac', '2', '-b:a', '128k');
    ffArgs.push('-movflags', '+faststart', target);
    const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errText = '';
    ff.stderr.on('data', (d) => { errText = (errText + d).slice(-1000); });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${errText}`))));
  });
}

async function download(url, dest, expected) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (expected && have === expected) return;
    try {
      const res = await fetch(url, { headers: { ...HEADERS, ...(have ? { Range: `bytes=${have}-` } : {}) } });
      if (![200, 206].includes(res.status)) throw new Error(`HTTP ${res.status}`);
      const out = fs.createWriteStream(dest, { flags: res.status === 206 ? 'a' : 'w' });
      try {
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (!expected || fs.statSync(dest).size === expected) return;
      throw new Error('size mismatch');
    } catch (err) {
      log(`  retry ${attempt + 1}: ${err.message}`);
      await sleep(5000 * 2 ** attempt);
    }
  }
  throw new Error('download failed after retries');
}

// Copies under a temporary name so a dropped connection never leaves a half-written video.
async function deliver(from, final) {
  const part = `${final}.part`;
  await fs.promises.copyFile(from, part);
  if (fs.statSync(part).size !== fs.statSync(from).size) throw new Error('copy size mismatch');
  fs.renameSync(part, final);
  fs.rmSync(from);
}

function folderBytes(dir) {
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    sum += e.isDirectory() ? folderBytes(abs) : fs.statSync(abs).size;
  }
  return sum;
}

async function processJob(job) {
  const source = path.join(WORK_DIR, `${job.key}${path.extname(job.file) || '.mp4'}`);
  const temp = path.join(WORK_DIR, `${job.key}.converting.mp4`);
  await download(fileUrl(job.id, job.file), source, job.size);
  const info = await ffprobe(source);
  const v = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream');
  fs.mkdirSync(path.dirname(job.final), { recursive: true });
  if (job.description) fs.writeFileSync(`${job.final.slice(0, -4)}.txt`, job.description);
  if (alreadyGood(job, source, info, v, a)) {
    await deliver(source, job.final);
    return 'kept as is';
  }
  await convert(job, source, temp, info, v, a);
  await ffprobe(temp);
  await deliver(temp, job.final);
  fs.rmSync(source);
  return `converted from ${v.width}x${v.height}`;
}

(async () => {
  if (!DIALS.length) throw new Error('Give at least one channel number');
  for (const dir of [MEDIA_DIR, WORK_DIR, META_DIR]) fs.mkdirSync(dir, { recursive: true });
  const lineup = await getJson(`${DATA}lineup.json`);
  const { jobs, skipped } = await buildJobs(lineup);

  const shapes = {};
  const missing = [];
  let total = 0;
  for (const job of jobs) {
    const f = (await itemMeta(job.id)).find((x) => x.name === job.file);
    if (!f) { missing.push(job); continue; }
    job.size = f.size;
    total += f.size;
    const shape = f.height ? `${f.height <= 480 ? 'up to 480' : f.height <= 720 ? 'up to 720' : 'over 720'} lines, ${Math.abs(f.width / f.height - 4 / 3) < 0.03 ? '4:3' : 'other shape'}` : 'unknown';
    shapes[shape] = (shapes[shape] || 0) + 1;
  }
  const hours = jobs.reduce((sum, j) => sum + ((j.outS || j.duration) - (j.inS || 0)), 0) / 3600;
  const byFolder = {};
  for (const j of jobs) byFolder[j.folder] = (byFolder[j.folder] || 0) + 1;
  const localFree = () => {
    const s = fs.statfsSync(WORK_DIR);
    return s.bavail * s.bsize;
  };
  log(`${jobs.length} videos, ${hours.toFixed(0)} hours, ${gb(total)} of originals, ${gb(localFree())} free for temporary files`);
  log(`Largest original: ${gb(Math.max(...jobs.map((j) => j.size || 0)))}. Skipping ${skipped.length} off-air, ${missing.length} not found on archive.org`);
  log(`Channels: ${JSON.stringify(byFolder)}`);
  log(`Source shapes: ${JSON.stringify(shapes)}`);
  if (PLAN_ONLY) return;

  let queue = alternate(jobs.filter((j) => !missing.includes(j) && !fs.existsSync(j.final)));
  log(`${jobs.length - missing.length - queue.length} already done, ${queue.length} to go`);
  if (LIMIT) queue = queue.sort((a, b) => a.size - b.size).slice(0, LIMIT);
  let used = folderBytes(MEDIA_DIR);
  log(`Destination ${MEDIA_DIR} holds ${gb(used)} of a ${gb(BUDGET_BYTES)} budget`);
  let done = 0;
  let failed = 0;
  let overBudget = 0;
  let tooBig = 0;
  let reservedBudget = 0;
  let reservedLocal = 0;
  let active = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (queue.length) {
      const job = queue[0];
      const seconds = (job.outS || job.duration) - (job.inS || 0);
      const estimate = Math.min(job.size, seconds * CONVERTED_BYTES_PER_SEC);
      if (used + reservedBudget + estimate > BUDGET_BYTES - BUDGET_MARGIN) {
        queue.shift();
        overBudget++;
        log(`Over budget, skipping ${job.folder} / ${job.name} (about ${gb(estimate)})`);
        continue;
      }
      const localNeed = job.size + estimate;
      if (localFree() - reservedLocal - localNeed < MIN_LOCAL_FREE) {
        if (active) {
          await sleep(30000);
          continue;
        }
        queue.shift();
        tooBig++;
        log(`Not enough temporary space for ${job.folder} / ${job.name} (${gb(localNeed)})`);
        continue;
      }
      queue.shift();
      active++;
      reservedBudget += estimate;
      reservedLocal += localNeed;
      log(`Start ${job.folder} / ${job.name} (${gb(job.size)})`);
      try {
        const result = await processJob(job);
        used += fs.statSync(job.final).size;
        log(`Done ${job.folder} / ${job.name}: ${result}, ${gb(fs.statSync(job.final).size)} [${++done} done, ${queue.length} left, ${gb(used)} used]`);
      } catch (err) {
        failed++;
        log(`FAILED ${job.folder} / ${job.name}: ${err.message}`);
      } finally {
        active--;
        reservedBudget -= estimate;
        reservedLocal -= localNeed;
      }
    }
  }));
  log(`Finished: ${done} done, ${failed} failed, ${overBudget} over budget, ${tooBig} too big for temporary space, ${gb(used)} used. Rerun to retry failures and continue.`);
})().catch((err) => { console.error(err); process.exit(1); });
