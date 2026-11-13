# Review: One Call

## Creative calls

- The look is a printed noir graphic novel: paper-coloured gutters, ink panels, rain over every night scene. Teal (`#58cfc2`, the plugin's own mark colour) is the only neon and belongs to the Voice: its balloons, cord, waveform, the W sign, the lit booths while a line is open, the map pins, the CHECKED stamps and one word on the end card. Red is kept for the string and the THE JOB stamp.
- The crew are black trench-coat silhouettes; the client is the only lit, drawn human. The "other families" are told apart by colour and costume only: the appraiser in bone white, the outside appraisers in a grey bowler and a light flat cap. No brands or vendor marks.
- Panels split 1 → 2 → 4 in the crew beat and 8 in the "All night. All at once." montage.
- Short lines were added around the user's story text so the film reads without narration: "Too big for one night.", "Nobody has ever seen the Voice.", "Let's take it apart.", "It's all in the envelope.", "They have never met.", "Nobody calls each other. / Every line runs through the Voice.", "I need a blueprint.", "Librarian. The safecracker needs a blueprint.", "It's done. Trust me.", "One piece. Two opinions.", the client's "Left.", "All night, watch the pins move. / Or sleep.", "At dawn, the crew breaks in.", "They didn't come to take anything." The end card adds `github.com/ncksol/ai_tools` under the lockup.
- The city map in beat 8 is a phone showing streets and moving pins, standing for the swarm dashboard.
- The rain stops at the cut into dawn (69 s); the rain sound fades out over 1.6 s.
- Not built here: story 1 from the pitch, and story 3, which the sibling unit builds as `paper`.

## What was measured, and what was only looked at

- `npx hyperframes check`: passed, 0 errors and 0 warnings in lint, runtime, layout, motion, contrast (9/9 WCAG AA), craft and audio. The 11 info findings are figures and arms that extend past their panel on purpose.
- `snapshot --review`: every scene at start and middle, all 10 seams, and the phone-width sheet were looked at. Extra snapshots covered every beat while building.
- Transitions: dip cut (hook → wall, crew → switchboard), page split (wall → call, the dispute), whip pans (switchboard → building, appraiser → dispute), zoom through a panel (montage → appraiser), colour flood (dawn), and three motivated hard cuts (a ring, the client's answer, the last call).
- Sound was placed from measured hit points (`hyperframes audio`), not heard. Nobody has listened to the mix.

## Weakest shots, and what to change with more time

- The switchboard (31.5–39 s) is the most diagram-like frame: small nodes on a dark street map. More time: draw it as a real switchboard with patch cords.
- The crew's entrance at dawn bunches five silhouettes together; staggered depth and a walk cycle would read better.
- Characters are simple silhouettes without faces; the client's hair is rough.

## Warnings kept on purpose

None.
