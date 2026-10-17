# Swarm cockpit design

Date: 16 October 2026. Status: draft for the owner's approval.

## How to read this

- Section 6 holds the owner's decisions, in his words. They are fixed.
- Section 7 describes the spike whose look he approved. It is a reference, not code to ship.
- Section 8 holds choices made on his behalf, each marked "Orchestrator's call". He has not approved them.
- Section 9 is left to the builder.
- The dashboard design of 15 October 2026 (`2026-10-15-swarm-dashboard-design.md`) still applies in full. This document adds to it.

## 1. Intent and why

The swarm dashboard is a watch-only local page for agent swarms in the GitHub Copilot app: an orchestrator session, its child sessions and one-off sub-agents, their reports and questions, PR monitors and cost. Its main view is light, pastel and calm.

The owner shared a reference screenshot of a control-room dashboard: a dark 3D room with an Interstellar-style black hole seen through a curved window, and curved console panels. He wants the feeling of sitting at a real mission control desk inside a spaceship, looking at the black hole. He said this is purely about aesthetics.

So the cockpit is a second look at the same swarm, with no new data and no actions. It succeeds if it feels like that room, shows the same facts as the regular view, stays readable and calm, and does not run the laptop hotter than needed.

## 2. Goals

1. One fixed seat, looking through a curved window at a live black hole.
2. Curved panels with the same swarm data as the regular view (decision 5), each leading to its details in the regular window.
3. The look of the high-quality spike (section 7), at a cost a laptop can carry.
4. The owner's layout rules, unchanged, and no slowdown of the regular view.

## 3. Non-goals

- Walking, WASD or any free camera.
- A 3D library, unless the owner approves one as a fallback.
- Data that the reference screenshot shows but our data does not have: usage limits, assigned reviews, issue-tracker tasks and a calendar countdown.
- Any action or command input. The cockpit is watch-only.
- A cockpit inside the app's side panel.
- Sound.

## 4. Anti-goals

It fails, even if it works, when:

- it runs the laptop hotter than needed. The safeguards stay: no rendering while the window is hidden, a still frame under reduced motion, the adaptive resolution fallback, and Balanced one click away and remembered per browser;
- it looks like generic LLM design: bold text, italics, glow on text;
- text overlaps or is clipped;
- motion distracts from the data;
- the regular view gets slower because the cockpit exists.

## 5. Constraints

From the existing dashboard (PR 1 engine, PR 2 UI and server):

- The server binds 127.0.0.1, checks the Host header, serves only GET and HEAD, and refuses API requests that another website starts.
- Its Content-Security-Policy allows scripts only from the same origin (`script-src 'self'`). Inline scripts will not run.
- It serves `index.html` at `/` and other `ui/` files under `/ui/`, and only `.html`, `.css` and `.mjs` files. A page at its own path needs a server change.
- Live data comes from `/api/events` (Server-Sent Events) with `?swarm=` or `?session=`. The server serves at most 32 live pages, and browsers allow about six connections per site. A cockpit window is one more page.
- The regular page reads `?swarm=` and `?detail=<unit id>`, so a link can open it on one unit's detail panel. The canvas page's address carries `host=canvas` and either `swarm=` or `session=`.
- The snapshot (schema version 1) lists child sessions as units, then the orchestrator's one-off sub-agents as units of kind `subagent`: all unfinished ones and the 20 most recently finished. Sub-agent unit costs are already inside the orchestrator's cost and must never be added to a total. Sub-agent units have no PR.
- The app's canvas panel cannot open new windows, and it runs on WebKit. The layout check runs in Chrome and, optionally, in Playwright's WebKit.
- No runtime npm dependencies and no build step. The repository is public, so fixtures and screenshots use synthetic data only. Each plugin runs `npm test && npm run validate`.

## 6. The owner's decisions

