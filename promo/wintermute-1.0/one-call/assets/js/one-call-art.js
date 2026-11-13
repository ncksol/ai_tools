// One Call: the shared drawing library (phones, the client, the crew, the appraisers).
// Loaded once by index.html; each scene reads what it needs from window.OC.
(function () {
  // ---- Shared drawing library for One Call (phones, the client, the crew, the appraisers) ----
  // A payphone handset in side view: earpiece cup at the top, curved grip, mouthpiece angled forward.
  // Local frame: earpiece face at x=54, cord leaves the grip at CORD_AT. About 300 units tall.
  const HANDSET_D =
    "M46 -42 Q54 -42 54 -34 L54 34 Q54 42 46 42 L22 36 C8 92 6 140 22 188 L50 180 Q57 178 60 184 L92 238 Q95 245 88 249 C62 262 30 263 8 250 C-16 202 -24 112 -12 40 C-19 18 -17 -16 1 -30 Z";
  const CORD_AT = [6, 254];
  const HANDSET = (o) => {
    const fill = o.fill || "#0a0c0f";
    const line = o.line || null;
    const lw = o.lw || 4;
    const t = 'translate(' + o.x + " " + o.y + ") rotate(" + (o.rot || 0) + ") scale(" + (o.flip ? -(o.s || 1) : o.s || 1) + " " + (o.s || 1) + ")";
    const grille = o.grille || line || "#3a424d";
    return (
      '<g transform="' + t + '">' +
      '<path d="' + HANDSET_D + '" fill="' + fill + '"' + (line ? ' stroke="' + line + '" stroke-width="' + lw + '" stroke-linejoin="round"' : "") + "/>" +
      '<path d="M50 -30 V30 M57 191 L85 238" stroke="' + grille + '" stroke-width="' + lw * 0.9 + '" stroke-linecap="round" opacity="0.8"/>' +
      "</g>"
    );
  };
  // Where a point in handset-local coordinates lands after HANDSET's transform.
  const HS_POINT = (o, p) => {
    const s = o.s || 1;
    const a = ((o.rot || 0) * Math.PI) / 180;
    const px = (o.flip ? -1 : 1) * p[0] * s;
    const py = p[1] * s;
    return [o.x + px * Math.cos(a) - py * Math.sin(a), o.y + px * Math.sin(a) + py * Math.cos(a)];
  };
  // A coiled phone cord along a sagging curve from (x1,y1) to (x2,y2), control point (cx,cy).
  const COIL = (x1, y1, cx, cy, x2, y2, loops, amp) => {
    const n = Math.max(80, loops * 14);
    let d = "";
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const bx = (1 - s) * (1 - s) * x1 + 2 * (1 - s) * s * cx + s * s * x2;
      const by = (1 - s) * (1 - s) * y1 + 2 * (1 - s) * s * cy + s * s * y2;
      let tx = 2 * (1 - s) * (cx - x1) + 2 * s * (x2 - cx);
      let ty = 2 * (1 - s) * (cy - y1) + 2 * s * (y2 - cy);
      const L = Math.hypot(tx, ty) || 1;
      tx /= L;
      ty /= L;
      const ph = 2 * Math.PI * loops * s;
      const ends = Math.min(1, s * 12, (1 - s) * 12);
      const x = bx + ends * (-ty * amp * Math.sin(ph) + tx * amp * 0.55 * Math.cos(ph));
      const y = by + ends * (tx * amp * Math.sin(ph) + ty * amp * 0.55 * Math.cos(ph));
      d += (i ? " L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }
    return d;
  };
  // A rotary desk phone with its handset in the cradle; base centred on (x, y) = bottom middle.
  const DESK_HS = (x, y, k) => ({ x: x + 95 * k, y: y - 152 * k, rot: 90, s: 0.86 * k, fill: "#0a0c0f", line: "#3a424d", lw: 3 / (0.86 * k), grille: "#3a424d" });
  const DESKPHONE = (x, y, k, withHandset) => {
    const P = (px, py) => (x + px * k).toFixed(1) + " " + (y + py * k).toFixed(1);
    let s =
      '<path d="M' + P(-110, 0) + " L" + P(-84, -78) + " Q" + P(-80, -88) + " " + P(-68, -88) + " L" + P(68, -88) + " Q" + P(80, -88) + " " + P(84, -78) + " L" + P(110, 0) + ' Z" fill="#1c2128" stroke="#0a0c0f" stroke-width="' + 4 * k + '"/>' +
      '<circle cx="' + (x).toFixed(1) + '" cy="' + (y - 44 * k).toFixed(1) + '" r="' + (30 * k).toFixed(1) + '" fill="#3a424d" stroke="#0a0c0f" stroke-width="' + 3 * k + '"/>' +
      '<circle cx="' + x.toFixed(1) + '" cy="' + (y - 44 * k).toFixed(1) + '" r="' + (10 * k).toFixed(1) + '" fill="#0a0c0f"/>' +
      '<path d="M' + P(-92, -86) + " L" + P(-88, -106) + " M" + P(92, -86) + " L" + P(88, -106) + '" stroke="#0a0c0f" stroke-width="' + 12 * k + '" stroke-linecap="round"/>';
    if (withHandset) s += HANDSET(DESK_HS(x, y, k));
    return s;
  };
  const INK = "#0a0c0f", SKIN = "#aeb4bb", SKIN_D = "#8f979f", SHIRT = "#e4e1d8", SHIRT_D = "#c4c3bc", TIE = "#2b313a", TROUSER = "#1c2128";
  const st = (w) => ' stroke="' + INK + '" stroke-width="' + (w || 4) + '" stroke-linejoin="round" stroke-linecap="round"';
  // The client's head in profile, facing right. Origin: the middle of the skull. eye: "open" | "sleepy" | "closed".
  const C_HEAD = (eye, noNeck) => {
    const eyes = {
      open: '<circle cx="47" cy="-7" r="3.6" fill="' + INK + '"/><path d="M40 -12 Q47 -15 54 -11" fill="none"' + st(3) + "/>",
      sleepy: '<path d="M39 -8 Q47 -13 55 -8" fill="none"' + st(3.5) + '/><path d="M41 -6 Q47 -3 53 -6" fill="none"' + st(2.5) + "/>",
      closed: '<path d="M39 -6 Q47 -1 55 -6" fill="none"' + st(3.5) + "/>",
    };
    return (
      (noNeck ? "" : '<path d="M-30 30 L-36 104 L22 108 L20 62 Z" fill="' + SKIN_D + '"' + st() + "/>") +
      '<path d="M-14 62 C-40 52 -60 22 -58 -10 C-56 -48 -24 -70 8 -68 C40 -66 58 -44 60 -20 L61 -12 C59 -7 60 -3 63 3 L74 21 C75 26 71 28 66 28 L63 30 C64 34 66 36 64 38 C61 40 62 43 64 46 C62 51 60 54 56 57 C54 65 46 71 34 71 C22 71 12 67 4 62 Z" fill="' + SKIN + '"' + st() + "/>" +
      '<path d="M52 -38 C48 -62 20 -78 -8 -76 C-24 -88 -44 -78 -46 -64 C-62 -56 -66 -30 -60 -8 C-60 12 -54 28 -44 36 C-40 22 -32 8 -24 -2 C-14 -18 14 -30 34 -32 C38 -22 44 -18 50 -20 C50 -26 52 -32 52 -38 Z" fill="' + INK + '"/>' +
      '<path d="M-36 -68 C-32 -88 -2 -96 18 -86 C30 -80 36 -72 34 -64 Z" fill="' + INK + '"/>' +
      '<ellipse cx="-8" cy="4" rx="10" ry="15" fill="' + SKIN + '"' + st(3.5) + '/><path d="M-10 -4 Q-3 4 -10 12" fill="none"' + st(2.5) + "/>" +
      '<path d="M33 -26 Q45 -31 57 -24" fill="none"' + st(4) + "/>" +
      eyes[eye || "open"] +
      '<path d="M33 -8 L-3 -4" fill="none"' + st(3.5) + "/>" +
      '<circle cx="46" cy="-7" r="14" fill="#ece8df" fill-opacity="0.18"' + st(4) + "/>" +
      '<path d="M38 -15 L44 -18" stroke="#ece8df" stroke-width="3" stroke-linecap="round" opacity="0.8"/>' +
      '<path d="M57 44 L64 44" fill="none"' + st(3) + "/>"
    );
  };
  // A fist round a bar, seen from the back of the hand. Origin: the middle of the grip. The bar runs along local x.
  const C_FIST = (fill) =>
    '<path d="M-30 -24 C-30 -36 -18 -40 -6 -38 L22 -36 C34 -34 38 -24 36 -12 L34 18 C32 32 22 38 8 38 L-14 38 C-28 38 -34 28 -32 14 Z" fill="' + (fill || SKIN) + '"' + st() + "/>" +
    '<path d="M-22 -36 V-18 M-6 -38 V-18 M10 -37 V-18 M24 -35 V-18" fill="none"' + st(3) + "/>" +
    '<path d="M-32 6 C-44 4 -46 -10 -36 -16 L-24 -14" fill="' + (fill || SKIN) + '"' + st(3.5) + "/>";
  // Tapered limbs with one clean outline: pass 1 draws every piece in ink, pass 2 fills it.
  const LIMBS = (segs, fill) => {
    const shape = (a, b, w1, w2) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
      return '<path d="M' + (a[0] + nx * w1) + " " + (a[1] + ny * w1) + " L" + (b[0] + nx * w2) + " " + (b[1] + ny * w2) + " L" + (b[0] - nx * w2) + " " + (b[1] - ny * w2) + " L" + (a[0] - nx * w1) + " " + (a[1] - ny * w1) + ' Z"/>' +
        '<circle cx="' + a[0] + '" cy="' + a[1] + '" r="' + w1 + '"/><circle cx="' + b[0] + '" cy="' + b[1] + '" r="' + w2 + '"/>';
    };
    const all = segs.map((s) => shape(s[0], s[1], s[2], s[3])).join("");
    return '<g fill="' + INK + '" stroke="' + INK + '" stroke-width="8" stroke-linejoin="round">' + all + "</g>" + '<g fill="' + fill + '">' + all + "</g>";
  };
  const CUFF = (p, ang, w) => '<rect x="' + (p[0] - w) + '" y="' + (p[1] - 11) + '" width="' + 2 * w + '" height="22" rx="7" fill="' + SHIRT_D + '"' + st(3) + ' transform="rotate(' + ang + " " + p[0] + " " + p[1] + ')"/>';
  // Seated torso in profile, facing right; origin at the desk edge in front of his belly.
  const C_TORSO = () =>
    '<path d="M-104 -214 C-132 -176 -146 -86 -150 20 L-6 20 C-8 -40 0 -116 -10 -164 C-16 -198 -40 -216 -64 -220 C-82 -222 -94 -220 -104 -214 Z" fill="' + SHIRT + '"' + st() + "/>" +
    '<path d="M-60 -206 L-48 -206 L-14 -52 L-26 -34 L-38 -54 Z" fill="' + TIE + '"' + st(3.5) + "/>" +
    '<path d="M-88 -224 L-70 -198 L-50 -222 L-60 -232 L-70 -214 L-80 -232 Z" fill="' + SHIRT_D + '"' + st(3) + "/>";
  // The client, seated, a handset at his ear, held low by the chin. Facing right.
  const C_PHONE = (eye) => {
    const hs = { x: -20.9, y: 24.7, rot: -58, s: 0.45, fill: INK, grille: "#3a424d" };
    const hand = [-18, -232];
    return (
      C_TORSO() +
      '<g transform="translate(-64 -296)">' + C_HEAD(eye) + HANDSET(hs) + "</g>" +
      LIMBS([[[-78, -190], [2, -82], 27, 22]], SHIRT) +
      LIMBS([[[2, -82], [hand[0] + 4, hand[1] + 26], 18, 13]], SKIN) +
      CUFF([2, -82], -40, 24) +
      '<g transform="translate(' + hand.join(" ") + ') rotate(32) scale(0.62)">' + C_FIST() + "</g>"
    );
  };
  // Asleep at the desk, cheek on his folded forearms, hands tucked away. Facing right; origin at the desk edge.
  const C_SLEEP = () =>
    '<path d="M-176 20 L-176 -250 L-150 -250 L-150 20 Z" fill="#14181d"' + st() + "/>" +
    '<path d="M-150 20 C-158 -40 -150 -116 -116 -150 C-84 -178 -34 -174 -4 -140 C10 -120 8 -60 6 20 Z" fill="' + SHIRT + '"' + st() + "/>" +
    LIMBS([[[-84, -116], [-40, -22], 27, 22]], SHIRT) +
    LIMBS([[[-40, -22], [150, -22], 22, 22]], SHIRT) +
    LIMBS([[[10, -58], [176, -56], 22, 22]], SHIRT) +
    CUFF([150, -22], 90, 22) + CUFF([176, -56], 90, 22) +
    '<g transform="translate(64 -132) rotate(28)">' + C_HEAD("closed", true) + "</g>";
  // Standing, facing right, the right arm holding a folder out. Origin at the skull centre.
  const C_STAND = () => ({
    body:
      LIMBS([[[-22, 500], [-36, 740], 34, 28], [[-36, 740], [-50, 964], 28, 21]], TROUSER) +
      LIMBS([[[16, 500], [52, 736], 34, 28], [[52, 736], [40, 964], 28, 21]], TROUSER) +
      '<path d="M-74 948 C-74 940 -40 938 -28 944 L-18 976 L-80 976 Z M18 948 C22 940 56 940 66 946 C84 952 92 962 92 976 L18 976 Z" fill="' + INK + '"/>' +
      '<path d="M-64 128 C-92 200 -88 380 -60 500 L54 500 C70 380 74 220 50 140 C32 110 -30 106 -64 128 Z" fill="' + SHIRT + '"' + st() + "/>" +
      '<path d="M8 114 L22 114 L48 330 L36 350 L24 330 Z" fill="' + TIE + '"' + st(3.5) + "/>" +
      '<path d="M-62 466 L56 466 L58 496 L-60 496 Z" fill="' + TROUSER + '"' + st(3) + "/>" +
      C_HEAD("open") +
      '<path d="M-16 104 L4 130 L26 104 L16 92 L4 114 L-6 92 Z" fill="' + SHIRT_D + '"' + st(3) + "/>",
    arm: LIMBS([[[-8, 156], [70, 302], 30, 25]], SHIRT) + LIMBS([[[70, 302], [192, 352], 20, 16]], SKIN) + CUFF([70, 302], -62, 27),
    palm: "",
    thumb:
      '<path d="M188 338 C196 322 220 316 250 318 L254 400 C230 406 206 400 196 386 C186 372 184 354 188 338 Z" fill="' + SKIN + '"' + st() + "/>" +
      [[248, 330, 284, 327, 17], [250, 350, 290, 349, 18], [250, 370, 288, 371, 18], [248, 390, 280, 393, 16]]
        .map(([x1, y1, x2, y2, w]) =>
          '<path d="M' + x1 + " " + y1 + " L" + x2 + " " + y2 + '" stroke="' + INK + '" stroke-width="' + (w + 8) + '" stroke-linecap="round"/>' +
          '<path d="M' + x1 + " " + y1 + " L" + x2 + " " + y2 + '" stroke="' + SKIN + '" stroke-width="' + w + '" stroke-linecap="round"/>' +
          '<path d="M' + (x1 + 16) + " " + (y1 - w / 2 + 3) + " Q" + (x1 + 20) + " " + y1 + " " + (x1 + 16) + " " + (y1 + w / 2 - 3) + '" fill="none"' + st(2.5) + "/>")
        .join(""),
  });
  // A crew member: black trench coat and fedora, front view, feet at (0,0), about 400 units tall.
  // arm: the right arm ("down" | "phone" | "point" | "reach" | "hold"); prop: carried in the left hand.
  const PROPS = {
    stethoscope: '<g fill="none" stroke-linecap="round"><path d="M0 0 C-16 -8 -20 -24 -12 -36 M0 0 C16 -8 20 -24 12 -36 M0 0 C-8 30 8 52 0 74" stroke="' + INK + '" stroke-width="10"/><path d="M0 0 C-16 -8 -20 -24 -12 -36 M0 0 C16 -8 20 -24 12 -36 M0 0 C-8 30 8 52 0 74" stroke="#c9ccd1" stroke-width="5"/></g><circle cx="0" cy="84" r="13" fill="#c9ccd1"' + st(3.5) + '/><circle cx="0" cy="84" r="5" fill="' + INK + '"/>',
    stamp: '<ellipse cx="0" cy="4" rx="16" ry="12" fill="#c9ccd1"' + st(3.5) + '/><rect x="-6" y="14" width="12" height="34" fill="#8a929c"' + st(3) + '/><rect x="-26" y="46" width="52" height="16" rx="3" fill="#c9ccd1"' + st(3.5) + '/><rect x="-24" y="62" width="48" height="7" fill="#b3262e"' + st(2) + "/>",
    books: '<g' + st(3.5) + '><rect x="-40" y="6" width="80" height="17" fill="#c9ccd1"/><rect x="-34" y="23" width="72" height="17" fill="#8a929c"/><rect x="-42" y="40" width="82" height="17" fill="#ece8df"/></g><path d="M-30 14 H30 M-24 31 H30 M-32 48 H30" stroke="' + INK + '" stroke-width="2" opacity="0.5"/>',
    stopwatch: '<path d="M0 0 V14" stroke="#c9ccd1" stroke-width="4"/><rect x="-6" y="12" width="12" height="9" fill="#c9ccd1"' + st(3) + '/><circle cx="0" cy="44" r="23" fill="#ece8df"' + st(4) + '/><path d="M0 44 L0 28 M0 44 L11 50" stroke="' + INK + '" stroke-width="3.5" stroke-linecap="round"/>',
  };
  const CREW = (o) => {
    const arms = {
      down: "M30,-290 C46,-240 50,-190 46,-150",
      phone: "M32,-290 Q80,-262 48,-318",
      point: "M30,-292 Q90,-300 132,-322",
      reach: "M30,-290 Q86,-262 132,-236",
      hold: "M30,-290 Q60,-236 96,-220",
    };
    const arm = (d) => '<path d="' + d + '" fill="none" stroke="#5b6470" stroke-width="32" stroke-linecap="round"/><path d="' + d + '" fill="none" stroke="' + INK + '" stroke-width="26" stroke-linecap="round"/>';
    return (
      '<g fill="' + INK + '"><path d="M-34,-100 L-10,-100 L-8,-10 L-32,-10 Z M8,-100 L32,-100 L34,-10 L10,-10 Z"/>' +
      '<path d="M-38,-12 L-4,-12 L4,0 L-38,0 Z M8,-12 L40,-12 L52,0 L8,0 Z"/>' +
      '<path d="M-48,-300 C-60,-250 -64,-170 -68,-96 L68,-96 C64,-170 60,-250 48,-300 C30,-312 -30,-312 -48,-300 Z"/>' +
      '<path d="M-32,-300 L-22,-334 L2,-318 L24,-334 L36,-300 Z"/><circle cx="2" cy="-334" r="23"/>' +
      '<ellipse cx="2" cy="-352" rx="50" ry="9"/><path d="M-28,-352 C-28,-388 -18,-396 2,-396 C22,-396 32,-388 32,-352 Z"/></g>' +
      '<path d="M-48,-300 C-60,-250 -64,-170 -68,-96 M-28,-352 C-28,-388 -18,-396 2,-396" fill="none" stroke="#8a929c" stroke-width="4" stroke-linecap="round"/>' +
      arm("M-30,-290 C-46,-240 -50,-190 -46,-150") + arm(arms[o.arm || "down"]) +
      (o.arm === "phone" ? HANDSET(FIG_HS) : "") +
      (o.prop ? '<g transform="translate(-46 -146)">' + PROPS[o.prop] + "</g>" : "") +
      CHAND("fist", -47, -136, 96, 0.42, true) + CHAND.apply(null, HANDS[o.arm || "down"])
    );
  };
  // Black-gloved crew hands with a grey rim, so they read against the silhouette.
  // A fist grips a bar that runs along its local x; "point" has the index finger out along local x.
  const RIM = "#5b6470";
  const rs = (w) => ' stroke="' + RIM + '" stroke-width="' + (w || 4) + '" stroke-linejoin="round" stroke-linecap="round"';
  const CFIST = () =>
    '<path d="M-30 -24 C-30 -36 -18 -40 -6 -38 L22 -36 C34 -34 38 -24 36 -12 L34 18 C32 32 22 38 8 38 L-14 38 C-28 38 -34 28 -32 14 Z" fill="' + INK + '"' + rs(5) + "/>" +
    '<path d="M-22 -36 V-16 M-6 -38 V-16 M10 -37 V-16 M24 -35 V-16" fill="none"' + rs(4) + "/>" +
    '<path d="M-32 6 C-46 4 -48 -12 -36 -18 L-24 -14" fill="' + INK + '"' + rs(4.5) + "/>";
  const CPOINT = () =>
    '<path d="M24 -17 L88 -17 C99 -17 99 3 88 3 L24 3 Z" fill="' + INK + '"' + rs(5) + "/>" +
    '<path d="M-16 -22 C-16 -32 0 -34 24 -30 C40 -26 44 -6 40 10 C36 26 20 30 4 30 L-16 26 Z" fill="' + INK + '"' + rs(5) + "/>" +
    '<path d="M18 4 C32 4 36 12 32 18 M14 14 C28 16 30 24 24 28" fill="none"' + rs(4) + "/>" +
    '<path d="M2 -30 C6 -44 22 -48 30 -40 C34 -34 28 -26 20 -26" fill="' + INK + '"' + rs(4.5) + "/>";
  const CHAND = (kind, x, y, rot, s, flip) =>
    '<g transform="translate(' + x + " " + y + ")" + (flip ? " scale(-1 1)" : "") + " rotate(" + rot + ") scale(" + s + ')">' + (kind === "point" ? CPOINT() : CFIST()) + "</g>";
  // Where each right-arm pose puts its hand: [kind, x, y, rotation, scale].
  const HANDS = {
    down: ["fist", 47, -136, 96, 0.42],
    phone: ["fist", 42, -334, 68, 0.42],
    point: ["point", 132, -322, -28, 0.46],
    reach: ["fist", 148, -230, 6, 0.44],
    hold: ["fist", 100, -214, 0, 0.42],
  };
  // White gloves for the appraisers. Facing right; origin at the wrist.
  const GLOVE = (pose, fill) => {
    const f = fill || "#ece8df";
    const cuff = '<path d="M-56 -30 L-14 -22 L-14 22 L-56 30 Z" fill="' + f + '"' + st(4) + "/>";
    if (pose === "point")
      return cuff +
        '<path d="M24 -16 L86 -16 C96 -16 96 2 86 2 L24 2 Z" fill="' + f + '"' + st(4) + "/>" +
        '<path d="M-16 -22 C-16 -32 0 -34 24 -30 C40 -26 44 -6 40 10 C36 26 20 30 4 30 L-16 26 Z" fill="' + f + '"' + st(4) + "/>" +
        '<path d="M20 4 C32 4 36 12 32 18 M16 14 C28 16 30 24 24 28" fill="none"' + st(3) + "/>" +
        '<path d="M2 -30 C6 -44 22 -48 30 -40 C34 -34 28 -26 20 -26" fill="' + f + '"' + st(3.5) + "/>" +
        '<path d="M-6 -14 L10 -12 M-6 0 L12 0 M-6 14 L10 12" stroke="' + INK + '" stroke-width="2.5" opacity="0.6"/>';
    return cuff + '<g transform="translate(18 0) rotate(-90)">' + C_FIST(f) + "</g>";
  };
  // A hat on a head in shadow, for appraisers seen from behind. Origin at the crown base; style: fedora | bowler | boater.
  const HAT = (style, fill) => {
    const f = fill;
    const crowns = {
      fedora: '<path d="M-50 0 C-50 -58 -36 -74 0 -74 C36 -74 50 -58 50 0 Z" fill="' + f + '"' + st(5) + '/><path d="M-30 -66 Q0 -54 30 -66" fill="none"' + st(3) + "/>",
      bowler: '<path d="M-48 0 C-48 -86 48 -86 48 0 Z" fill="' + f + '"' + st(5) + "/>",
      boater: '<rect x="-50" y="-46" width="100" height="46" fill="' + f + '"' + st(5) + "/>",
    };
    return (
      '<path d="M-70 10 C-70 70 -50 120 0 130 C50 120 70 70 70 10 Z" fill="' + INK + '"/>' +
      crowns[style] + '<rect x="-50" y="-16" width="100" height="14" fill="' + INK + '"/>' +
      '<ellipse cx="0" cy="2" rx="' + (style === "bowler" ? 74 : 92) + '" ry="16" fill="' + f + '"' + st(5) + "/>"
    );
  };
  const FIG_HS = { x: 30, y: -362, rot: -22, s: 0.27, flip: true, fill: "#0a0c0f", line: "#8a929c", lw: 9, grille: "#8a929c" };
  const C_PHONE_HS = { x: -20.9, y: 24.7, rot: -58, s: 0.45, fill: INK, grille: "#3a424d" };
  // Points on the seated client (C_PHONE), in scene coordinates, for a client drawn at (cx, Y) facing left at scale s.
  const C_AT = (cx, Y, s, p) => [cx - s * p[0], Y + s * p[1]];
  const C_EAR = (cx, Y, s) => C_AT(cx, Y, s, [-72, -292]);
  const C_MOUTH = (cx, Y, s) => C_AT(cx, Y, s, [-4, -252]);
  // The client's desk at home, side view; he faces left. o: { x0, cx, s, Y, wx, lampX, phoneX, dawn, eye, folderX }
  const DESK_SCENE = (o) => {
    const Y = o.Y || 826, s = o.s || 1.45, cx = o.cx, x0 = o.x0 || 0;
    const sky = o.dawn ? "#d9dde0" : "#262c34";
    let g = '<rect x="' + x0 + '" y="0" width="' + (1920 - x0) + '" height="1080" fill="' + (o.dawn ? "#3a424d" : "#1b1f25") + '"/>';
    const wx = o.wx;
    g += '<rect x="' + wx + '" y="104" width="440" height="392" fill="' + INK + '"/><rect x="' + (wx + 12) + '" y="116" width="416" height="368" fill="' + sky + '"/>';
    g += '<g fill="' + (o.dawn ? "#8a929c" : "#141820") + '"><rect x="' + (wx + 12) + '" y="330" width="90" height="154"/><rect x="' + (wx + 110) + '" y="280" width="120" height="204"/><rect x="' + (wx + 240) + '" y="350" width="80" height="134"/><rect x="' + (wx + 330) + '" y="300" width="98" height="184"/></g>';
    if (!o.dawn) g += '<g fill="#ece8df" opacity="0.5"><rect x="' + (wx + 130) + '" y="300" width="9" height="14"/><rect x="' + (wx + 152) + '" y="330" width="9" height="14"/><rect x="' + (wx + 190) + '" y="300" width="9" height="14"/><rect x="' + (wx + 350) + '" y="320" width="9" height="14"/><rect x="' + (wx + 36) + '" y="356" width="9" height="14"/></g>';
    g += '<path d="M' + (wx + 220) + " 116 V484 M" + (wx + 12) + " 300 H" + (wx + 428) + '" stroke="' + INK + '" stroke-width="10"/>';
    if (o.lampX) {
      const L = o.lampX;
      if (!o.dawn) g += '<polygon points="' + (L - 10) + "," + (Y - 266) + " " + (L - 150) + "," + Y + " " + (L + 160) + "," + Y + " " + (L + 84) + "," + (Y - 266) + '" fill="#ece8df" opacity="0.13"/>';
      g += '<path d="M' + (L + 50) + " " + Y + " L" + (L + 72) + " " + (Y - 186) + " L" + (L + 30) + " " + (Y - 266) + '" fill="none" stroke="' + INK + '" stroke-width="10" stroke-linejoin="round"/>' +
        '<path d="M' + (L - 20) + " " + (Y - 254) + " L" + (L + 12) + " " + (Y - 310) + " L" + (L + 90) + " " + (Y - 296) + " L" + (L + 98) + " " + (Y - 240) + ' Z" fill="' + INK + '"/>' +
        (o.dawn ? "" : '<ellipse cx="' + (L + 40) + '" cy="' + (Y - 242) + '" rx="54" ry="10" fill="#ece8df" opacity="0.8"/>');
    }
    const px = o.phoneX;
    if (o.sleep) {
      g += '<g' + (o.clientId ? ' id="' + o.clientId + '"' : "") + '><g transform="translate(' + cx + " " + Y + ") scale(" + -s + " " + s + ')">' + C_SLEEP() + "</g></g>";
    } else {
      g += '<g transform="translate(' + cx + " " + Y + ") scale(" + -s + " " + s + ')">' + C_PHONE(o.eye) + "</g>";
      const hp = HS_POINT(C_PHONE_HS, CORD_AT);
      const c0 = C_AT(cx, Y, s, [hp[0] - 64, hp[1] - 296]);
      g += '<path d="' + COIL(c0[0], c0[1], (c0[0] + px) / 2 + 40, Y - 20, px + 60, Y - 18, 15, 8) + '" fill="none" stroke="' + INK + '" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    g += '<rect x="' + x0 + '" y="' + Y + '" width="' + (1920 - x0) + '" height="12" fill="#3a424d"/><rect x="' + x0 + '" y="' + (Y + 10) + '" width="' + (1920 - x0) + '" height="' + (1070 - Y) + '" fill="#262b32"/>';
    g += '<g' + (o.phoneId ? ' id="' + o.phoneId + '"' : "") + '>' + DESKPHONE(px, Y + 2, 0.75, !!o.sleep) + "</g>";
    if (o.mugX) g += '<rect x="' + o.mugX + '" y="' + (Y - 66) + '" width="56" height="68" rx="6" fill="#5b6470"' + st(4) + '/><path d="M' + (o.mugX + 56) + " " + (Y - 50) + " C" + (o.mugX + 80) + " " + (Y - 50) + " " + (o.mugX + 80) + " " + (Y - 14) + " " + (o.mugX + 56) + " " + (Y - 14) + '" fill="none" stroke="' + INK + '" stroke-width="6"/>';
    if (o.folderX) g += JOB_ON_DESK(o.folderX, Y, 1);
    return g;
  };
  // The finished job lying on a desk: a closed folder, stamped and checked. Left edge x, desk top Y.
  const JOB_ON_DESK = (x, Y, k) =>
    '<g transform="translate(' + x + " " + Y + ") scale(" + k + ')">' +
    '<rect x="10" y="-26" width="330" height="22" fill="#d9d2c1" stroke="#0a0c0f" stroke-width="4" transform="rotate(-1.5 175 -15)"/>' +
    '<rect x="0" y="-52" width="340" height="30" rx="5" fill="#e2dccd" stroke="#0a0c0f" stroke-width="5"/>' +
    '<rect x="20" y="-82" width="300" height="34" rx="5" fill="#ece8df" stroke="#0a0c0f" stroke-width="5"/>' +
    '<path d="M150 -82 V-4 M0 -36 H340" stroke="#b3262e" stroke-width="5"/>' +
    '<text class="lg" x="36" y="-55" font-size="32" letter-spacing="2" fill="#b3262e">THE JOB</text>' +
    '<g transform="rotate(-6 252 -64)"><rect x="186" y="-86" width="132" height="40" fill="#ece8df" stroke="#58cfc2" stroke-width="4"/><text class="lg" x="252" y="-54" text-anchor="middle" font-size="34" letter-spacing="2" fill="#58cfc2">CHECKED</text></g></g>';
  // ---- end of library ----
  window.OC = { HANDSET_D, CORD_AT, HANDSET, HS_POINT, COIL, DESK_HS, DESKPHONE, INK, st, C_HEAD, C_FIST, LIMBS, CUFF, C_TORSO, C_PHONE, C_SLEEP, C_STAND, PROPS, CREW, GLOVE, HAT, FIG_HS, C_PHONE_HS, C_AT, C_EAR, C_MOUTH, DESK_SCENE, JOB_ON_DESK, SKIN, SKIN_D, SHIRT, SHIRT_D, TIE, TROUSER };
})();
