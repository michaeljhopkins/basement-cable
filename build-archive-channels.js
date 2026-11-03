// Builds themed channels from hand-picked archive.org items and saves them as archive-channels.json.
// Usage: node build-archive-channels.js [number ...]     Rerun to refresh. Edit CHANNELS to change the lineup.
// Item IDs are the part after archive.org/details/. Searching archive.org by title pulls in too much
// that isn't the show (movies, game playthroughs, dubs, remakes), so every item here was checked by hand.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const OUT_FILE = path.join(__dirname, 'archive-channels.json');
const PROBE_CACHE = path.join(__dirname, '.cache', 'archive-probe.json');

// "Broadcasts" are off-air recordings of the real block, commercials and bumpers included.
const CHANNELS = [
  {
    number: 3, name: 'TGIF',
    shows: {
      Broadcasts: ['TGIF_1991-04-26', 'abc-tgif-01-11-1991-full-house-family-matters-perfect-strangers-going-places', 'abc-tgif-09-27-1991-family-matters-step-by-step-perfect-strangers-baby-talk',
        'abc-tgif-10-25-1991-family-matters-step-by-step-dinosaurs-baby-talk', '20250415_20250415_0854', 'dvd-transfer-188', 'tgif-93', 'tgif-boy-meets-world-step-by-step-december-1993-merged',
        '1993-tgif-family-matters-step-by-step-george-hangin-with-mr.-cooper', '1994-tgif-family-matters-bmw-step-by-step-hangin-with-mr.-cooper-converted',
        'abc-tgif-12-13-96-family-matters-boy-meets-world-lily-tomlin-hosts-woc', 'TGIF_ABC_WOC_1997-05-09', '20240819_20240819_2328', '1997-11-07-the-tgif-time-warp',
        'my-vhs-saga-part-4-woc', 'TGIF_ABC_WOC_1998-12-11', 'abc-tgif-woc-11061998', 'abc-tgif-woc-10.29.1999', 'abc-tgif-1.07.2000'],
      'Full House': ['full-house-lizzie', 's-1.-ep-1-full-house-episode-1', 's-1.-ep-11-full-house-episode-11', 's-1.-ep-12-full-house-episode-12', 's-1.-ep-13-full-house-episode-13',
        's-1.-ep-14-full-house-episode-14', 's-1.-ep-15-full-house-episode-15'],
      'Step by Step': ['5x22WereGoingToDisneyWorld1'],
      'Perfect Strangers': ['perfect-strangers-Lando18'],
      "Hangin' with Mr. Cooper": ['mrcoopers'],
      'Just the Ten of Us': ['just-the-ten-of-us-1988-90'],
      'Late-90s TGIF': ['Aliens-in-the-Family', 'teen-angel-1997-1998', 'you-wish-1997-1998', 'Brothers_Keeper_ABC_Rarities', 'Muppets-Tonight-1996'],
    },
  },
  {
    number: 4, name: 'SNICK',
    shows: {
      Broadcasts: ['snick-premiere-08-15-92', 'snick-09-19-92', 'snick-sep-19-1992', 'snick-12-26-92', 'dvd_Snick_-_5-22-93_-_WOC', 'snick-1993', 'snick-10-02-93', 'snick-october-1993',
        'snick-or-treat-1993', 'snick-11-06-93', 'snick03121994', 'snick-04-09-94', 'snick-06-04-94', 'snick-08-06-94', 'snick-09-03-94', 'snick-11-05-94', 'snick-12-03-94',
        'nickelodeonsnickthanksgiving1997', 'snick-january-3-1998', 'vts-01-1_20260516_0606'],
      'Are You Afraid of the Dark?': ['are-you-afraid-of-the-dark-1992'],
      'The Ren & Stimpy Show': ['the-ren-and-stimpy-show-season-3', 'the-ren-and-stimpy-show-season-5', 'the-classics_202205', 'classics-ii', 'in-disguise', 'the-stinkiest-stories',
        'the-stupidest-stories', 'on-duty', 'more-stinky-stories', 'incredibly-stupid-stories', 'nothing-but-shorts', 'as-stinky-as-they-wanna-be'],
      'The Secret World of Alex Mack': ['secret-world-of-alex-mack'],
      'All That': ['season-2-episode-all-that-partial-series-proper'],
      'Kenan & Kel': ['kenan-and-kel-season-4-episode-10-oh-brother_480'],
      'The Amanda Show': ['the-amanda-show'],
      'The Adventures of Pete & Pete': ['adventures-of-pete-and-pete-1992', 'adventures-of-pete-and-pete-season-3'],
      Roundhouse: ['RoundhouseMaterialismS3E7', 'RoundhouseAgeS3E9', 'RoundhouseLoveS3E10', 'RoundhouseRightsS3E11'],
      "Rocko's Modern Life": ['rockos-modern-life_202412', 'rockos-modern-life-season-2'],
    },
  },
  {
    number: 5, name: 'Hanna-Barbera',
    shows: {
      Broadcasts: ['hanna-barbera-mostly-ghostly-halloween-vhs-1991', '1990-nick-looney-toons-yogi-underdog-muppet-babies', 'cartoonnetworkjanuary2000',
        'boomerang-on-cartoon-network-special-presentation-feat.-yogi-bear-boomeraction-etc-april-2002', 'boomerang-02-05-2011', 'boomerang-quick-draw-mc-graw-block-360p_202610',
        'Quick-draw-mcgraw-show-airing-metv-toons', 'hong-kong-phooey-airing-metv-toons-complete', 'Yogi_Bear_Christmas_WOC_1988_Last_Half'],
      'The Flintstones': ['the-flintstones-s-06-e-01-no-biz-like-show-biz', 'the-flintstones-1961-10-20', 'fun-with-the-flintstones-1993-uk-vhs', 'the-flintstones-the-flintstone-flyer-1985-uk-vhs'],
      'The Jetsons': ['the-jetsons-episode-3-jetsons-nite-out-watch-cartoons-onl', '9-elroys-tv-show'],
      'Scooby-Doo': ['scooby-doo-mine-your-own-business_202602', '20240727_20240727_0523'],
      'Yogi Bear': ['01-yogi-bear-december-1-2013-5am-est', 'hey-there-its-yogi-bear-1985-uk-vhs'],
      'Huckleberry Hound': ['huckleberry-hound-full-1986-kids-klassics-vhs', 'favoritecolorfridayshuckhound'],
      'Jonny Quest': ['1964-abc-primetime'],
      'Space Ghost and Dino Boy': ['space-ghost-and-dino-boy-complete-series-dvdrip-dolby-digital'],
      'Top Cat': ['top-cat-s-01-e-27-dibble-breaks-the-rec'],
      'Wacky Races': ['16.-the-wrong-lumber-race'],
      'The Smurfs': ['the-smurfs-1981_202601'],
      Jabberjaw: ['jabberjaw_complete_collection'],
      'Hong Kong Phooey': ['hong-kong-phooey-s-01-e-08-mirror-mirror-on-the-wall-great-movie-mystery'],
      'Super Friends': ['super-friends-1973-season-1', 'attack-of-the-legion-of-doom', 'the-all-new-super-friends-hour-space-emergency'],
      'Magilla Gorilla': ['magillagorillas1', 'magillagorillas2'],
    },
  },
  {
    number: 6, name: 'Disney Afternoon',
    shows: {
      Broadcasts: ['1989-03-26_NBC_Super_DuckTales', '1990-11-16-the-disney-afternoon-gummi-bears-duck-tales-rescue-rangers-tale-spin-', 'talespin-darkwing-duck-disney-afternoon-1991',
        '1991-06-xx-gummi-bears-for-whom-the-spell-holds-tale-spin-stormy-weather-fox-kvv', '1992-04-disney-afternoon-talespin-darkwing-duck_202505',
        '1992-07_Disney_Afternoon_-_Duck_Tales__Rescue_Rangers__TaleSpin', '20250705_20250705_1631', 'Goof_Troop_TV38_WSBK_And_ABC_WOC_1993-03', '20240817_20240817_0503',
        '2_Edes_of_Gargoyles_Disney_Afternoon_WOC_1994-11', 'Gargoyles_Disney_Afternoon_WOC_1995-02-03', 'the-disney-afternoon-weekday-afternoon-cartoons-1990s-full-episodes-with-commercials',
        'witcheroo-vhs', 'boo-busters-vhs'],
      DuckTales: ['Ducktales-Complete-Series'],
      "Chip 'n Dale Rescue Rangers": ['chip-n-dale-rescue-rangers-undercover-critters-1989-vhs', 'vintage-vhs-walt-disney-chip-n-dale-rescue-rangers-double-trouble'],
      TaleSpin: ['tale-spin-1990-complete-series'],
      'Adventures of the Gummi Bears': ['gummi-bears-s-01-e-09-a-gummi-by-any-other-name', 'gummi-bears-s-02-e-12-my-gummi-lies-over-the-ocean', 'gummi-bears-s-03-e-07-day-of-the-beevilweevils',
        'gummi-bears-s-04-e-15-top-gum', 'gummi-bears-s-05-e-11-beg-burrow-and-steal', 'gummi-bears-s-06-e-19-wings-over-dunwyn'],
      'Goof Troop': ['dvd-transfer-230', 'GoofTroopPistolgeistS2E6_201906'],
      Gargoyles: ['gargoyles_202212'],
      Bonkers: ['disney-bonkers-season-1', 'disney-bonkers-season-2', 'disney-bonkers-season-3'],
      'Quack Pack': ['quack-pack-full-series'],
    },
  },
  {
    number: 7, name: 'Fox Kids',
    shows: {
      Broadcasts: ['fox-kids-1992-3-vhs-off-airs-woc', '1993-fox-kids-christmas-peter-pan-dog-city-droopy-bobby-eek-tiny-toons-taz-mania-super-dave', '1993-12-25_Fox_Kids_Block',
        '20250412_20250412_0744', 'X-Men_Fox_Kids_WOC_1994-09', 'Power_Rangers_Fox_Kids_WOC_1994-09-13_to_26', 'Power_Rangers_Fox_Kids_WOC_1994-11-15_to_22',
        'Fox_Kids_Animaniacs_WOC_1994-12', 'ocwoc-004-animaniacs-where-on-earth-is-carmen-sandiego-x-men-captain-planet-1994', '20241211_20241211_0357', 'VHSFoxMMPRWOC', 'fox-kids',
        '1995-09-16_Fox_Kids_Masked_Rider__Tenko_and_the_Guardians_of_Magic__Spider-Man__', '1995-12-23_FOX_Kids__Kids_WB_Christmas_-_Mumfie__Carmen__Power_Rangers__Eek__Mas',
        'fox-kids-saturday-morning-cartoons-1996-full-episodes-with-commercials', '1996-12-21_Fox_Kids_Christmas_-_C-Bear_and_Jamal__Big_Bad_Beetleborgs__Spider-Ma',
        'fox-29-wtxf-fox-kids-september-1997-spiderman-goosebumps-chimp-lip-theater-x-man', 'VTS011_201807'],
      'X-Men': ['x-men_1992_720p_english'],
      'Batman: The Animated Series': ['Batman_The_Animated_Series_1992-1995'],
      'Mighty Morphin Power Rangers': ['mighty-morphin-power-rangers-season-1', 'mighty-morphin-power-rangers-season-2'],
      Goosebumps: ['GTVSeries1995'],
      'Eek! The Cat': ['eekthecats01e01misereekextendedcut'],
      'Spider-Man': ['spider-mantheanimatedseries'],
      "Bobby's World": ['bobbysworlds1ep11insearchoftheringbear480x640_201911'],
      'Tiny Toon Adventures': ['tiny-toon-adventures-1990-1995_202512'],
      Animaniacs: ['animaniacs-1993-1998-movie_202601'],
      'The Tick': ['the-tick-1994-animated-complete'],
    },
  },
  {
    number: 10, name: 'Cartoon Cartoons',
    shows: {
      Broadcasts: ['vts-01-1_20250808_0319', 'vts-01-2_20250321', 'ccf-november-19-and-26-1999-new-mike-lu-and-og-courage-johnny-bravo-imw', 'Powerpuff_Girls_Cartoon_Network_WOC_2000-02',
        'CCF-2000', 'vts-01-1_20250815_1716', 'vts-01-1_20250613_0455', 'vts-01-1_20250221', 'cartoon-cartoon-fridays-mayor-hosts-november-24-2000-full-broadcast-tape',
        '20250404_20250404_0259', 'vts-01-1_20250711_1156', 'vts-01-1_20250411', 'vts-01-1_20250704', 'vts-01-4_20250314', 'vts-01-1_20250725',
        'cartoon-cartoon-fridays-2001-2002-full-episodes-with-commercials'],
      "Dexter's Laboratory": ['dexters-laboratory-the-complete-series'],
      'The Powerpuff Girls': ['the-powerpuff-girls-1998-the-complete-series'],
      'Johnny Bravo': ['s-01-e-01-super-duped-bungled-in-the-jungle-bearly-enough-time'],
      'Cow and Chicken': ['s-01-e-04-confused-the-molting-fairy-i.-r.-gentlemans'],
      'Ed, Edd n Eddy': ['ed-edd-n-eddy-full-series-1999-2009'],
      'Courage the Cowardly Dog': ['s-1-e-03-.-courage-meets-big-foot-hothead'],
      'I Am Weasel': ['s-01-e-01-i-are-terraformer-i-am-viking-the-drinking-fountain-of-youth'],
      'Sheep in the Big City': ['sheep-in-the-big-city-2000-tv-series-complete'],
      'Codename: Kids Next Door': ['s-5-e-14-operation-z.-e.-r.-o'],
    },
  },
  {
    number: 16, name: 'Nick at Nite',
    shows: {
      Broadcasts: ['wnyw-5-the-bed-sitting-room-and-i-love-lucy-vh-1-and-nick-at-nite-1989', 'vts-01-1_20260307', '1992-nick-at-nite-top-10-rerun-countdown-woc', '1994-lucy',
        '1995-nickatnite-i-love-lucy-block-party-summer', 'i-love-lucy-nick-at-nite-marathon', '1996.12.01-20.00-nick-rugrats-happy-days-munsters-woc',
        'vhs-tape-1997-nick-at-nite-two-episodes-of-the-mary-tyler-moore-show-rhoda-wptz-the-bishops-wife', 'vhs-tape-nickelodeon-nick-at-night-get-smart-maximum-smart-marathon',
        'nick-at-nite-january-3-1998-pt-3', '1998-all-in-the-family-nick-at-nite-norman-lear-picks-marathon-5-nights-woc_202506'],
      'I Love Lucy': ['vts-01-1_20220124_0030', 'vts-01-1_20220124_0109', 'vts-01-1_20220124_2321', 'final-seasons-i-love-lucy'],
      'The Dick Van Dyke Show': ['the-dick-van-dyke-show-the-complete-series-1961-1966'],
      'Mister Ed': ['mister-ed-Lando18'],
      'The Munsters': ['munsters_the'],
      'Get Smart': ['get-smart'],
      'The Patty Duke Show': ['the-patty-duke-show-the-complete-series-1963-1966'],
      'The Donna Reed Show': ['te-d-re-s-s-7-e-02'],
      'My Three Sons': ['mythreesonsseason1', 'movie_206651.mp4-360'],
      'The Bob Newhart Show': ['TheBobNewhartShow'],
      'The Mary Tyler Moore Show': ['the-mary-tyler-moore-show-s-01', 'the-mary-tyler-moore-show-s-02', 'mtms-s-03', 'mtms-s-04'],
    },
  },
];