1. He shared a reference screenshot of a control-room dashboard and asked: "Can we make something similar with our dashboard?"
2. "I want to have the feeling of sitting in front of this real mission control dashboard as if I am inside a space ship looking at the blackhole. This is purely about esthetics."
3. Of the options offered, he chose: "A second look I switch into; keep the pastel one".
4. "it should open as a new window in the same browser where regular view is running"
5. He confirmed the description below with "That's right, nothing missing":
   - He stays seated: one fixed view through the window, with a slow drift and a slight parallax as the mouse moves, and no walking.
   - The black hole is alive: a glowing disk that slowly turns and bends the light around it, with stars drifting past.
   - The console shows the same data as the pastel view, on curved panels below and around the window: a clock and the run timer; a "needs you" light; one tile per child session in its status colour; the activity log; cost; PRs opened and merged.
   - Clicking a panel takes you to the details in the regular window.
   - It is watch-only.
   - His rules still apply: nothing overlaps, padding is even, no bold or italic, and motion stays calm. Status colours stay pastel and glow softly on dark glass.
   - No new dependencies: the black hole is drawn on the graphics card, and the panels are ordinary page elements bent into a curve. A 3D library is a fallback only, and only with his OK.
   - It follows the system's "reduce motion" setting and does not make the laptop run hot.
6. About the first spike: "The blackhole is rather low quality i would say". Asked what to do, he chose: "Yes, do a higher-quality pass and measure the cost".
7. Shown the high-quality spike and its cost, and asked "How does it look now, and is the cost acceptable?", he chose: "Looks right now — write the design for it".
8. In the regular dashboard, he asked that the orchestrator's one-off sub-agents "share all the functionality that regular sub-sessions have". They are now units of kind `subagent` in the snapshot.
9. Default quality. He was told that, by estimate, High runs a MacBook Pro warm with quiet fans and would probably make a fanless MacBook Air run hot, and that the frame-rate fallback does not protect against heat. Offered "Balanced by default (black hole redrawn at 15 Hz, full rate while the mouse moves), High one click away", he chose: "High by default, as in the spike". He accepted that High may make fanless laptops hot.

## 7. The spike

Two throwaway spikes exist outside the repository: plain HTML, CSS and JavaScript with WebGL2 and no libraries, fed by a copy of the synthetic test snapshot, not by the server. The high-quality spike works like this:

- Black hole. Drawn into a half-float (HDR) texture at full device resolution. Each pixel traces a light ray around a non-rotating black hole, up to 380 steps, and finds each exact crossing of the disk plane, so both the direct and the lensed disk images appear. Pixels in the photon-ring band are traced 4 more times (4x supersampling), so the ring stays thin.
- Disk and stars. Streaks turn faster near the centre (differential rotation), with Doppler brightening and a gravitational colour shift. Streak detail fades where it would alias. Stars are sharp points sized through the local lensing distortion, so magnified stars stay round, and the star field turns slowly.
- Bloom and room. A six-level bloom chain. A final pass draws the room: a cylindrical window with mullions, a dark ceiling with a soft peach light line, and a desk that reflects the glow. Then ACES tone mapping, a vignette, sRGB and a one-step dither against banding.
- Panels. Ordinary HTML sections on two cylinders, placed with CSS 3D transforms: a console arc below the window and a higher arc at the sides. The design space is 900 px tall and scales with the window height. The shader and the panels share a 60-degree vertical field of view, so they line up. A fitting step tries angles and distances until no panel overlaps another or leaves the screen, and warns when it cannot.
- Camera. A slow drift from long sine waves, plus an eased mouse parallax, applied to both the shader and the panels.
- Cost controls. A 30 fps cap. `?bhEvery=2` draws the black hole every second frame and reprojects the last one in between. If the frame rate falls below 90% of the cap, the black hole's resolution drops in steps of 0.1, down to half. Under "reduce motion" one still frame is drawn; a hidden window stops the loop.
- Panels shown: clock (time, date, run timer, next monitor check, run name), cost (credits, dollars, credits per hour, per-model bars), "needs you" (light, count, items), a status legend, activity, child-session tiles, and pull requests.
- Not for shipping: a debug line with the frame rate and a "sample data" note; tiles that only mark a selection; lowercase labels; a 36 px clock; classic scripts instead of ES modules.

