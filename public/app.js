// Every channel loops forever on a fixed clock. Anyone tuning in works out the
// current program and offset from the time alone, so all viewers stay in sync.
const EPOCH = Date.UTC(2024, 0, 1) / 1000;
const GUIDE_HOURS = 1.5; // the guide gets half the screen, so it shows three half-hour slots
const MERGE_UNDER = 10 * 60;
const MERGE_BLOCK = 60 * 60;
const STREAM_RETRY_MS = 8000;
const $ = (id) => document.getElementById(id);
const video = $('video');
const music = new Audio();

let channels = [];
let muted = false;
let musicUrl = null; // the track now loaded in the music element
let musicRetryTimer;
let clockSkew = 0;
let chan = null;
let current = null; // { item, base, src } now loaded in the video element
let triedLive = false;
let lastResync = 0;
let digits = '';
let digitTimer;
let osdTimer;
let retryTimer;
let view = 'landing';

const now = () => Date.now() / 1000 + clockSkew;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pad = (n) => String(n).padStart(2, '0');

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  return h ? `${h}:${pad(m)}:${pad(sec % 60)}` : `${m}:${pad(sec % 60)}`;
}
const fmtTime = (sec, opts) => new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...opts });

function prepare(list) {
  for (const ch of list) ch.total = ch.items.reduce((sum, item) => sum + item.duration, 0);
  return list;
}

function programAt(ch, t) {
  let pos = (t - EPOCH) % ch.total;
  if (pos < 0) pos += ch.total;
  for (let i = 0; i < ch.items.length; i++) {
    const item = ch.items[i];
    if (pos < item.duration) return { item, index: i, offset: pos, start: t - pos, end: t - pos + item.duration };
    pos -= item.duration;
  }
  return { item: ch.items[0], index: 0, offset: 0, start: t, end: t + ch.items[0].duration };
}

function programsBetween(ch, from, to) {
  const out = [];
  let { index, start } = programAt(ch, from);
  while (start < to && out.length < 500) {
    const item = ch.items[index];
    out.push({ item, start, end: start + item.duration });
    start += item.duration;
    index = (index + 1) % ch.items.length;
  }
  return out;
}

// Music pools loop on the same fixed clock as the programs, so viewers hear the same track.
function musicAt(t) {
  const pool = chan?.musicPools?.[current?.item.musicPool];
  if (!pool?.length) return null;
  const total = pool.reduce((sum, track) => sum + track.duration, 0);
  let pos = ((t - EPOCH) % total + total) % total;
  for (const track of pool) {
    if (pos < track.duration) return { track, offset: pos };
    pos -= track.duration;
  }
  return { track: pool[0], offset: 0 };
}

function stopMusic() {
  clearTimeout(musicRetryTimer);
  musicUrl = null;
  if (!music.getAttribute('src')) return;
  music.pause();
  music.removeAttribute('src');
  music.load();
}

function syncMusic() {
  const playing = musicAt(now());
  if (!playing) return stopMusic();
  if (playing.track.url !== musicUrl) {
    clearTimeout(musicRetryTimer);
    musicUrl = playing.track.url;
    music.src = musicUrl;
    music.play().catch(() => {});
  } else if (music.readyState >= 2 && !music.seeking && !music.ended) {
    if (Math.abs(music.currentTime - playing.offset) > 6) music.currentTime = playing.offset;
    if (music.paused) music.play().catch(() => {});
  }
}

function applyMute() {
  // Channels with their own music play over silent film.
  video.muted = muted || Boolean(chan?.musicPools);
  music.muted = muted;
  $('mute').textContent = muted ? 'UNMUTE' : 'MUTE';
}

function chanColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 38%)`;
}
function iconHtml(ch) {
  const letters = ch.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="chan-icon" style="background:${chanColor(ch.name)}">${esc(letters)}</span>`;
}