const PER_SHOW_HOURS = 30; // a long series gets an even spread of episodes, so it doesn't take over the channel
const MIN_LENGTH = 8 * 60;
const MAX_LENGTH = 5 * 3600;
// Inside picked items, still skip the extras: promos, retrospectives, interviews and the like.
const EXTRAS = /promo|trailer|\bintro\b|theme song|\bgif\b|retrospective|commentar|behind the scenes|interview|blooper|featurette|storyboard|bonus|reaction|review|reunion|longplay|walkthrough/i;
const ENGLISH = /^(eng|english|en|en-us)$/i;
const PLAYABLE = ['h.264 IA', 'h.264', '512Kb MPEG4'];
// Uploaders' own files can be HEVC or AC3, which browsers often can't play, so those get checked first.
const BROWSER_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const BROWSER_AUDIO = ['aac', 'mp3', 'opus', 'vorbis'];
const VIDEO_FORMATS = /mpeg4|matroska|avi|quicktime|mpeg2|windows media|ogg video|webm|h\.264|divx|flash video/i;

const getJson = async (url) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
};
const fileUrl = (id, file) => `https://archive.org/download/${id}/${file.split('/').map(encodeURIComponent).join('/')}`;
const seconds = (v) => (String(v).includes(':') ? String(v).split(':').reduce((a, b) => a * 60 + Number(b), 0) : Number(v));
const plain = (v) => String(Array.isArray(v) ? v[0] : v || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);
const fileName = (name) => path.basename(name).replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();

