# SPEC: One Call

```text
GOAL:    A developer who uses Copilot leaves thinking "I hand Wintermute the job; it runs a
         crew, checks the work and brings it back done", and remembers the line
         "You bring the job. Wintermute runs the crew."
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, H.264 MP4
TIME:    86 s x 30 = 2580 frames. Music is the user's track (not in the project yet);
         until it arrives the clock is the story beats and the sound effects.
LOOK:    The medium is a printed noir graphic novel.
         - paper (gutters, caption boxes, balloons): #ece8df, flat, no gradient
         - ink: #0a0c0f, every silhouette and outline; line weight 4 px on balloons, 3 px on boxes
         - greys for lit surfaces only: #1c2128, #2b313a, #3a424d, #5b6470, #8a929c, #c9ccd1
         - the one neon colour: Wintermute teal #58cfc2 (hot core #a8f3ea). It carries only
           the Voice (its balloons, waveform and cord light), the W sign, the pins on the map,
           CHECKED stamps and the end card's one word. Never more than one teal focus per frame.
         - red string #b3262e: only the string on the wall and the "THE JOB" stamp
         - display: League Gothic 400, 120-170 px, tracking 0.02em, upper case
         - captions (narration boxes): Special Elite 34-36 px, line height 1.25, on paper
         - balloons: Patrick Hand 44-52 px, upper case; the Voice's balloons are ink with a
           teal 4 px border and teal text, with a zig-zag "phone line" tail
         - sound lettering: Bangers 70-130 px, paper fill, 6 px ink stroke, rotated -8..8 deg
         - light: hard lamp cones (radial, 0.0-0.55 opacity), silhouettes with a 3 px teal or
           paper rim on one edge; no blur glows. Rain: two streak layers, 1.5 px, 0.18-0.5 opacity.
OBJECTS: payphone booth (glass box, lamp, coin box, handset on a coiled cord);
         manila folder stamped THE JOB in red; cork wall with tacks, index cards, red string;
         the Voice = a payphone handset hanging on its coiled cord + a teal waveform, never a
         body; its balloons' zig-zag tails always end at a handset earpiece;
         the client = one engineer, the only face drawn in detail and the same every time:
         white shirt, rolled sleeves, loose dark tie, glasses, messy dark hair; always at his
         own desk at home (window, lamp, rotary desk phone with a coiled cord);
         crew = four identical black trench-coat-and-fedora silhouettes with a grey rim, told
         apart only by the prop each carries: safecracker (stethoscope), forger (rubber
         stamp), librarian (books), driver (stopwatch);
         checkers = hats and gloved hands only: the appraiser's bone-white fedora and white
         gloves with a loupe; the outside appraisers' grey bowler and light boater, each with
         a pointing glove in the same grey; city map with teal pins.
MOTION:  enter: expo.out / power4.out, 0.35-0.6 s; moves and camera: power2.inOut 0.6-1.2 s;
         exits: power3.in, 40-50% of the entry; panels split with clip-path in 0.5-0.6 s
         power3.inOut; balloons: scale 0.86 -> 1 + opacity, 0.2 s power3.out (no bounce);
         captions print in with a left-to-right clip wipe, 0.3 s; landed text never moves.
         Staggers: words 0.08 s, panels 0.12 s, phones going quiet 0.35 s.
SHOTS:   (seconds)
  S0  0.0-7.5   Hook. Rainy door, neon W over a mail slot, the client holds THE JOB. Caption
                "2:00 A.M." on frame 0. The folder goes through the slot (letterbox clack).
                Camera tilts up to the skyline; payphones ring across the city, RRRING letters.
  S1  7.5-15.0  Dark room. Cord drops in, waveform wakes. Caption "Nobody has ever seen the
                Voice." Folder pinned (tack). Voice: "Let's take it apart." Four cards fly out,
                red string draws to each.
  S2  15.0-21.5 Panel splits in two: the Voice | the client at his desk. Ring, pickup.
                Voice: "Four people. Here's the plan. Yes?"  Client: "Yes."
  S3  21.5-31.5 Payphone panels split 1 -> 2 -> 4: safecracker, forger (documents), librarian
                (research), driver (tests). Each picks up, gets a sealed W envelope.
                Voice: "It's all in the envelope."  Caption "They have never met."
  S4  31.5-39.0 Switchboard map. Four crew nodes, the Voice in the centre. Captions
                "Nobody calls each other." / "Every line runs through the Voice."
                Safecracker: "I need a blueprint." Pulse to the Voice, Voice to librarian:
                "Librarian. The safecracker needs a blueprint." Blueprint travels back.
  S5  39.0-46.5 Building cut-away. Vault opens on floor 1; the instant it does, the forger
                starts upstairs. Caption "Upstairs, the forger starts the moment the vault
                opens." Then 8 panels: everyone at work at once, "All night. All at once."
  S6  46.5-54.0 Back room. The safecracker and the appraiser's white hat and glove. Caption "An appraiser from another family
                checks every piece." Crew: "It's done. Trust me." Appraiser: "Show me it
                works." The key turns in a lock box (key click), CHECKED stamp (stamp).
  S7  54.0-62.5 One piece, two opinions: safecracker "Left." / forger "Right!" Two outside
                appraisers (hats and pointing gloves): "Left." / "Right." The client's phone
                rings at his desk. Voice: "Your call."  Client: "Left."
  S8  62.5-69.0 His desk. A phone on a stand shows the city map, four teal pins moving.
                Captions "All night, watch the pins move." / "Or sleep." Pull back: he is asleep
                at the desk, head on his folded arms.
  S9  69.0-79.5 Colour flood to dawn, rain stops. The four slip into his room and leave the
                finished job on the desk beside him while he sleeps. Caption "They didn't come
                to take anything." Four payphones go dark one by one. One last ring; he stirs.
                Cut to him answering at his desk. Voice: "Anything else?"
  S10 79.5-86.0 Waveform flattens into a line. "YOU BRING THE JOB." / "WINTERMUTE RUNS THE
                CREW." Mark draws on, wordmark wipes in, "1.0". Hold 2.5 s.
BANNED:  dark void with small floating things (every shot is a full panel or a full page);
         glow/bloom (teal is flat ink, not light blur); particles; gradients as decoration;
         everything centred; fade-and-slide-up entrances; text that moves while read;
         three cards in a row; the logo docked in a corner; AI vendor logos or names;
         any quote, name or text from Neuromancer;
         the words "code" and "merge" (the crew does any substantial work).
QA:      0.0 (thumbnail: door, W, folder, caption), 5.5 (city ringing), 13.5 (wall and
         strings), 17.5 (Voice line), 20.5 ("Yes."), 26.5 (4 panels), 30.0, 35.5 (routing),
         41.5 (second floor starts), 45.0 (8 panels), 50.5 ("Show me it works."), 53.0
         (CHECKED), 58.0, 60.5 ("Your call."), 65.0 (map), 73.0 (job on desk), 76.0 (phones
         quiet), 78.5 ("Anything else?"), 84.5 (end card).
```
