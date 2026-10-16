import { analyseFrame, sceneProblems } from './cockpit-scene.mjs';

/** Runs in the page: draws a still frame in a full-window canvas from the page's own modules, then a reprojected one. */
async function renderStill(analyse) {
  const load = name => import(new URL(`/ui/${name}`, location.href).href);
  const [gl, space, shaders] = await Promise.all([load('cockpit-gl.mjs'), load('cockpit-space.mjs'), load('cockpit-shaders.mjs')]);
  const canvas = document.createElement('canvas');
  // Sized in px: 100vw leaves out a hidden scrollbar's width, and the canvas would then be scaled.
  canvas.style.cssText = `position:fixed;left:0;top:0;z-index:9;width:${innerWidth}px;height:${innerHeight}px`;
  document.body.append(canvas);
  let renderer;
  try {
    renderer = gl.createRenderer(canvas);
  } catch (error) {
    return { error: error.message };
  }
  renderer.resize(innerWidth, innerHeight, devicePixelRatio || 1, 1);
  const view = (time, yaw) => ({ design: [space.stageFor(innerWidth, innerHeight).designWidth, space.DESIGN_HEIGHT], focal: space.FOCAL, time, view: space.viewMatrix(yaw, 0), cam: [0, 0, 0], exposure: shaders.SCENE.exposure, bloom: shaders.SCENE.bloom });
  renderer.render(view(space.STILL_TIME, 0), true);
  const still = analyse(renderer.readFrame());
  renderer.render(view(space.STILL_TIME, 0.01), false);
  const reused = analyse(renderer.readFrame());
  renderer.render(view(space.STILL_TIME, 0), true);
  return { info: renderer.info(), still, reused };
}

async function checkScene({ page, urls, options, stdout, stderr }) {
  const url = `${Object.values(urls)[0]}?host=browser`;
  page.errors.length = 0;
  await page.goto(url, 1440, 900);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
  const result = await page.evaluate(`(${renderStill})(${analyseFrame})`);
  const consoleProblems = page.errors.map(message => `console: ${message}`);
  if (result.error) {
    for (const problem of [result.error, ...consoleProblems]) stderr.write(`scene: ${problem}\n`);
    return 1 + consoleProblems.length;
  }
  const problems = sceneProblems(result.still);
  const drift = Math.abs(result.reused.mean - result.still.mean) / result.still.mean;
  if (drift > 0.25) problems.push(`a frame that reuses the black hole differs in brightness by ${(drift * 100).toFixed(0)}%`);
  for (const problem of sceneProblems(result.reused)) problems.push(`a frame that reuses the black hole: ${problem}`);
  problems.push(...consoleProblems);
  if (options.printMetrics) stdout.write(`scene metrics: ${JSON.stringify(result.still)}\n`);
  stdout.write(`Scene (${result.info.renderer}, ${result.info.hdr ? 'HDR' : '8-bit'} targets): ${problems.length ? `${problems.length} problems` : 'shadow, ring, ceiling line, stars and desk in place'}.\n`);
  for (const problem of problems) stderr.write(`scene: ${problem}\n`);
  return problems.length;
}

/** The cockpit's checks in the order they run. Later tasks add layout, links and slowdown. */
export const CHECKS = new Map([['scene', checkScene]]);

export async function runCockpitChecks(context) {
  let issues = 0;
  for (const [name, check] of CHECKS) {
    if (context.options.only && context.options.only !== name) continue;
    issues += await check(context);
  }
  return { issues };
}
