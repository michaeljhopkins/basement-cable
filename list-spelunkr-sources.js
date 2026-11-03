// Lists every archive.org file spelunkr.tv schedules, from its public channel data.
// Usage: node list-spelunkr-sources.js [outDir]     Downloads no video.
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve(process.argv[2] || path.join(__dirname, 'spelunkr-sources'));
const DATA = 'https://data.spelunkr.tv/';
const DOWNLOAD = 'https://archive.org/download/';
const COLUMNS = ['type', 'channel', 'dial', 'title', 'year', 'duration_s', 'archive_id', 'file', 'url', 'details_url', 'off_air', 'mature', 'in_s', 'out_s', 'slices'];
const AUDIO_FORMATS = ['VBR MP3', '128Kbps MP3', '64Kbps MP3'];

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};
const fileUrl = (id, file) => `${DOWNLOAD}${id}/${file.split('/').map(encodeURIComponent).join('/')}`;
const csvCell = (v) => (v === undefined || v === null ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function pickAudioFile(files) {
  for (const format of AUDIO_FORMATS) {
    const hit = files.find((f) => f.format === format);
    if (hit) return hit.name;
  }
  return (files.find((f) => f.name?.endsWith('.mp3')) || files.find((f) => f.format === 'Ogg Vorbis') || files.find((f) => f.name?.endsWith('.ogg')))?.name;
}

(async () => {
  const lineup = await getJson(`${DATA}lineup.json`);
  const rows = new Map();
  const pool = new Map();
  const add = (row) => {
    const key = `${row.type}|${row.channel}|${row.archive_id}|${row.file}`;
    const seen = rows.get(key);
    if (seen) seen.slices = (seen.slices || 1) + (row.slices || 1);
    else rows.set(key, row);
  };

  for (const ch of lineup.channels) {
    for (const version of ch.versions) {
      const m = await getJson(DATA + version.manifest);
      const base = { channel: ch.id, dial: ch.dial };
      for (const item of m.items) {
        const file = item.file || item.mp4;
        add({
          ...base, type: 'video', title: item.title, year: item.year, duration_s: item.duration,
          archive_id: item.id, file, off_air: item.offAir, mature: item.mature, in_s: item.inS, out_s: item.outS,
        });
      }
      for (const s of m.ads?.slices || []) {
        add({ ...base, type: 'ad-tape', title: s.tape, year: s.year, duration_s: Math.round((s.tapeMs || 0) / 1000), archive_id: s.tape, file: s.file, slices: 1 });
      }
      for (const tracks of Object.values(m.audioPools || {})) {
        for (const t of tracks) {
          const key = `${ch.id}|${t.id}`;
          if (!pool.has(key)) pool.set(key, { ...base, type: 'overlay-audio', title: `${t.artist} - ${t.title}`, duration_s: t.duration, archive_id: t.id });
        }
      }
    }
  }

  // Overlay music names only the item, so its file comes from archive.org's metadata.
  const resolved = new Map();
  const unresolved = [];
  for (const row of pool.values()) {
    if (!resolved.has(row.archive_id)) {
      try {
        const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(row.archive_id)}`);
        resolved.set(row.archive_id, pickAudioFile(meta.files || []) || null);
      } catch { resolved.set(row.archive_id, null); }
    }
    const file = resolved.get(row.archive_id);
    if (!file) unresolved.push(row.archive_id);
    add({ ...row, file: file || '' });
  }

  const all = [...rows.values()].map((r) => ({
    ...r,
    url: r.file ? fileUrl(r.archive_id, r.file) : '',
    details_url: `https://archive.org/details/${r.archive_id}`,
  }));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const csv = [COLUMNS.join(','), ...all.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\r\n');
  fs.writeFileSync(path.join(OUT_DIR, 'all-media.csv'), `﻿${csv}\r\n`);
  const urls = [...new Set(all.map((r) => r.url).filter(Boolean))].sort();
  fs.writeFileSync(path.join(OUT_DIR, 'urls.txt'), `${urls.join('\n')}\n`);

  const summary = { generatedAt: lineup.generatedAt, channels: lineup.channels.length, uniqueUrls: urls.length, unresolved: [...new Set(unresolved)], byType: {} };
  for (const r of all) {
    const t = summary.byType[r.type] ||= { rows: 0, urls: new Set(), items: new Set() };
    t.rows++;
    if (r.url) t.urls.add(r.url);
    t.items.add(r.archive_id);
  }
  for (const t of Object.values(summary.byType)) { t.urls = t.urls.size; t.items = t.items.size; }
  const videos = new Map(all.filter((r) => r.type === 'video').map((r) => [r.url, r.duration_s]));
  summary.videoHours = Math.round([...videos.values()].reduce((a, b) => a + (b || 0), 0) / 3600);
  summary.offAirRows = all.filter((r) => r.off_air).length;
  summary.matureRows = all.filter((r) => r.mature).length;
  summary.noDialChannels = lineup.channels.filter((c) => c.dial === undefined).map((c) => c.id);
  console.log(JSON.stringify(summary, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
