/**
 * The cockpit's 3D space, shared by the CSS panels and the shader. Design px: the stage is 900 px tall and scales with
 * the window's height; x points right, y down and z toward the viewer, as in CSS. The eye sits FOCAL px in front of the
 * stage, so the stage's perspective and the shader share one 60-degree vertical field of view.
 */
export const DESIGN_HEIGHT = 900;
export const FOV_Y = Math.PI / 3;
export const FOCAL = DESIGN_HEIGHT / 2 / Math.tan(FOV_Y / 2);
/** The scene time of the still frame drawn under "reduce motion" and for checks. */
export const STILL_TIME = 37;
export const REST = Object.freeze({ x: 0, y: 0, yaw: 0, pitch: 0 });
const DEG = Math.PI / 180;
/** The furthest the camera goes: pointer in a corner and every drift term at its peak. */
export const CAMERA_LIMITS = Object.freeze({ x: 23, y: 14, yaw: 0.95 * DEG, pitch: 0.8 * DEG });

export function stageFor(width, height) {
  const scale = height / DESIGN_HEIGHT;
  return { width, height, scale, designWidth: width / scale };
}

// Row-major 4 × 4 matrices; points are columns. multiply(a, b) applies b first, like a CSS transform list "a b".
export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) for (let k = 0; k < 4; k += 1) out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return out;
}
const chain = (...matrices) => matrices.reduce((acc, m) => multiply(acc, m));
export const translate = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
export function rotateX(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}
export function rotateY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

/** A panel on a cylinder around the eye: turned phi degrees, raised y px, r px away, then turned by extra and tilted back. */
export const panelMatrix = ({ phi, y, r, tilt, extra = 0 }) => chain(translate(0, 0, FOCAL), rotateY(-phi * DEG), translate(0, -y, -r), rotateY(-extra * DEG), rotateX(tilt * DEG));
export const panelCss = ({ phi, y, r, tilt, extra = 0 }) => `translate3d(0px, 0px, ${FOCAL}px) rotateY(${-phi}deg) translate3d(0px, ${-y}px, ${-r}px) rotateY(${-extra}deg) rotateX(${tilt}deg)`;
/** The camera, applied to the whole world: it turns about the eye and moves sideways and up. */
export const worldMatrix = ({ x, y, yaw, pitch }) => chain(translate(0, 0, FOCAL), rotateX(pitch), rotateY(yaw), translate(-x, y, -FOCAL));
export const worldCss = ({ x, y, yaw, pitch }) => `translate3d(0px, 0px, ${FOCAL}px) rotateX(${pitch}rad) rotateY(${yaw}rad) translate3d(${-x}px, ${y}px, ${-FOCAL}px)`;

/** Where a panel lands in the window: the bounding box of its projected corners, as getBoundingClientRect reports it. */
export function projectPanel(placement, size, cam, stage) {
  const m = multiply(worldMatrix(cam), panelMatrix(placement));
  const cx = stage.designWidth / 2;
  const cy = DESIGN_HEIGHT / 2;
  const xs = [];
  const ys = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const px = (u * size.width) / 2;
    const py = (v * size.height) / 2;
    const X = m[0] * px + m[1] * py + m[3];
    const Y = m[4] * px + m[5] * py + m[7];
    const Z = m[8] * px + m[9] * py + m[11];
    const k = FOCAL / (FOCAL - Z);
    xs.push((cx + X * k) * stage.scale);
    ys.push((cy + Y * k) * stage.scale);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** The shader's camera rotation, Ry(yaw) · Rx(pitch), column-major for uniformMatrix3fv. */
export function viewMatrix(yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  return new Float32Array([cy, 0, sy, -sy * sx, cx, cy * sx, -sy * cx, -sx, cy * cx].map(v => (Object.is(v, -0) ? 0 : v)));
}

/** Where the camera drifts at a time (s) with the pointer at (mx, my), each in -1..1: long slow sines plus a slight parallax. */
export function cameraTarget(t, mx, my) {
  return {
    x: mx * 16 + 7 * Math.sin(t * 0.07),
    y: -my * 10 + 4 * Math.sin(t * 0.05 + 1),
    yaw: (mx * 0.7 + 0.25 * Math.sin(t * 0.031)) * DEG,
    pitch: (-my * 0.6 + 0.2 * Math.sin(t * 0.043)) * DEG,
  };
}

export function easeCamera(cam, target, dt) {
  const k = 1 - Math.exp(-dt * 1.8);
  return { x: cam.x + (target.x - cam.x) * k, y: cam.y + (target.y - cam.y) * k, yaw: cam.yaw + (target.yaw - cam.yaw) * k, pitch: cam.pitch + (target.pitch - cam.pitch) * k };
}

/** Every corner of the camera's range, for the arrangement checks. */
export function extremePoses() {
  const poses = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const yaw of [-1, 1]) for (const pitch of [-1, 1]) {
    poses.push({ x: x * CAMERA_LIMITS.x, y: y * CAMERA_LIMITS.y, yaw: yaw * CAMERA_LIMITS.yaw, pitch: pitch * CAMERA_LIMITS.pitch });
  }
  return poses;
}
