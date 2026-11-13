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
| Archive and receive | 73-79 s | Creatures flatten into the drawer; the hand grips the lantern, reaches the mug, then carries both together |

The end card opens at 79 seconds. Its exact copy, "Hand over the crumpled thing." and "Wintermute 1.0", is held after the opening fold, with the lantern and moving steam still visible.

Source snapshots were inspected at every beat, at intermediate folds, and at the frog, bridge and inspector motion boundaries. The beat and phone-size story sheets were also inspected. No unintended clipping, label collisions or geometry resets were visible in those frames. The writing strip folds in a separate workspace and returns flat before the panel. Paper-form transitions use continuous polygon morphs and hinged facets, not scene cuts or cross-fades.

`snapshot --against` produced 34 source/video pairs from 0.8 to 83.967 seconds. All pairs were inspected, including every beat, the correction fold, both pencil-stroke segments, the drawer closing, lantern contact, mug contact and the final hold. The pairs label the HTML capture "render" and the MP4 decode "reference"; their composition, lettering and geometry agree. Exact decoded frames 1539 and 1644 were also inspected against their source captures.

The same hand uses three paper-cut poses, each with one thumb, four fingers and a connected forearm. The pencil nib follows the tick. The receiving grip stays with the lantern through pickup and reaches the mug before it moves. Mug, attached handle, beveled keycaps, drawer tray and attached drawer handle were checked as real objects. The drawer pulls towards the human beneath the desk edge; its contents disappear under that edge when it closes.

The light-before-stamp sequence is the most subtle wordless beat. The held strip, lamp beam, blocking wing and proof mark before the stamp provide the cue; a closer view of the held strip would make it easier to read on a phone. The small job labels are identifiers, not the main reading copy.

## Automated gate

The full browser check passed with motion enabled and `browserSkipped=false`.
It sampled 30 explicit layout times, 300 motion times, 5 contrast times and 599 craft times.

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
- Delivery render completed in 56.0 seconds. File size: 10,798,381 bytes.
- Video: 1920 x 1080, `r_frame_rate=30/1`, `avg_frame_rate=30/1`, 2520 frames, `duration=84.000000`.
- Format and AAC durations: `84.000000`.
- Full-video decode succeeded. Every consecutive 320 x 180 decoded frame has a different checksum; no repeated-frame stretch was found.
- Decoded timestamp error against `frameIndex / 30` stayed below 0.000001 seconds for every frame.
- All ten render inputs passed the before/after SHA-256 comparison: both HTML files, motion sidecar, audio generator, GSAP, both fonts, effects WAV, hidden music placeholder and provenance JSON.
- MP4 SHA-256: `ffeb690f3b8eba84ff9b67994888f1e751eed9c39f149c22edebf4afd8a29a21`.
- No desktop-app line was printed by the render.

Detailed check, render, ffprobe, timestamp, checksum and paired-frame evidence remains under the ignored `.hyperframes/` directory.

## Audio and offline assets

There is no music or voice-over in this render. Music awaits the user's track; the full-film slot is hidden. No narration is needed for this story.

The 44 effects are original, locally synthesized procedural noise, released under CC0-1.0. The decoded AAC track measured -37.3 dB mean volume and -7.4 dB maximum volume. These are measurements, not a listening review. Sources, licence and music cues are recorded in `BRIEF.md` and `assets/audio/provenance.json`.

GSAP 3.15.0 and Nunito 5.3.0 were fetched through the approved npm proxy and vendored locally. The GSAP copyright/license header and Nunito SIL OFL 1.1 licence are preserved. Compositions contain no CDN or Google Fonts sources. Every HyperFrames command disables direct update checks and telemetry; no hosted generation or rendering was used.