// TV static, drawn only while something is showing it.
const staticCanvases = [$('landing-static'), $('tv-static')].map((canvas) => ({ canvas, ctx: canvas.getContext('2d') }));
function drawStatic() {
  for (const { canvas, ctx } of staticCanvases) {
    if (!canvas.offsetParent || (canvas.id === 'tv-static' && !canvas.classList.contains('on'))) continue;
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  requestAnimationFrame(drawStatic);
}
const setStatic = (on) => $('tv-static').classList.toggle('on', on);

function loadProgram(useLive = false) {
  clearTimeout(retryTimer);
  const { item, offset } = programAt(chan, now());
  const live = useLive || !item.direct;
  current = { item, base: live ? offset : -(item.inS || 0), live };
  $('tape-error').hidden = true;
  setStatic(true);
  if (live) video.src = `/live/${item.id}?t=${offset.toFixed(2)}`;
  else video.src = item.url || `/media/${item.id}`;
  applyMute();
  video.play().catch(() => {});
  syncMusic();
  renderInfo();
  renderGuide();
}

function tune(ch) {
  if (!ch) return;
  chan = ch;
  triedLive = false;
  history.replaceState(null, '', `#ch=${ch.number}`);
  showOsd(`CH ${pad(ch.number)}`);
  loadProgram();
}

function showOsd(text) {
  const osd = $('osd');
  osd.textContent = text;
  osd.classList.add('on');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osd.classList.remove('on'), 2500);
}

function step(delta) {
  const i = channels.indexOf(chan);
  tune(channels[(i + delta + channels.length) % channels.length]);
}

function surf() {
  if (channels.length < 2) return;
  let next;
  do next = channels[Math.floor(Math.random() * channels.length)]; while (next === chan);
  tune(next);
}

video.addEventListener('loadedmetadata', () => {
  if (current && !current.live) video.currentTime = programAt(chan, now()).offset - current.base;
});
video.addEventListener('playing', () => setStatic(false));
video.addEventListener('waiting', () => { if (video.currentTime < 1 || current?.live) setStatic(true); });
video.addEventListener('ended', () => loadProgram());
video.addEventListener('error', () => {
  if (!video.getAttribute('src') || !current) return;
  if (!current.live && !triedLive && !current.item.url) {
    triedLive = true;
    return loadProgram(true);
  }
  $('tape-error').hidden = false;
  // Streams often fail briefly, and a tape can run for hours, so keep trying to rejoin it.
  if (current.item.url) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (chan) loadProgram(); }, STREAM_RETRY_MS);
  }
});

music.addEventListener('loadedmetadata', () => {
  const playing = musicAt(now());
  if (playing?.track.url === musicUrl) music.currentTime = playing.offset;
});
music.addEventListener('error', () => {
  if (!music.getAttribute('src')) return;
  clearTimeout(musicRetryTimer);
  musicRetryTimer = setTimeout(() => { musicUrl = null; syncMusic(); }, STREAM_RETRY_MS);
});

function tick() {
  $('clock').textContent = fmtTime(now(), { second: '2-digit' });
  if (!chan) return;
  syncMusic();
  const prog = programAt(chan, now());
  if (prog.item.id !== current?.item.id) {
    triedLive = false;
    loadProgram();
  } else if (!video.paused && video.readyState >= 2 && !video.seeking) {
    // Pull back to the broadcast after stalls or a sleeping laptop.
    const drift = Math.abs(current.base + video.currentTime - prog.offset);
    if (drift > 6 && Date.now() - lastResync > 15000) {
      lastResync = Date.now();
      if (current.live) loadProgram(true);
      else video.currentTime = prog.offset - current.base;
    }
  }
  $('info-elapsed').textContent = fmtDuration(prog.offset);
  $('info-duration').textContent = fmtDuration(prog.item.duration);
  $('info-bar').style.width = `${(prog.offset / prog.item.duration) * 100}%`;
}

function renderInfo() {
  if (!chan) return;
  const prog = programAt(chan, now());
  $('ch-label').textContent = `CH ${pad(chan.number)}`;
  $('info-icon').outerHTML = iconHtml(chan).replace('class="chan-icon"', 'class="chan-icon" id="info-icon"');
  $('info-name').textContent = chan.name;
  $('info-number').textContent = `CH ${pad(chan.number)}`;
  $('info-title').textContent = prog.item.title;
  $('info-desc').textContent = prog.item.description;
  $('info-next').innerHTML = programsBetween(chan, prog.end + 0.5, prog.end + 86400).slice(0, 2)
    .map((p) => `<li><time>${fmtTime(p.start)}</time><span>${esc(p.item.title)}</span></li>`).join('');
}

