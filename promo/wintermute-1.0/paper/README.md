# Paper - Wintermute 1.0

An 84-second, wordless origami story on one desk. Sources are editable HTML/SVG and one paused, seekable GSAP timeline. Output is 1920 x 1080 at 30 fps.

```bash
npm run audio
npm run check
npm run dev
npm run render -- -o /absolute/path/wintermute-1.0-paper.mp4
```

The project pins HyperFrames 0.9.19. Node.js 22+, FFmpeg and an already-installed local Chromium browser are required. npm must use the machine's normal approved registry configuration. Scripts disable HyperFrames' direct update checks and telemetry; JS and fonts are vendored locally. Prefix any additional HyperFrames command with `HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1`. Do not run forced upgrades or skill updates on this machine.

`BRIEF.md` contains the approved story, audio credits and music cues. `SPEC.md` records the timing and visual decisions. `REVIEW.md` records what was inspected.

The user is supplying music. Until then, only the original paper sound effects play. Replace the silent `assets/audio/music.mp3` slot with the licensed track, record its source and licence in `BRIEF.md`, then set `data-hidden="false"` on `#paper-music` in `index.html`. `npm run audio` never overwrites that file. Generated audio, Studio caches and MP4s are excluded from Git.

The Studio preview lets you select and edit the paper, copy and timing. The root variables expose the four house colours and the end card.
