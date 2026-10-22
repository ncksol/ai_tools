/**
 * The cockpit's scene in GLSL ES 3.00, drawn in three steps.
 * 1. HOLE, in HDR at the window's device resolution: each pixel traces a light ray around a non-rotating black hole
 *    (the orbit equation u'' + u = 1.5 u², with u = 1/r and a Schwarzschild radius of 1, integrated with RK4 up to
 *    MAX_STEPS steps) and adds the disk at every exact crossing of its plane, so the direct and lensed images appear.
 *    Pixels in the photon-ring band are traced four more times, so the ring stays thin.
 * 2. Bloom: PREFILTER keeps the bright part with a Karis average against fireflies, then DOWN and UP run a six-level chain.
 * 3. FINAL: the room (a cylindrical window with mullions, a dark ceiling with a peach light line, a desk that reflects
 *    the glow), ACES tone mapping, a vignette, sRGB and a one-step dither against banding.
 */
export const SCENE = Object.freeze({
  holeDistance: 21, inclination: 0.145, holePitch: 0.12, roll: -0.06, diskInner: 2.55, diskOuter: 12.5, maxSteps: 380,
  ringImpact: 2.66, ringBand: 0.22, starSpin: 0.0035,
  roomRadius: 1500, ceilingY: 720, deskY: -330, mullionHalf: 11,
  exposure: 0.85, bloom: 0.8, bloomLevels: 6, bloomThreshold: 0.9, bloomKnee: 0.6,
});

/** A GLSL float literal. */
const f = value => (Number.isInteger(value) ? `${value}.0` : String(value));

export const VERTEX = `#version 300 es
const vec2 CORNERS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(CORNERS[gl_VertexID], 0.0, 1.0); }`;

