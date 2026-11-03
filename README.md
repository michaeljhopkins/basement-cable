# Basement Cable

Turns folders of your videos into always-on TV channels with a retro program guide.
Needs Node 18+ and ffmpeg on your PATH. There is nothing else to install.

## Run it

```bash
node server.js "D:\Videos\TV"
```

Then open http://127.0.0.1:8420. With no folder given, it uses `./media`.
To try it without your own videos, run `node make-samples.js`, then `node server.js sample-media`.

## Streamed channels

`stream-channels.json` holds channels that stream straight from archive.org, with no download. It's a saved copy of
the schedule, so it keeps working if spelunkr.tv changes. To refresh the list, use `all` or give specific channel numbers:

```bash
node build-stream-channels.js all
```

Restart the server afterwards. Streaming needs an internet connection and archive.org being up. If a local folder
uses the same channel number, the local folder wins.

`archive-channels.json` adds themed channels built from archive.org items picked by hand: TGIF (3), SNICK (4),
Hanna-Barbera (5), Disney Afternoon (6), Fox Kids (7), Cartoon Cartoons (10) and Nick at Nite (16). Each mixes
off-air recordings of the real block, commercials included, with episodes of its shows. To change the lineup, edit
`CHANNELS` at the top of `build-archive-channels.js`, then rebuild everything or just the channel numbers you changed:

```bash
node build-archive-channels.js
```

Vacation Slides plays archive.org music from the home movie's decade over the muted film, or a general mix when no
decade matches.

## Set up channels

Each folder directly inside the media folder is a channel, and subfolders are included in it.

```
TV\
  02 Saturday Morning\      channel 2 (a leading number sets the channel number)
    Cartoon One.mp4
    Cartoon One.txt         optional description, shown in the guide
  08 Primetime\
    .inorder                optional empty file: play alphabetically instead of shuffled
    S01E01.mkv
    S01E02.mkv
  Late Nite\                no number: gets the next free channel
```

Video files sitting loose in the media folder itself are ignored. New files are picked up every five minutes.
Adding or removing files in a channel changes that channel's schedule.

## Formats

- MP4 and WebM files in browser-friendly codecs play directly and use almost no CPU.
- Everything else (MKV, AVI, HEVC, AC3 audio) is converted by ffmpeg while you watch. H.264 video is
  passed through untouched, but other video codecs are re-encoded, which uses real CPU per viewer.

## Controls

| Key | Action |
| --- | --- |
| W / S or Up / Down | Channel up / down |
| Number keys | Go to a channel |
| R | Random channel |
| G | Switch between guide and watch |
| M / F | Mute / fullscreen |

## Other settings

- `PORT` changes the port (default 8420).
- `HOST=0.0.0.0` makes it reachable from other devices on your network. It has no login, so
  anyone on that network can watch. It stays on this computer only by default.
- The VT323 font loads from Google Fonts. Offline, the guide falls back to a system monospace font.
