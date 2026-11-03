// Saves spelunkr.tv channels as stream-channels.json, so the player can stream them from archive.org.
// Usage: node build-stream-channels.js all | dial [dial ...]     Rerun to refresh the list.
const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'stream-channels.json');
const DATA = 'https://data.spelunkr.tv/';
const ALL = process.argv[2] === 'all';

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};
const fileUrl = (id, file) => `https://archive.org/download/${id}/${file.split('/').map(encodeURIComponent).join('/')}`;
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])(\w)/g, (m, a, b) => a + b.toUpperCase()).replace(/Tv\b/, 'TV').replace('Ovatv', 'OVA TV');

const decade = (year) => `${String(year).slice(0, 3)}0s`;

function pickAudioFile(files) {
  for (const format of ['VBR MP3', '128Kbps MP3', '64Kbps MP3']) {
    const hit = files.find((f) => f.format === format);
    if (hit) return hit.name;
  }
  return (files.find((f) => f.name?.endsWith('.mp3')) || files.find((f) => f.format === 'Ogg Vorbis') || files.find((f) => f.name?.endsWith('.ogg')))?.name;
}

// Overlay music names only the archive.org item, so its file comes from the item's metadata.
async function buildMusicPools(audioPools) {
  const files = new Map();
  const pools = {};
  for (const [name, tracks] of Object.entries(audioPools)) {
    pools[name] = [];
    for (const track of tracks) {
      if (!files.has(track.id)) {
        const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(track.id)}`).catch(() => ({}));
        files.set(track.id, pickAudioFile(meta.files || []));
      }
      const file = files.get(track.id);
      if (file) pools[name].push({ url: fileUrl(track.id, file), title: track.title, artist: track.artist, duration: track.duration });
      else console.warn(`No audio file found for ${track.id}`);
    }
  }
  return pools;
}

(async () => {
  const lineup = await getJson(`${DATA}lineup.json`);
  // Channels without a number are the site's dev and unlisted ones.
  const DIALS = ALL ? lineup.channels.map((c) => c.dial).filter(Boolean) : process.argv.slice(2).map(Number);
  if (!DIALS.length) throw new Error('Give "all" or at least one channel number');
  const channels = [];
  for (const dial of DIALS) {
    const ch = lineup.channels.find((c) => c.dial === dial);
    if (!ch) throw new Error(`No channel ${dial}`);
    const version = ch.versions[ch.versions.length - 1];
    const manifest = await getJson(DATA + version.manifest);
    const details = version.details ? await getJson(DATA + version.details) : { items: [] };
    const items = manifest.items.map((item, i) => {
      if (item.offAir) return null;
      const file = item.file || item.mp4;
      return {
        id: `${item.id}/${file}`,
        url: fileUrl(item.id, file),
        title: item.title,
        year: Number(item.year) || null,
        description: details.items[i]?.description || '',
        duration: item.duration,
        ...(item.inS ? { inS: item.inS } : {}),
        ...(manifest.audioPools ? { musicPool: manifest.audioPools[decade(item.year)] ? decade(item.year) : 'default' } : {}),
        direct: true,
      };
    }).filter(Boolean);
    const musicPools = manifest.audioPools ? await buildMusicPools(manifest.audioPools) : null;
    channels.push({ number: dial, name: titleCase(ch.name), items, ...(musicPools ? { musicPools } : {}) });
    const hours = items.reduce((sum, item) => sum + item.duration, 0) / 3600;
    console.log(`${dial} ${titleCase(ch.name)}: ${items.length} videos, ${hours.toFixed(0)} hours`);
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: lineup.generatedAt, channels }));
  console.log(`Wrote ${OUT_FILE}`);
})().catch((err) => { console.error(err); process.exit(1); });
