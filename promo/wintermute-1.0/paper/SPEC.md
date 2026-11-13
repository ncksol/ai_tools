# Paper

GOAL: The viewer can hand over messy, substantial work while keeping control of the two decisions that need a human.

OUTPUT: HyperFrames, 1920 x 1080, 30 fps, local MP4.

TIME: 84 seconds x 30 fps = 2520 frames. Music is pending; a hidden full-length slot is reserved.

LOOK: Warm wood ground #dcc3a2, irregular grain at 5% opacity, paper fibres at 7%. Ink #334b50. Blue #6598bc, orange #dc9870, sage #91afa0 and rose #c98f97 carry house identity. Cream #f8edd4 is unprinted paper, not a generic presentation background. Shadows are offset 4 px with 5 px blur at 18% opacity. No lens effects. One rounded, storybook face: local Nunito (CSS alias Paper Nunito) 700 for paper labels at 30-38 px, 900 for the end card at 76 px, 700 for the release at 38 px.

OBJECTS: A creased paper ball; angular crane with two independently hinged wings, long neck and beak; four strips and their plane, frog, boat and fan forms; a second boat; two physical keycaps and a folded bridge; a paper flag; finished ink drawings; orange inspector and physical rubber stamp; desk lamp and its light beam; two other-colour inspectors and a straightedge; a four-colour accordion lantern; a handwritten shipping note; one human hand; mug, coffee surface, rising steam; sliding drawer.

MOTION: Absolute, seekable GSAP tweens. Fold geometry interpolates equal-vertex polygons, with hinged facets and crease lines: no swaps, cuts or crossfades between paper forms. Travel uses power2.inOut; landings use power3.out or back.out(1.2); wing follow-through is offset 3-5 frames. Folding takes 27-48 frames per action. Frog jumps have a 5-frame anticipation and 18-frame arc. Steam uses finite 2.8-second cycles, independent of object travel. The camera remains top-down on the same desk.

## Shots

| Frames | Time | Hero action and read | Sound and handoff |
| --- | --- | --- | --- |
| 0-209 | 0-7 s | Ball bounces; sticky note unfolds into the crane. Coffee is visibly hot. | Crumple and soft contacts. Crane turns toward the ball. |
| 210-479 | 7-16 s | Ball unfolds to a scribbled sheet, tears into four labelled strips, and becomes a plan. Human thumbs up. | Tear and paper alignment. Crane begins the first fold. |
| 480-719 | 16-24 s | Approved strips spread to four clear workspaces, then continuously fold into plane, frog, boat and fan. | Four distinct folds. Helpers leave on overlapping paths. |
| 720-989 | 24-33 s | Helpers scatter. First boat crosses the coffee ring; second departs at 29 s as the first clears it. | Paper flutter. Frog arrives at the keycap gap. |
| 990-1259 | 33-42 s | Frog tries, raises its flag, waits; crane folds and sends a bridge; frog crosses. | Fold and contact. Helpers turn home. |
| 1260-1649 | 42-55 s | Helpers unfold into finished drawings. Orange checks blue; evidence in lamp light precedes the stamp. Rose work gets a red mark, moves to a clear fold space, and returns only after lying flat. | Return folds, pencil, stamp. Corrected strip joins the others. |
| 1650-1859 | 55-62 s | Sage and rose inspectors align the strips against one straightedge. | Soft slides and paper contact. Aligned strips move to the crane. |
| 1860-2189 | 62-73 s | Four strips fold into a single lantern; light at 67.5 s. Shipping note and human tick. | Long fold, pencil tick. Approved work moves toward the human. |
| 2190-2369 | 73-79 s | Creatures flatten and slide into the drawer. The same hand grips the lantern, carries it to the mug, then moves both together; steam continues. | Paper slides, drawer and pickup. Crane's final sheet becomes the end card. |
| 2370-2519 | 79-84 s | Paper end card unfolds: "Hand over the crumpled thing." / "Wintermute 1.0". Lantern and hot coffee remain beside it. | Final paper fold. At least 3 seconds of stable reading. |

BANNED: Slideshow cuts; crossfades between forms; generic UI cards; model/vendor logos; narration; captions; extra slogans; a dark void; neon; particle decoration; floating titles; simulated stop-motion cadence; moving type during its reading hold. Lantern light is a literal story object, not decorative glow.

QA: Inspect 0.8, 5.5, 10.5, 14.5, 18.5, 22.5, 27.5, 30.0, 34.5, 38.5, 40.5, 44.5, 48.5, 50.5, 53.5, 58.5, 65.0, 68.5, 71.0, 75.0, 78.0 and 82.0 seconds. Sample the fold transitions and the first/second-boat handoff more densely. Check every beat without explanatory text, inspect phone-size sheets, and decode frames from the final MP4.

The root `index.motion.json` supplies seeked appearance and steam-liveness assertions. Frame inspection is still required for ink strokes, paper layering and the story's causal reads.

HAND RIG: Three consistent paper-cut poses, with one thumb and four fingers and an attached forearm. The pencil tip and the two tick segments share positions and easing. A parent carry group keeps all lantern panels, ribs and handle together. Pickup begins only after the hand reaches the lantern; the mug moves only after the receiving grip reaches its lower edge.

DRAWER RIG: A fixed mouth below the desk edge masks the tray and archived sheets. The drawer pulls down towards the human, then carries its contents back under the desk. The front face and attached handle remain inside the frame.