// One program per video in the item, using a file the browser plays without conversion.
function programs(meta, item, show) {
  const files = meta.files || [];
  const found = [];
  for (const src of files) {
    if (src.source !== 'original' || !VIDEO_FORMATS.test(src.format || '')) continue;
    const derived = PLAYABLE.map((f) => files.find((d) => d.original === src.name && d.format === f)).find(Boolean);
    const file = derived || (src.format === 'MPEG4' ? src : null);
    const length = seconds(file?.length || src.length);
    // An item often has the same video as both .mkv and .mp4, so keep one copy of each.
    if (!file || !(length >= MIN_LENGTH && length <= MAX_LENGTH) || found.some((p) => p.file === file.name)) continue;
    const name = src.title || fileName(src.name);
    if (EXTRAS.test(name)) continue;
    found.push({ file: file.name, length, name, original: file === src });
  }
  const itemTitle = plain(meta.metadata?.title);
  const year = Number(String(meta.metadata?.year || meta.metadata?.date || '').slice(0, 4)) || null;
  // DVD rips name every file "VTS 01 1", so those take the item's title instead.
  const generic = (name) => /^(vts|title|video|getvid|movie)\b|^[\d\s()-]+$/i.test(name);
  return found.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true })).map((p, i) => ({
    id: `${item}/${p.file}`,
    url: fileUrl(item, p.file),
    title: clip(found.length > 1 && !generic(p.name) ? p.name : found.length > 1 ? `${itemTitle} (part ${i + 1})` : itemTitle || p.name, 90),
    year: year && year < 2030 ? year : null,
    description: clip(plain(meta.metadata?.description) || show, 400),
    duration: Math.round(p.length),
    direct: true,
    ...(p.original ? { original: true } : {}),
  }));
}

