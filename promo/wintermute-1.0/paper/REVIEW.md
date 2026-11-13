# Paper review

The local delivery is an 84-second, 1920 x 1080 H.264 MP4 with an AAC effects track. Both reported video frame rates are `30/1`. All 2520 decoded frames have constant 1/30-second timestamps, within ffprobe's six-decimal rounding.

## Story and pixels

The eight approved beats appear in order on the same desk:

| Beat | Time | Visible cue |
| --- | --- | --- |
| Plan and approval | 0-16 s | Crumpled work, unfolding crane, torn unit strips, human thumbs up |
| Helpers | 16-24 s | Plane, frog, boat and fan fold from separated strips |
| Scatter and stack | 24-33 s | Blue boat clears the coffee ring; a sage boat starts behind it |
| Helper request | 33-42 s | Frog raises a flag between keycaps; the crane delivers a folded bridge |
| Results and checks | 42-55 s | Finished drawings, orange inspection of blue work, light before stamp, rose correction and refold |
| Final panel | 55-62 s | Sage and rose inspectors align the four edges against a ruler |
| Lantern and go-ahead | 62-73 s | Shared paper bodies fold into a lit lantern; the human ticks the shipping note |
| Archive and receive | 73-79 s | Creatures flatten into the drawer; the hand receives the lantern beside still-steaming coffee |

The end card opens at 79 seconds. Its exact copy, "Hand over the crumpled thing." and "Wintermute 1.0", is held after the opening fold, with the lantern and moving steam still visible.

Source snapshots were inspected at every beat, at intermediate folds, and at the frog, bridge and inspector motion boundaries. The phone-size story sheet was also inspected. No unintended clipping, label collisions or geometry resets were visible in those frames. Paper-form transitions use continuous polygon morphs and hinged facets, not scene cuts or cross-fades.

`snapshot --against` produced 19 source/video pairs at 0.8, 5, 10.2, 15, 23.2, 30.2, 35.3, 38.8, 48.3, 50.5, 53.5, 58.8, 64.8, 68.8, 70.8, 75.3, 78.5, 80.8 and 83.96 seconds. Matching decoded frames across all eight beats and the final frame were inspected. The pairs label the HTML capture "render" and the MP4 decode "reference"; their composition, lettering and geometry agree.

The light-before-stamp sequence is the most subtle wordless beat. The held strip, lamp beam, blocking wing and proof mark before the stamp provide the cue. The small job labels are identifiers, not the main reading copy.

## Automated gate

The full browser check passed with motion enabled and `browserSkipped=false`.

| Audit | Errors | Warnings |
| --- | --- | --- |
| Lint | 0 | 2 |
| Runtime | 0 | 0 |
| Layout | 0 | 1 |
| Motion | 0 | 0 |
| Contrast | 0 | 0 |
| Craft | 0 | 1 |
| Audio | 0 | 0 |

Retained warnings were reviewed against the pictures:

- `composition_file_too_large`: one continuous desk composition keeps shared paper bodies and choreography together.
- `timeline_track_too_dense`: ten sequential beat markers share a track without overlapping.
- `off_pivot_rotation`: a rotating SVG paper strip is classified as a gauge pointer. No gauge or pointer exists in the artwork; its visible fold and alignment are intact.
- `text_below_floor`: four intentionally tiny unit labels fall below 28 px during the panel. They are permitted by the brief; the shipping note and end copy remain above the reading floor.

One rounded font family is deliberate; weight and size establish the hierarchy.

## Render evidence

- HyperFrames 0.9.19, local Chrome, hardware ANGLE Metal on Apple M5 Pro; screenshot capture with two workers.
- Delivery render completed in 56.2 seconds. File size: 10,797,768 bytes.
- Video: 1920 x 1080, `r_frame_rate=30/1`, `avg_frame_rate=30/1`, 2520 frames, `duration=84.000000`.
- Format and AAC durations: `84.000000`.
- Full-video decode succeeded. Every consecutive 320 x 180 decoded frame has a different checksum; no repeated-frame stretch was found.
- Decoded timestamp error against `frameIndex / 30` stayed below 0.000001 seconds for every frame.
- HTML, motion sidecar, audio generator, GSAP, both font files and generated effects passed the before/after render SHA-256 comparison.
- MP4 SHA-256: `85cffcb6ab340a5d7605d0a425c1739ea0d6e92bdc49069b94ac4d263c87933b`.
- No desktop-app line was printed by the render.

Detailed check, render, ffprobe, timestamp, checksum and paired-frame evidence remains under the ignored `.hyperframes/` directory.

## Audio and offline assets

There is no music or voice-over in this render. Music awaits the user's track; the full-film slot is hidden. No narration is needed for this story.

The 44 effects are original, locally synthesized procedural noise, released under CC0-1.0. The decoded AAC track measured -37.3 dB mean volume and -7.4 dB maximum volume. These are measurements, not a listening review. Sources, licence and music cues are recorded in `BRIEF.md` and `assets/audio/provenance.json`.

GSAP 3.15.0 and Nunito 5.3.0 were fetched through the approved npm proxy and vendored locally. The GSAP copyright/license header and Nunito SIL OFL 1.1 licence are preserved. Compositions contain no CDN or Google Fonts sources. Every HyperFrames command disables direct update checks and telemetry; no hosted generation or rendering was used.
