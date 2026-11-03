// Generates a small test library in ./sample-media, including formats that need converting.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, 'sample-media');
const SAMPLES = [
  ['02 Saturday Morning', 'Test Pattern Cartoons (1988).mp4', 90, 'testsrc2', 440, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
  ['02 Saturday Morning', 'Bars and Tone Show.mp4', 60, 'smptebars', 330, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']],
  ['08 Primetime', 'Matroska.Movie.1994.1080p.x264-GRP.mkv', 150, 'testsrc', 220, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3']],
  ['08 Primetime', 'Old Home Video.avi', 75, 'rgbtestsrc', 550, ['-c:v', 'mpeg4', '-c:a', 'mp3']],
  ['Late Nite', 'Web Clip.webm', 45, 'pal75bars', 660, ['-c:v', 'libvpx', '-b:v', '500k', '-c:a', 'libopus']],
];

for (const [folder, file, seconds, pattern, tone, codec] of SAMPLES) {
  const dir = path.join(ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, file);
  if (fs.existsSync(out)) continue;
  console.log(`Making ${folder}/${file}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `${pattern}=size=640x480:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`,
    ...codec, out], { stdio: 'inherit' });
}
fs.writeFileSync(path.join(ROOT, '02 Saturday Morning', 'Bars and Tone Show.txt'),
  'A beloved broadcast classic. Sits perfectly still and hums for one solid minute.');
console.log(`Done. Run: node server.js sample-media`);
