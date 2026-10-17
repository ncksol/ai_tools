import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_LIMITS, DESIGN_HEIGHT, FOCAL, REST, cameraTarget, easeCamera, extremePoses, multiply, panelCss, panelMatrix, projectPanel, rotateY, stageFor, translate, viewMatrix, worldCss,
} from '../ui/cockpit-space.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('the design space is 900 px tall with a 60-degree vertical field of view, scaled to the window height', () => {
  close(FOCAL, 450 / Math.tan(Math.PI / 6));
  assert.deepEqual(stageFor(1440, 900), { width: 1440, height: 900, scale: 1, designWidth: 1440 });
  const big = stageFor(1920, 1080);
  close(big.scale, 1.2);
  close(big.designWidth, 1600);
  assert.equal(DESIGN_HEIGHT, 900);
});

test('matrices compose like CSS transform lists, left to right', () => {
  const m = multiply(translate(10, 0, 0), rotateY(Math.PI / 2));
  // rotateY(90deg) takes +x to -z in CSS, then the translation moves x by 10.
  const p = [1, 0, 0];
  const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
  const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
  close(x, 10);
  close(z, -1);
});

test('a panel straight ahead at the focal distance projects at its own size, centred', () => {
  const stage = stageFor(1440, 900);
  const rect = projectPanel({ phi: 0, y: 0, r: FOCAL, tilt: 0 }, { width: 200, height: 100 }, REST, stage);
  close(rect.left, 620, 1e-6);
  close(rect.right, 820, 1e-6);
  close(rect.top, 400, 1e-6);
  close(rect.bottom, 500, 1e-6);
});

test('a panel further away projects smaller, and the stage scale applies last', () => {
  const near = projectPanel({ phi: 0, y: 0, r: 860, tilt: 0 }, { width: 536, height: 252 }, REST, stageFor(1440, 900));
  close(near.right - near.left, (536 * FOCAL) / 860, 1e-6);
  const scaled = projectPanel({ phi: 0, y: 0, r: 860, tilt: 0 }, { width: 536, height: 252 }, REST, stageFor(1920, 1080));
  close(scaled.right - scaled.left, ((536 * FOCAL) / 860) * 1.2, 1e-6);
});

test('the CSS strings carry the same transforms as the matrices', () => {
  assert.equal(panelCss({ phi: 12.5, y: -236, r: 860, tilt: 12, extra: -6 }), `translate3d(0px, 0px, ${FOCAL}px) rotateY(-12.5deg) translate3d(0px, 236px, -860px) rotateY(6deg) rotateX(12deg)`);
  assert.equal(worldCss({ x: 2, y: -3, yaw: 0.01, pitch: -0.02 }), `translate3d(0px, 0px, ${FOCAL}px) rotateX(-0.02rad) rotateY(0.01rad) translate3d(-2px, -3px, ${-FOCAL}px)`);
  const m = panelMatrix({ phi: 0, y: 0, r: 100, tilt: 0 });
  close(m[11], FOCAL - 100);
});

test('the shader view matrix is a rotation, identity at rest', () => {
  assert.deepEqual([...viewMatrix(0, 0)], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const m = viewMatrix(0.02, -0.01);
  const col = i => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
  for (const i of [0, 1, 2]) close(col(i).reduce((sum, v) => sum + v * v, 0), 1, 1e-6);
});

test('the camera drifts calmly within its limits, and eases toward its target', () => {
  for (let t = 0; t < 600; t += 0.5) {
    for (const [mx, my] of [[-1, -1], [1, 1], [0, 0]]) {
      const cam = cameraTarget(t, mx, my);
      assert.ok(Math.abs(cam.x) <= CAMERA_LIMITS.x && Math.abs(cam.y) <= CAMERA_LIMITS.y);
      assert.ok(Math.abs(cam.yaw) <= CAMERA_LIMITS.yaw && Math.abs(cam.pitch) <= CAMERA_LIMITS.pitch);
    }
  }
  const eased = easeCamera(REST, { x: 10, y: 0, yaw: 0, pitch: 0 }, 0.1);
  close(eased.x, 10 * (1 - Math.exp(-0.18)));
  assert.equal(extremePoses().length, 16);
});
