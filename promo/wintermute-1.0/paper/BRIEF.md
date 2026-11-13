---
workflow: general-video
flow: automation
storyboard: no
message: "Hand over the crumpled thing. Wintermute folds it into finished, checked work."
destination: github-release-and-social
aspect: 1920x1080
fps: 30
language: en
audience: developers who use GitHub Copilot CLI and the GitHub Copilot app
length: 60-90s
angle: allegory (wordless origami on a desk)
---

## Intent

### Paper: wordless, on one desk

**Idea:** A crumpled to-do note lands on a desk. Paper creatures fold it, literally, into finished work before the coffee goes cold.

**Look:** A desk seen from above, flat paper textures and no words. Shapes fold into each other, the paper's colour shows which "house" folded it, and the coffee steam is the clock.

**Hook:** A paper ball marked "everything" bounces next to a fresh, steaming mug. A paper crane unfolds itself from a sticky note.

1. The crane flattens the ball and tears the messy list into labelled strips. It lays them out as a plan, and the human's hand gives a thumbs up.
2. It folds each strip into a helper that suits the job: a plane for errands, a frog for checks, a boat for the hard part and a fan for writing.
3. They scatter. The boat crosses a coffee ring, and a second boat sets off the moment the first one clears it.
4. The frog gets stuck between two keys. It can't fold a bridge itself, so it waves a flag, and the crane sends one.
5. The helpers come back as strips covered in finished drawings. A blue strip is checked only by an orange creature, and the stamp won't come down until the strip is held to the light. One strip gets a red mark and is folded again.
6. Two inspectors in two other colours lay all the strips side by side to see whether the edges line up.
7. The crane folds every strip into one paper lantern, which lights up. A sticky note asks "OK to ship?", and the hand ticks it.
8. The creatures lie flat and slide into a drawer. The hand picks up the lantern and the coffee, which is still steaming.

**End card:** "Hand over the crumpled thing." Wintermute 1.0

**How it maps:** The crane is the orchestrator (wintermute-core), the folded helpers are the child sessions, each strip's label is its unit label, the flag is a helper request (helpers can't summon help themselves), the second boat setting off early is a stacked unit, the other paper colour is a review by a different model vendor, holding the strip to the light is the claims check (evidence, not word), the two inspectors are the final panel, the thumbs up is plan approval, "OK to ship?" is the go-ahead, and the drawer is the sessions being archived.

## Production

- 84 seconds, 2520 frames, 1920 x 1080, constant 30 fps.
- One continuous top-down desk scene. A folded paper end card opens on the same desk.
- Original vector origami, paper fibres, warm wood, tactile crease shadows.
- Only the approved hook, strip labels, shipping question and end card contain words.
- Blue, orange, sage and rose paper identify houses; no vendor names or third-party characters.
- No voice-over or captions. The pictures carry the story.
- Steam remains animated, including while the mug is picked up and beside the end card.

## Notes

- usage: unknown (unsupported_harness); local render only
- The coordinator approved local production without hosted generation services.
- HyperFrames 0.9.19 retired the separate `general-video` workflow. Its current custom-film, character, motion, format, sound and review references govern this build. The approved intent and automation flow are unchanged.
- The user will provide music. Do not source or synthesize a music bed. `assets/audio/music.mp3` is a silent, hidden placeholder covering the whole film; replace it with the supplied track and enable `#paper-music` to include it.
- Music selection guide: 84 seconds; playful, tactile, curious, then warm and resolved; roughly 100-112 BPM. Main cues: crane unfolding at 4.0 s, helpers folding at 17.0-23.0 s, the second boat at 29.0 s, bridge delivery at 38.0 s, evidence before the stamp at 49.0-50.5 s, corrected work at 54.0 s, lantern folding at 64.0 s, light at 67.5 s, human approval at 70.5 s, end card at 79.0 s.
- Audio credits: all paper, tear, fold, flutter, stamp, pencil, drawer and pickup effects are original procedural noise generated locally by `scripts/synthesize-audio.mjs`. No recordings, samples, external music or hosted models are used. The generated effects are released under CC0-1.0 and may be used in a public promotional video.
- The silent placeholder is generated locally and contains no musical content. It is excluded from the rendered mix.
- Generated audio and rendered video are not committed. `npm run audio` recreates the local audio assets without overwriting a supplied music file.
- Product facts come from `ghcp/plugins/wintermute/README.md` and `QUICKSTART.md`. The allegory represents substantial work, not only code.
- Network policy: all HyperFrames commands use `HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1`. Do not run forced upgrade checks or skill updates; these can bypass the npm proxy.
- GSAP 3.15.0 and Nunito 5.3.0 are vendored from `npm pack` downloads through the machine's approved proxy. Compositions load only local JS and WOFF2 files; no CDN or Google Fonts URLs.
- Font credits: Nunito, via `@fontsource/nunito` 5.3.0, SIL Open Font License 1.1; license included in `assets/fonts/LICENSE`. The CSS family alias is `Paper Nunito`; the original font binaries are unchanged. GSAP's original copyright/license header is retained in `assets/vendor/gsap.min.js`.