const COMMON = `
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const HOLE = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uDesign;
uniform float uFocal;
uniform float uTime;
uniform mat3 uView;
uniform float uPix;
out vec4 outColor;
${COMMON}
const float PI = 3.14159265;
const float R0 = ${f(SCENE.holeDistance)};
const float INCL = ${f(SCENE.inclination)};
const float HOLE_PITCH = ${f(SCENE.holePitch)};
const float ROLL = ${f(SCENE.roll)};
const float RIN = ${f(SCENE.diskInner)};
const float ROUT = ${f(SCENE.diskOuter)};
const int MAX_STEPS = ${SCENE.maxSteps};

float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 w = fract(p);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

// Value noise periodic in x, so the disk's pattern wraps cleanly around the orbit.
float vnoisePeriodic(vec2 p, float period) {
  vec2 i = floor(p); vec2 w = fract(p);
  vec2 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float i0 = mod(i.x, period), i1 = mod(i.x + 1.0, period);
  float a = hash12(vec2(i0, i.y)), b = hash12(vec2(i1, i.y));
  float c = hash12(vec2(i0, i.y + 1.0)), d = hash12(vec2(i1, i.y + 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Orbit-stretched fbm. An octave fades to its mean once it would alias, and the loop stops when the rest would add only their mean.
const float FBM_TOTAL = 1.0804;
float streaks(float r, float ang, float footprint) {
  float x = fract((ang + 0.35 * log(r)) / 6.2831853);
  float n = 0.0, amp = 0.5, used = 0.0, freq = 3.0, period = 10.0;
  for (int i = 0; i < 6; i++) {
    float cycles = max(freq, period / (6.2831853 * r)) * footprint;
    float detail = 1.0 - smoothstep(0.15, 0.4, cycles);
    if (detail <= 0.0) break;
    n += amp * mix(0.5, vnoisePeriodic(vec2(x * period, r * freq + float(i) * 7.31), period), detail);
    used += amp;
    freq *= 2.1; period *= 2.0; amp *= 0.55;
  }
  return (n + 0.5 * (FBM_TOTAL - used)) / FBM_TOTAL;
}

vec3 diskColor(float t) {
  vec3 c = mix(vec3(1.00, 0.30, 0.10), vec3(1.00, 0.56, 0.28), smoothstep(0.25, 0.6, t));
  c = mix(c, vec3(1.00, 0.80, 0.62), smoothstep(0.6, 1.05, t));
  return mix(c, vec3(0.80, 0.88, 1.00), smoothstep(1.2, 1.9, t));
}

// The disk's colour and opacity where a ray crosses its plane at q, travelling along dir after pathLen of path.
vec4 disk(vec3 q, vec3 dir, float pathLen, float smoothness) {
  float r = length(q.xz);
  if (r < RIN || r > ROUT) return vec4(0.0);
  float ang = atan(q.z, q.x);
  float omega = 0.6 * pow(r, -1.5);
  float period = 120.0;
  float phase = fract(uTime / period);
  float weightA = 1.0 - abs(2.0 * phase - 1.0);
  float footprint = uPix * pathLen / max(abs(dir.y), 0.04);
  float n = 0.5;
  if (smoothness < 0.99) {
    float nA = streaks(r, ang - omega * phase * period, footprint);
    float nB = streaks(r + 5.3, ang - omega * fract(phase + 0.5) * period + 1.7, footprint);
    // Two patterns cross-fade so the turning never repeats visibly; this keeps the contrast steady through the fade.
    n = 0.5 + (mix(nB, nA, weightA) - 0.5) / sqrt(weightA * weightA + (1.0 - weightA) * (1.0 - weightA));
  }
  float inner = smoothstep(RIN, RIN + 0.7, r);
  float outer = 1.0 - smoothstep(5.0, ROUT, r);
  float profile = inner * outer * pow(3.0 / r, 1.5);
  float filament = mix(smoothstep(0.30, 0.80, n), 0.42, smoothness);
  float density = profile * (0.10 + 1.35 * filament);
  vec3 velocity = normalize(vec3(-q.z, 0.0, q.x));
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.5)), 0.62);
  float gamma = inversesqrt(1.0 - beta * beta);
  float doppler = mix(1.0, 1.0 / (gamma * (1.0 - beta * dot(velocity, -dir))), 0.6);
  float shift = doppler * sqrt(max(1.0 - 1.0 / r, 0.05));
  vec3 c = diskColor(pow(3.0 / r, 0.65) * shift) * density * pow(shift, 2.6) * 6.0;
  return vec4(c, clamp(profile * (2.2 + 3.0 * filament), 0.0, 0.985));
}

vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z); }

// The ray through a pixel, in the black hole's frame.
vec3 rayDir(vec2 frag) {
  vec2 p = frag / uRes * uDesign - 0.5 * uDesign;
  vec3 rd = uView * normalize(vec3(p, -uFocal));
  float cp = cos(HOLE_PITCH), sp = sin(HOLE_PITCH);
  rd = vec3(rd.x, rd.y * cp + rd.z * sp, -rd.y * sp + rd.z * cp);
  float cr = cos(ROLL), sr = sin(ROLL);
  rd.xy = vec2(cr * rd.x - sr * rd.y, sr * rd.x + cr * rd.y);
  vec3 up = vec3(0.0, cos(INCL), -sin(INCL));
  vec3 fwd = vec3(0.0, -sin(INCL), -cos(INCL));
  return normalize(vec3(1.0, 0.0, 0.0) * rd.x + up * rd.y - fwd * rd.z);
}

// Trace a null geodesic in its orbital plane: u = 1/r, u'' + u = 1.5 u².
void trace(vec3 dir, out vec3 col, out float alpha, out vec3 escapeDir, out float escaped, out float impact) {
  vec3 cam = R0 * vec3(0.0, sin(INCL), cos(INCL));
  vec3 e1 = cam / R0;
  float dr = dot(dir, e1);
  vec3 tv = dir - dr * e1;
  float dt = length(tv);
  vec3 e2 = dt > 1e-6 ? tv / dt : normalize(cross(e1, vec3(1.0, 0.0, 0.0)));
  dt = max(dt, 1e-6);
  impact = R0 * dt;
  float u = 1.0 / R0;
  float du = -u * dr / dt;
  float phi = 0.0;
  float nextCross = mod(atan(-e1.y, e2.y), PI);
  if (nextCross < 1e-4) nextCross += PI;
  col = vec3(0.0); alpha = 0.0; escaped = 0.0;
  float path = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    float h = clamp(0.2 / (1.0 + 12.0 * u), 0.012, 0.2);
    bool crossing = false;
    if (phi + h >= nextCross) { h = max(nextCross - phi, 1e-5); crossing = true; }
    float k1u = du,               k1v = 1.5 * u * u - u;
    float u2 = u + 0.5 * h * k1u, v2 = du + 0.5 * h * k1v;
    float k2u = v2,               k2v = 1.5 * u2 * u2 - u2;
    float u3 = u + 0.5 * h * k2u, v3 = du + 0.5 * h * k2v;
    float k3u = v3,               k3v = 1.5 * u3 * u3 - u3;
    float u4 = u + h * k3u,       v4 = du + h * k3v;
    float k4u = v4,               k4v = 1.5 * u4 * u4 - u4;
    u += h * (k1u + 2.0 * k2u + 2.0 * k3u + k4u) / 6.0;
    du += h * (k1v + 2.0 * k2v + 2.0 * k3v + k4v) / 6.0;
    phi += h;
    if (u >= 1.0) break;
    if (u <= 0.0) { escaped = 1.0; break; }
    float r = 1.0 / u;
    float cph = cos(phi), sph = sin(phi);
    vec3 radial = cph * e1 + sph * e2;
    float drdphi = -du / (u * u);
    path += h * sqrt(r * r + drdphi * drdphi);
    if (crossing) {
      nextCross += PI;
      if (r > RIN && r < ROUT) {
        vec3 tangent = -sph * e1 + cph * e2;
        vec3 travel = normalize(drdphi * radial + r * tangent);
        // Direct images keep the streaks; the photon ring (orbits past about 1.3 half-turns) is smooth.
        vec4 s = disk(r * radial, travel, path, smoothstep(1.3 * PI, 1.7 * PI, phi));
        col += (1.0 - alpha) * s.rgb;
        alpha += (1.0 - alpha) * s.a;
      }
    }
    if (alpha > 0.995) break;
    if (u < 0.035 && du < 0.0) { phi += atan(u, -du); escaped = 1.0; break; }
  }
  escapeDir = cos(phi) * e1 + sin(phi) * e2;
}

// Point stars, measured in screen pixels through the local lensing distortion, so magnified stars stay round.
vec3 starLayer(vec3 d, vec3 dx, vec3 dy, float scale, float threshold, float seed, float bright, float sigma) {
  vec3 id = floor(d * scale);
  float h = hash13(id + seed);
  if (h < threshold) return vec3(0.0);
  vec3 star = (id + 0.5 + (hash33(id + seed + 7.0) - 0.5) * 0.4) / scale;
  vec3 o = normalize(star) - d;
  o -= d * dot(o, d);
  float a = dot(dx, dx), b = dot(dx, dy), c = dot(dy, dy);
  float det = max(a * c - b * b, 1e-30);
  vec2 rhs = vec2(dot(dx, o), dot(dy, o));
  vec2 px = vec2(c * rhs.x - b * rhs.y, a * rhs.y - b * rhs.x) / det;
  float k = pow((h - threshold) / (1.0 - threshold), 4.0);
  vec3 tint = mix(vec3(1.0, 0.86, 0.74), vec3(0.78, 0.86, 1.0), hash13(id + seed + 3.0));
  return tint * bright * k * exp(-dot(px, px) / (2.0 * sigma * sigma));
}

void main() {
  vec3 col, escapeDir; float alpha, escaped, b;
  trace(rayDir(gl_FragCoord.xy), col, alpha, escapeDir, escaped, b);
  // Stars come from the centre sample: derivatives need uniform control flow.
  vec3 d = rotY(escapeDir, uTime * ${f(SCENE.starSpin)});
  vec3 dx = dFdx(d), dy = dFdy(d);
  float area = length(cross(dx, dy));
  float jump = max(length(dx), length(dy));
  vec3 sky = vec3(0.0);
  if (escaped > 0.5 && jump < 25.0 * uPix && area > 1e-14) {
    float magnification = clamp((uPix * uPix) / area, 0.25, 6.0);
    float radiansPerDesignPx = 1.0 / uFocal;
    vec3 stars = starLayer(d, dx, dy, 1.0 / (radiansPerDesignPx * 9.0), 0.955, 0.0, 3.0, 0.65)
               + starLayer(d, dx, dy, 1.0 / (radiansPerDesignPx * 6.0), 0.975, 11.0, 1.6, 0.65)
               + starLayer(d, dx, dy, 1.0 / (radiansPerDesignPx * 4.0), 0.985, 23.0, 0.8, 0.65);
    sky += stars * sqrt(magnification);
    float band = exp(-pow(dot(d, normalize(vec3(0.35, 1.0, 0.25))) * 3.2, 2.0));
    float n = vnoise(d * 3.0) * 0.6 + vnoise(d * 7.0) * 0.4;
    sky += vec3(0.020, 0.024, 0.045) * band * n * n;
    sky += vec3(0.020, 0.012, 0.030) * pow(vnoise(d * 1.7 + 4.0), 3.0);
  }
  if (abs(b - ${f(SCENE.ringImpact)}) < ${f(SCENE.ringBand)}) {
    vec3 sumCol = col; float sumAlpha = alpha; float sumEscaped = escaped;
    vec2 offsets[4] = vec2[4](vec2(0.125, 0.375), vec2(-0.375, 0.125), vec2(-0.125, -0.375), vec2(0.375, -0.125));
    for (int k = 0; k < 4; k++) {
      vec3 c2, e2; float a2, s2, b2;
      trace(rayDir(gl_FragCoord.xy + offsets[k]), c2, a2, e2, s2, b2);
      sumCol += c2; sumAlpha += a2; sumEscaped += s2;
    }
    col = sumCol / 5.0; alpha = sumAlpha / 5.0; escaped = sumEscaped / 5.0;
  }
  outColor = vec4(col + (1.0 - alpha) * escaped * sky, 1.0);
}`;