// Runs of short programs would be unreadable slivers, so they share one block.
function guideBlocks(programs) {
  const blocks = [];
  for (const p of programs) {
    const last = blocks[blocks.length - 1];
    const short = p.item.duration < MERGE_UNDER;
    if (short && last?.short && last.end - last.start < MERGE_BLOCK) {
      last.programs.push(p);
      last.end = p.end;
    } else {
      blocks.push({ start: p.start, end: p.end, short, programs: [p] });
    }
  }
  return blocks;
}

function renderGuide() {
  const halfHour = 1800;
  const from = Math.floor(now() / halfHour) * halfHour;
  const span = GUIDE_HOURS * 3600;
  const to = from + span;
  const pct = (t) => ((Math.max(t, from) - from) / span) * 100;
  const t = now();
  let marks = '';
  for (let m = from; m < to; m += halfHour) {
    marks += `<span style="left:${pct(m)}%">${fmtTime(m)}</span>`;
  }
  const rows = channels.map((ch, i) => {
    const blocks = guideBlocks(programsBetween(ch, from, to)).map((b) => {
      const left = pct(b.start);
      const width = pct(Math.min(b.end, to)) - left;
      const cur = t >= b.start && t < b.end ? ' current' : '';
      const single = b.programs.length === 1 ? b.programs[0].item : null;
      const name = single ? single.title : `${ch.name} Marathon`;
      const year = single?.year ? ` · ${single.year}` : '';
      const detail = single ? fmtDuration(single.duration) + year : `${b.programs.length} shows · ${fmtDuration(b.end - b.start)}`;
      return `<button class="prog${cur}" data-ch="${i}" style="left:${left}%;width:${width}%" title="${esc(name)} (${fmtTime(b.start)})">
        <b>${esc(name)}</b><small>${detail}</small></button>`;
    }).join('');
    return `<div class="row${ch === chan ? ' tuned' : ''}">
      <button class="side" data-ch="${i}"><span class="num">${pad(ch.number)}</span>${iconHtml(ch)}<span class="chan-name">${esc(ch.name)}</span></button>
      <div class="track">${blocks}<div class="now-line" style="left:${pct(t)}%"></div></div>
    </div>`;
  }).join('');
  $('guide').innerHTML = `<div class="ruler"><div class="side">CHANNEL</div><div class="track">${marks}</div></div>${rows}`;
}

function renderDirectory() {
  $('directory').innerHTML = `<div class="dir-grid">${channels.map((ch, i) => `
    <button class="dir-card" data-ch="${i}">${iconHtml(ch)}<span><b>${pad(ch.number)} ${esc(ch.name)}</b>
    <small>${ch.items.length} tape${ch.items.length === 1 ? '' : 's'} · ${fmtDuration(ch.total)}</small></span></button>`).join('')}</div>`;
}

function setView(next) {
  view = next;
  $('landing').hidden = next !== 'landing';
  $('app').hidden = next === 'landing';
  document.body.classList.toggle('watch', next === 'watch');
  $('guide').hidden = next !== 'guide';
  $('directory').hidden = next !== 'directory';
  for (const name of ['guide', 'watch', 'directory']) $(`nav-${name}`).classList.toggle('active', next === name);
  if (next === 'landing') {
    clearTimeout(retryTimer);
    video.pause();
    video.removeAttribute('src');
    video.load();
    current = null;
    chan = null;
    stopMusic();
  }
  if (next === 'directory') renderDirectory();
  if (next === 'guide') renderGuide();
}

function tuneIn() {
  if (!channels.length || view !== 'landing') return;
  const wanted = Number(new URLSearchParams(location.hash.slice(1)).get('ch'));
  setView('guide');
  tune(channels.find((c) => c.number === wanted) || channels[0]);
}