The first spike drew the black hole at half CSS resolution (at most 960 px wide), with up to 240 steps per ray and a simpler bloom. The owner judged it low quality (decision 6).

Measured GPU time per frame, at devicePixelRatio 2 on an Apple M5 Pro, with each frame forced to finish before timing:

| Window | First spike | High-quality spike |
| --- | --- | --- |
| 1440 x 900 | 0.9 ms | 7.9 ms |
| 1920 x 1080 | 1.3 ms | 11.8 ms |

Estimated, not measured: at 30 fps the GPU is busy about 24–35% of the time. A MacBook Pro would run warm with quiet fans, and a fanless MacBook Air would probably run hot. Drawing the black hole at half rate (`?bhEvery=2`) roughly halves the load. The owner accepted that High, the default, may make fanless laptops hot (decision 9).

## 8. Orchestrator's calls

These are choices made on the owner's behalf. He has not approved them.

1. Orchestrator's call: same plugin, server and data. The cockpit is a second page of the swarm-dashboard plugin, served by the same local server at its own path, for example `/cockpit`, from the same live snapshot feed and engine. No new data sources, no new writes, and the security rules in section 5 unchanged.
2. Orchestrator's call: how it opens. A quiet "Cockpit" control in the regular view's header opens the cockpit in a new browser window on the same swarm, for example `/cockpit?swarm=<id>`. In the app's side panel, where new windows do not open, the control falls back to showing or copying the address. The builder checks how this behaves in the canvas.
3. Orchestrator's call: tiles. One tile per child session, plus tiles for sub-agent units that are running or stuck, to match decision 8. Finished sub-agents appear only in the counts.
4. Orchestrator's call: clicking a tile opens or focuses the regular window on that unit's detail panel. If the regular window is gone, the cockpit opens a new one.
5. Orchestrator's call: quality.
   - The high-quality spike is the target look, with a 30 fps cap.
   - When frame time stays too high, an adaptive fallback lowers the resolution.
   - A quality setting: "High" is the default (decision 9). "Balanced" draws the black hole at half rate, and at full rate while the mouse moves. The choice is remembered per browser.
   - Rendering pauses when the window is hidden. "Reduce motion" gives a still frame.
6. Orchestrator's call: text.
   - Weights 400 and 500 only, no italic, and sentence-case labels without letter-spaced capitals.
   - Monospace is allowed for numbers and the clock.
   - Text keeps a contrast of at least 4.5:1 over the bright scene. This may mean more opaque glass behind the panels.
7. Orchestrator's call: checks. The automated layout check (overlap, tokens, contrast, padding) is extended to the cockpit at common window sizes, in Chrome and WebKit. A local, dev-only GPU frame-time smoke test reports the cost.
8. Orchestrator's call: spike code. The spike's shader and layout are a reference implementation that the builder may adapt. Nothing from the spike is committed as is.
9. Orchestrator's call: delivery. PR 3, stacked on PR 2, through the same process: a written plan, test-first tasks, independent review, and the owner's approval to open and to merge.

## 9. Left to the builder

Open points:

1. The exact arrangement of panels for each window size.
2. The minimum window size, and what the cockpit shows below it.
3. Shader optimisation.
4. Where the quality control goes.
5. How the "Cockpit" control behaves in the canvas (call 2). The canvas address may carry `session=` instead of `swarm=`, so the control should pass the swarm it resolved.
6. The GPU test strategy, including whether headless WebGL2 can run in tests.
7. Whether to port the spike's code or rewrite it. Either way it becomes ES modules under the server's asset rules, with no inline scripts.
8. WebKit and Safari specifics, such as half-float render targets (the spike falls back to 8-bit ones) and the sharpness of text under CSS 3D transforms.

Also found while writing this design:

9. Type sizes. The approved scale is 12, 14 and 18 px, and the spike's clock is 36 px. The plan should say whether the clock is an exception.
10. Status colours on dark glass. The approved fills are for a light page; the spike keeps them but dims idle and archived. Each needs a dark-glass value that keeps text at 4.5:1.
11. Where clicks on panels other than tiles lead, such as a "needs you" item or a PR row (call 4 covers tiles).