export const PREFILTER = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThresh;
uniform float uKnee;
out vec4 outColor;
${COMMON}
vec3 bright(vec3 c) {
  float l = lum(c);
  float soft = clamp(l - uThresh + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  return c * max(soft, l - uThresh) / max(l, 1e-4);
}
void main() {
  vec2 uv = gl_FragCoord.xy * 2.0 * uTexel;
  vec3 a = texture(uSrc, uv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uSrc, uv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture(uSrc, uv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture(uSrc, uv + uTexel * vec2(1.0, 1.0)).rgb;
  float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d));
  outColor = vec4(bright((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd)), 1.0);
}`;

export const DOWN = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDst;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec3 s = texture(uSrc, uv).rgb * 4.0;
  s += texture(uSrc, uv - uTexel).rgb;
  s += texture(uSrc, uv + uTexel).rgb;
  s += texture(uSrc, uv + vec2(uTexel.x, -uTexel.y)).rgb;
  s += texture(uSrc, uv - vec2(uTexel.x, -uTexel.y)).rgb;
  outColor = vec4(s / 8.0, 1.0);
}`;

export const UP = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uAdd;
uniform vec2 uTexel;
uniform vec2 uDst;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec2 h = uTexel;
  vec3 s = texture(uSrc, uv + vec2(-2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(0.0, 2.0 * h.y)).rgb;
  s += texture(uSrc, uv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(0.0, -2.0 * h.y)).rgb;
  s += texture(uSrc, uv + vec2(-h.x, -h.y)).rgb * 2.0;
  outColor = vec4(s / 12.0 + texture(uAdd, uv).rgb, 1.0);
}`;

export const FINAL = `#version 300 es
precision highp float;
uniform sampler2D uHole;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform vec2 uDesign;
uniform float uFocal;
uniform mat3 uView;
uniform mat3 uHoleView;
uniform vec3 uCam;
uniform float uExposure;
uniform float uBloomK;
out vec4 outColor;
${COMMON}
const float RC = ${f(SCENE.roomRadius)};
const float Y_TOP = ${f(SCENE.ceilingY)};
const float Y_DESK = ${f(SCENE.deskY)};
const float MULLION_HALF = ${f(SCENE.mullionHalf)};

vec3 rrtOdt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 c) {
  const mat3 I = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 O = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  return clamp(O * rrtOdt(I * c), 0.0, 1.0);
}
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 tone(vec3 c) { return srgb(aces(c * uExposure)); }
float mullion(float phi) { float a = abs(phi); return min(abs(a - 0.2269), min(abs(a - 0.5760), abs(a - 0.9250))) * RC; }
// A direction in the black hole pass's camera to its texture coordinate, so frames that skip the pass reuse the last one.
vec2 project(vec3 dc) { vec2 p = dc.xy * (uFocal / max(-dc.z, 1e-3)); return (p + 0.5 * uDesign) / uDesign; }
vec3 bloomAt(vec2 uv) { return tone(texture(uBloom, uv).rgb * uBloomK * 2.2); }
float line(float x, float w) { return exp(-(x * x) / (w * w)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv * uDesign - 0.5 * uDesign;
  vec3 rd = uView * normalize(vec3(p, -uFocal));
  vec3 ro = uCam;
  vec2 holeUv = project(transpose(uHoleView) * rd);
  float a = dot(rd.xz, rd.xz);
  float b = 2.0 * dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - RC * RC;
  float tWall = (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
  float tDesk = rd.y < 0.0 ? (Y_DESK - ro.y) / rd.y : 1e9;
  vec3 bloomLin = texture(uBloom, holeUv).rgb * uBloomK;
  vec3 hole = tone(texture(uHole, holeUv).rgb + bloomLin);
  vec3 glow = tone(bloomLin * 2.2);
  vec3 blue = vec3(0.62, 0.80, 1.0);
  vec3 peach = vec3(1.0, 0.70, 0.60);
  vec3 col;
  if (tDesk < tWall) {
    vec3 h = ro + rd * tDesk;
    float rr = length(h.xz);
    float phi = atan(h.x, -h.z);
    vec2 mirrorUv = project(transpose(uHoleView) * vec3(rd.x, -rd.y, rd.z));
    vec3 reflection = bloomAt(clamp(mirrorUv, 0.0, 1.0)) * 2.6;
    float fresnel = 0.05 + 0.5 * pow(1.0 - abs(rd.y), 6.0);
    float near = smoothstep(RC * 0.35, RC, rr);
    col = vec3(0.012, 0.015, 0.022) + reflection * fresnel * near * 0.9;
    col += vec3(0.05, 0.035, 0.03) * smoothstep(RC * 0.4, RC, rr) * (1.0 - smoothstep(0.0, 1.3, abs(phi)));
    col += blue * 0.018 * line(rr - 880.0, 260.0) * (1.0 - smoothstep(0.3, 1.2, abs(phi)));
    col += blue * (line(rr - (RC - 10.0), 3.0) * 0.55 + line(rr - (RC - 10.0), 40.0) * 0.06);
    col += blue * (line(rr - 640.0, 2.0) * 0.30 + line(rr - 640.0, 30.0) * 0.03);
    col += vec3(0.05, 0.06, 0.08) * line(mullion(phi) / RC * rr, 1.5) * near;
  } else {
    vec3 h = ro + rd * tWall;
    float phi = atan(h.x, -h.z);
    float y = h.y;
    float md = mullion(phi);
    if (y > Y_TOP) {
      col = mix(vec3(0.034, 0.038, 0.050), vec3(0.012, 0.014, 0.020), clamp((y - Y_TOP) / 220.0, 0.0, 1.0));
      col *= 0.55 + 0.45 * smoothstep(Y_TOP, Y_TOP + 10.0, y);
      col += glow * 0.10;
      col += peach * (line(y - (Y_TOP + 16.0), 2.4) * 0.85 + line(y - (Y_TOP + 16.0), 26.0) * 0.10);
      col += vec3(0.07, 0.08, 0.10) * line(y - (Y_TOP + 70.0), 1.2);
      col += vec3(0.06, 0.07, 0.09) * line(md, 1.4) * step(Y_TOP + 70.0, y);
    } else if (md < MULLION_HALF) {
      float e = md / MULLION_HALF;
      float lit = 0.6 + 0.4 * exp(-abs(y - 250.0) / 500.0);
      col = vec3(0.020, 0.024, 0.034);
      col += vec3(0.070, 0.085, 0.110) * smoothstep(0.55, 0.95, e) * 0.55 * lit;
      col += vec3(0.050, 0.060, 0.080) * line(md, 0.9) * lit;
      col += glow * (0.12 + 0.5 * pow(e, 6.0));
    } else {
      col = hole * (0.82 + 0.18 * smoothstep(MULLION_HALF, MULLION_HALF + 60.0, md));
      col += blue * 0.035 * exp(-(y - Y_DESK) / 140.0);
      col += vec3(0.6, 0.7, 0.9) * 0.012 * line(fract((phi * RC + y * 0.6) / 900.0) - 0.5, 0.08);
      col *= (1.0 - smoothstep(Y_TOP - 40.0, Y_TOP, y)) * 0.25 + 0.75;
    }
  }
  vec2 q = uv - 0.5;
  col *= 1.0 - 0.45 * pow(length(q * vec2(1.1, 1.4)), 2.6);
  col += (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 17.31) - 1.0) / 255.0;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