function renderLanding(lib) {
  const body = $('landing-body');
  if (channels.length) {
    const hours = channels.reduce((sum, c) => sum + c.total, 0) / 3600;
    const hoursText = hours >= 10 ? Math.round(hours).toLocaleString() : hours.toFixed(1);
    body.innerHTML = `<div class="stats">
        <div class="stat"><b>${channels.length}</b>CHANNELS</div>
        <div class="stat"><b>24/7</b>LIVE SYNC</div>
        <div class="stat"><b>${hoursText}</b>HOURS</div>
      </div>
      <button class="tune-in" id="tune-in">&#9654; TUNE IN</button>
      <div class="hint">or press any key.</div>`;
    $('tune-in').onclick = tuneIn;
  } else if (lib.ffprobeMissing) {
    body.innerHTML = `<div class="setup"><h2>FFMPEG NOT FOUND</h2>Install ffmpeg so ffprobe is on your PATH, then restart the server.</div>`;
  } else if (lib.scanning) {
    body.innerHTML = `<div class="setup"><h2>ADJUSTING THE ANTENNA…</h2>Reading tape ${lib.scanned} of ${lib.total}</div>`;
  } else {
    body.innerHTML = `<div class="setup"><h2>NO SIGNAL</h2>Add one folder per channel to:<br><code>${esc(lib.mediaDir)}</code>
      <pre>02 Saturday Morning\\cartoon.mp4
08 Primetime\\movie.mkv</pre>New videos appear within five minutes, or right away if you restart the server.</div>`;
  }
}

async function refresh() {
  let lib;
  try {
    lib = await (await fetch('/api/library')).json();
  } catch {
    return setTimeout(refresh, 5000);
  }
  clockSkew = (lib.serverTime - Date.now()) / 1000;
  channels = prepare(lib.channels);
  if (chan) {
    chan = channels.find((c) => c.number === chan.number) || channels[0] || null;
    if (chan) { renderInfo(); renderGuide(); }
  }
  if (view === 'landing') renderLanding(lib);
  setTimeout(refresh, !channels.length ? 2000 : 120000);
}

// Controls
$('home').onclick = () => setView('landing');
$('nav-guide').onclick = () => setView('guide');
$('nav-watch').onclick = () => setView('watch');
$('nav-directory').onclick = () => setView('directory');
$('ch-up').onclick = () => step(1);
$('ch-down').onclick = () => step(-1);
$('random').onclick = surf;
$('mute').onclick = toggleMute;
$('volume').oninput = (e) => { video.volume = music.volume = Number(e.target.value); muted = false; applyMute(); };
$('fullscreen').onclick = toggleFullscreen;
$('screen').ondblclick = toggleFullscreen;

function toggleMute() { muted = !muted; applyMute(); }
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('screen').requestFullscreen().catch(() => {});
}

// Click a channel to preview it; click it again to watch.
for (const panel of [$('guide'), $('directory')]) {
  panel.addEventListener('click', (e) => {
    const target = e.target.closest('[data-ch]');
    if (!target) return;
    const ch = channels[Number(target.dataset.ch)];
    if (ch === chan) setView('watch');
    else tune(ch);
    if (panel.id === 'directory') setView('watch');
  });
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (view === 'landing') {
    if (!['Tab', 'Shift', 'Escape'].includes(e.key)) tuneIn();
    return;
  }
  if (e.target.matches('input')) return;
  const key = e.key.toLowerCase();
  if (/^\d$/.test(key)) {
    digits += key;
    showOsd(`CH ${digits}`);
    clearTimeout(digitTimer);
    digitTimer = setTimeout(() => {
      const ch = channels.find((c) => c.number === Number(digits));
      digits = '';
      if (ch) tune(ch);
      else showOsd('NO CHANNEL');
    }, 1200);
  } else if (key === 'w' || key === 'arrowup') { e.preventDefault(); step(1); }
  else if (key === 's' || key === 'arrowdown') { e.preventDefault(); step(-1); }
  else if (key === 'r') surf();
  else if (key === 'm') toggleMute();
  else if (key === 'f') toggleFullscreen();
  else if (key === 'g') setView(view === 'guide' ? 'watch' : 'guide');
  else if (key === 'escape' && view === 'watch' && !document.fullscreenElement) setView('guide');
});

setInterval(tick, 1000);
setInterval(() => { if (chan && view === 'guide') renderGuide(); }, 30000);
drawStatic();
tick();
refresh();