async function showPrograms(show, ids) {
  const metas = await Promise.all(ids.map((id) => getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`).catch(() => null)));
  const list = [];
  for (const [i, id] of ids.entries()) {
    const meta = metas[i];
    const language = [].concat(meta?.metadata?.language || []);
    if (!meta?.files) console.warn(`    ${id}: not found on archive.org`);
    else if (meta.is_dark || meta.metadata?.access_restricted_item) console.warn(`    ${id}: not available to stream`);
    else if (language.length && !language.some((l) => ENGLISH.test(l))) console.warn(`    ${id}: skipped, language is ${language.join(', ')}`);
    else {
      const found = programs(meta, id, show);
      if (!found.length) console.warn(`    ${id}: no playable videos`);
      list.push(...found);
    }
  }
  return list;
}

const probeCache = fs.existsSync(PROBE_CACHE) ? JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf8')) : {};

function probe(url) {
  if (url in probeCache) return Promise.resolve(probeCache[url]);
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', url], { timeout: 90000 }, (err, out) => {
      if (err) return resolve(null); // a network hiccup isn't cached, so the next run tries again
      const streams = JSON.parse(out).streams || [];
      const video = streams.find((st) => st.codec_type === 'video');
      const audio = streams.find((st) => st.codec_type === 'audio');
      resolve(probeCache[url] = Boolean(video && BROWSER_VIDEO.includes(video.codec_name) && (!audio || BROWSER_AUDIO.includes(audio.codec_name))));
    });
  });
}

// Videos the browser can't play are converted by the server as they're watched, which costs CPU while they're on.
async function keepPlayable(list) {
  const result = list.map((p) => (p.original ? undefined : true));
  const todo = list.map((p, i) => i).filter((i) => list[i].original);
  const worker = async () => { for (let i; (i = todo.shift()) !== undefined;) result[i] = await probe(list[i].url); };
  await Promise.all(Array.from({ length: 8 }, worker));
  const converted = result.filter((x) => x === false).length;
  const unread = result.filter((x) => x === null).length;
  if (converted) console.warn(`    ${converted} videos will be converted while watched`);
  if (unread) console.warn(`    ${unread} videos skipped because ffprobe couldn't read them`);
  return list.flatMap(({ original, ...p }, i) => {
    if (result[i] === null) return [];
    if (result[i]) return [p];
    // The server looks converted videos up by ID, and an ID can't contain a slash in its URL.
    const { direct, ...rest } = p;
    return [{ ...rest, id: `ia-${crypto.createHash('sha1').update(p.url).digest('hex').slice(0, 16)}`, convert: true }];
  });
}

// Keeps every nth episode so a capped series still runs from start to finish.
function spread(list, hours) {
  const total = list.reduce((s, p) => s + p.duration, 0);
  if (total <= hours * 3600) return list;
  const keep = Math.max(1, Math.round(list.length * (hours * 3600) / total));
  return Array.from({ length: keep }, (_, i) => list[Math.floor((i * list.length) / keep)]);
}

// Spreads each show evenly through the loop, so a long series doesn't bunch up at the end.
function interleave(lists) {
  return lists.flatMap((list) => list.map((item, i) => ({ item, at: (i + 0.5) / list.length })))
    .sort((a, b) => a.at - b.at).map((x) => x.item);
}

(async () => {
  const only = process.argv.slice(2).map(Number);
  const previous = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).channels : [];
  const channels = [];
  for (const def of CHANNELS) {
    if (only.length && !only.includes(def.number)) {
      const kept = previous.find((c) => c.number === def.number);
      if (kept) channels.push(kept);
      continue;
    }
    const lists = [];
    for (const [show, ids] of Object.entries(def.shows)) {
      const all = await showPrograms(show, ids);
      const list = await keepPlayable(show === 'Broadcasts' ? all : spread(all, PER_SHOW_HOURS));
      console.log(`  ${def.name} / ${show}: ${list.length} videos, ${(list.reduce((s, p) => s + p.duration, 0) / 3600).toFixed(1)} hours`);
      if (list.length) lists.push(list);
    }
    const items = interleave(lists);
    if (!items.length) { console.warn(`${def.number} ${def.name}: nothing found, skipped`); continue; }
    channels.push({ number: def.number, name: def.name, items });
    console.log(`${def.number} ${def.name}: ${items.length} videos, ${(items.reduce((s, p) => s + p.duration, 0) / 3600).toFixed(0)} hours`);
  }
  fs.mkdirSync(path.dirname(PROBE_CACHE), { recursive: true });
  fs.writeFileSync(PROBE_CACHE, JSON.stringify(probeCache));
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), channels }));
  console.log(`Wrote ${OUT_FILE}`);
})().catch((err) => { console.error(err); process.exit(1); });
