/**
 * Structural checks of a rendered cockpit frame ({ width, height, data } in RGBA, top row first). Self-contained:
 * check-cockpit.mjs sends analyseFrame's source into the page, and Node tests run it on synthetic frames.
 * - mean: average luminance (0..1);
 * - shadow: the longest dark run down the centre column (under 0.15: bloom lifts the shadow above black) that bright light
 *   (over 0.5, the ring and the disk) frames within 3% of the height at both ends, as a share of the height;
 * - peach: the share of columns in the central half with a peach pixel in the top 15% (the ceiling's light line);
 * - stars: small bright points in the upper-left quarter;
 * - desk: average luminance of the bottom-centre block.
 */
export function analyseFrame(frame) {
  const { width, height, data } = frame;
  const lum = (x, y) => {
    const i = (y * width + x) * 4;
    return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  };
  let sum = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    sum += lum(x, y);
    samples += 1;
  }
  const cx = Math.floor(width / 2);
  const reach = Math.max(2, Math.ceil(height * 0.03));
  const lightBetween = (y0, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y += 1) if (lum(cx, y) > 0.5) return true;
    return false;
  };
  let best = 0;
  let run = 0;
  for (let y = Math.floor(height * 0.15); y <= Math.floor(height * 0.7); y += 1) {
    if (y < Math.floor(height * 0.7) && lum(cx, y) < 0.15) {
      run += 1;
    } else {
      if (run > best && lightBetween(y - run - reach, y - run - 1) && lightBetween(y, y + reach)) best = run;
      run = 0;
    }
  }
  let peachColumns = 0;
  const x0 = Math.floor(width * 0.25);
  const x1 = Math.floor(width * 0.75);
  for (let x = x0; x < x1; x += 1) {
    for (let y = 0; y < Math.floor(height * 0.15); y += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b] = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
      if (r > 0.3 && r > g && g > b && r - b > 0.1) {
        peachColumns += 1;
        break;
      }
    }
  }
  let stars = 0;
  for (let y = 1; y < Math.floor(height * 0.45); y += 1) for (let x = 1; x < Math.floor(width * 0.25); x += 1) {
    const centre = lum(x, y);
    if (centre < 0.25) continue;
    let ring = 0;
    let higher = false;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const value = lum(x + dx, y + dy);
      ring += value;
      if (value > centre) higher = true;
    }
    if (!higher && centre > 2 * (ring / 8)) stars += 1;
  }
  let desk = 0;
  let deskSamples = 0;
  for (let y = Math.floor(height * 0.94); y < height; y += 1) for (let x = Math.floor(width * 0.4); x < Math.floor(width * 0.6); x += 1) {
    desk += lum(x, y);
    deskSamples += 1;
  }
  return { mean: sum / samples, shadow: best / height, peach: peachColumns / (x1 - x0), stars, desk: desk / deskSamples };
}

/**
 * Limits for a still frame at 1440 × 900. Measured on 16 October 2026 in Chrome 155 and WebKit 27.2 (Apple M5 Pro): mean
 * 0.073, shadow 0.13, peach 1, stars 58, desk 0.034. Shadow and peach at 60% of that, stars at half, mean from half to
 * twice, desk at twice.
 */
export const SCENE_LIMITS = Object.freeze({ mean: [0.035, 0.15], shadow: 0.07, peach: 0.6, stars: 29, desk: 0.07 });

export function sceneProblems(metrics, limits = SCENE_LIMITS) {
  const problems = [];
  if (!(metrics.mean >= limits.mean[0] && metrics.mean <= limits.mean[1])) problems.push(`brightness ${metrics.mean.toFixed(3)} is outside ${limits.mean.join('–')}`);
  if (!(metrics.shadow >= limits.shadow)) problems.push(`the shadow down the centre is ${(metrics.shadow * 100).toFixed(1)}% of the height, under ${limits.shadow * 100}%`);
  if (!(metrics.peach >= limits.peach)) problems.push(`the ceiling line shows in ${(metrics.peach * 100).toFixed(0)}% of the central columns, under ${limits.peach * 100}%`);
  if (!(metrics.stars >= limits.stars)) problems.push(`${metrics.stars} stars in the upper left, under ${limits.stars}`);
  if (!(metrics.desk <= limits.desk)) problems.push(`the desk's brightness ${metrics.desk.toFixed(3)} is over ${limits.desk}`);
  return problems;
}
