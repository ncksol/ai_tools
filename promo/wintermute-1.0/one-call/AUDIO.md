# Audio: One Call

The film works muted: every line is in a balloon or caption box. Sound has three layers.

## 1. Sound effects (in the project now)

CC0 recordings from Freesound, credited in `assets/sfx/CREDITS.md`: rain bed (outdoors loud, indoors quieter, fades out at dawn), the mail slot, phone rings, handset pickups and hang-ups, tacks, a vault creak and clunk, a key in a lock, and a rubber stamp. Each hit is placed so its peak lands about one frame after the picture.

## 2. Music (the user supplies the track)

Slot: `assets/audio/music.mp3`, one clip from 0 to 86 s (0.4 s fade-in, 1.5 s fade-out). The clip is ready in `index.html` as a commented block; remove the comment markers when the file is in place. Its volume lane ducks the bed to 0.35 under each of The Voice's lines.

- **Length:** 86 s (or longer; it is trimmed at 86 s).
- **Mood:** graphic-novel noir. Smoky minor-key jazz or dark synth noir: walking upright bass or a low synth pulse, brushed drums, muted trumpet, Rhodes or sax. Tense and patient through the night, never frantic. It opens up (brighter, warmer, a lift) at dawn.
- **Tempo:** about 84–96 BPM.
- **Cues the music should hit:**

| Film time | What happens | Music |
| --- | --- | --- |
| 0.0 | Rain, 2 a.m., the job at the slot | Sparse intro; rain carries it |
| 1.9 | The folder goes through the slot (clack) | Small accent |
| 3.55 | Every payphone in the city starts ringing | Band enters; energy up |
| 7.5 | Cut into the Voice's room | Drop back, low and close |
| 15.0 | The client's phone rings, the page splits | Accent |
| 21.5 | The crew pick up, one by one (splits at 24.5 and 26.6) | Pulse builds |
| 31.5 | Switchboard: every line runs through the Voice | Steady groove |
| 40.4 | The vault opens (CLUNK) | Hit |
| 43.2–46.5 | Eight panels, "All night. All at once." | Busiest moment |
| 52.1 | CHECKED stamp | Hit |
| 58.9 | The client's phone rings: "Your call." | Hold back, leave space |
| 62.5–69.0 | He sleeps; the pins keep moving | Quietest stretch |
| 69.0 | Dawn; the rain stops | The music opens up |
| 71.5 | The finished job lands on the desk (the reveal) | Strong moment |
| 75.0–76.5 | The phones go quiet, one by one | Thin out |
| 76.9 | One last ring | Near silence |
| 79.5 | End card | Final phrase |
| 82.3 | The mark lands | Resolve on a strong downbeat, then hold and fade |

## 3. The Voice (optional voice-over)

Slots: `assets/audio/vo/<nn>.mp3`, one file per line, also a commented block in `index.html`. Each clip starts at its line's balloon. Trim leading and trailing silence; keep each file at or under its maximum length.

**Casting:** one man, the unseen fixer on the payphone line. Low, calm, unhurried, a little gravel; intimate rather than theatrical, as if he is speaking into a receiver close to the mouth. Never menacing. Plain English, no accent work. A telephone-band filter (high-pass about 300 Hz, low-pass about 3.4 kHz) suits him; it can be added in the mix later.

| File | Line (exact text) | Starts at | Max length | Delivery |
| --- | --- | --- | --- | --- |
| `vo/01.mp3` | Let's take it apart. | 9.40 s | 1.6 s | Quiet, almost to himself, already looking at the pieces. |
| `vo/02.mp3` | Six people. Here's the plan. Yes? | 15.70 s | 2.9 s | Brief and businesslike, small beats between the sentences; "Yes?" is a real question. |
| `vo/03.mp3` | It's all in the envelope. | 22.45 s | 1.8 s | Low, confidential, to a stranger he trusts. |
| `vo/04.mp3` | Librarian. The safecracker needs a blueprint. | 35.25 s | 2.5 s | Crisp dispatcher: the name, a short pause, the request. |
| `vo/05.mp3` | Your call. | 59.60 s | 1.1 s | A respectful handover, a touch of warmth: the human decides. |
| `vo/06.mp3` | Anything else? | 77.55 s | 1.8 s | Easy, almost amused: the job is done and he is still on the line. |
