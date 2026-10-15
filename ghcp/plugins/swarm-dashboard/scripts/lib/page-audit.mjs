/**
 * The layout audit that check-layout.mjs runs inside the browser. Every function is self-contained (no imports, no
 * module-level values) because auditScript() sends their source into the page; Node tests import the colour helpers.
 */

/** OKLCH to gamma-encoded sRGB in 0..1 (OKLab matrices by Björn Ottosson), clamped to the sRGB gamut. */
export function oklchToSrgb(l, c, h) {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
  ];
  const encode = value => {
    const v = Math.min(1, Math.max(0, value));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return { r: encode(linear[0]), g: encode(linear[1]), b: encode(linear[2]) };
}

/** A computed CSS colour as { r, g, b, a } in 0..1, or null when the format is unknown. */
export function parseColor(text) {
  const value = String(text ?? '').trim().toLowerCase();
  const alpha = part => (part === undefined ? 1 : part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part));
  let match = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (match) return { r: match[1] / 255, g: match[2] / 255, b: match[3] / 255, a: alpha(match[4]) };
  match = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+|none)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (match) {
    const lightness = match[2] ? parseFloat(match[1]) / 100 : parseFloat(match[1]);
    return { ...oklchToSrgb(lightness, parseFloat(match[3]), match[4] === 'none' ? 0 : parseFloat(match[4])), a: alpha(match[5]) };
  }
  match = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (match) return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha(match[4]) };
  return null;
}

export function composite(top, bottom) {
  const a = top.a ?? 1;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

export function luminance(color) {
  const linear = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

export function contrastRatio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Whether an element shows an ellipsis where it cuts its text: block containers draw one, flex and grid containers do not. */
export function showsEllipsis(style) {
  return style.textOverflow === 'ellipsis' && !/flex|grid/.test(style.display);
}

/** Whether an ancestor that hides its overflow cuts a box: across unless the ancestor shows an ellipsis there, or down. `area` is its padding box. */
export function cutsBox(box, area, style) {
  const hides = value => value === 'hidden' || value === 'clip';
  const across = hides(style.overflowX) && !showsEllipsis(style) && (box.left < area.left - 0.5 || box.right > area.right + 0.5);
  const down = hides(style.overflowY) && (box.top < area.top - 0.5 || box.bottom > area.bottom + 0.5);
  return across || down;
}

/** Check the rendered page under options.root and return { checks, issues }. Runs in the browser. */
export function auditPage(options) {
  const issues = [];
  let checks = 0;
  const root = document.querySelector(options.root);
  if (!root) return { checks: 1, issues: [{ rule: 'root', target: options.root, detail: 'not found' }] };
  const describe = el => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3 && node !== document.body; node = node.parentElement) {
      const classes = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      parts.unshift(node.tagName.toLowerCase() + (classes ? `.${classes}` : ''));
    }
    const words = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return parts.join(' > ') + (words ? ` "${words}"` : '');
  };
  const report = (rule, el, detail) => issues.push({ rule, target: describe(el), detail });
  const visible = el => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const normalise = family => family.replace(/["'\s]/g, '').toLowerCase();
  const all = [...root.querySelectorAll('*')];
  const html = all.filter(el => !(el instanceof SVGElement));
  const shown = new Set(html.filter(visible));
  const ownText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.nodeValue.trim());
  const texts = html.filter(el => shown.has(el) && ownText(el));
  const svgTexts = all.filter(el => el instanceof SVGTextElement && visible(el));
  const family = normalise(options.fontFamily ?? getComputedStyle(root).fontFamily);

  for (const el of [...texts, ...svgTexts]) {
    const style = getComputedStyle(el);
    checks += 1;
    if (normalise(style.fontFamily) !== family) report('font-family', el, style.fontFamily);
    if (!options.sizes.includes(parseFloat(style.fontSize))) report('font-size', el, style.fontSize);
    if (!(el instanceof SVGElement) && !options.lineHeights.includes(parseFloat(style.lineHeight))) report('line-height', el, style.lineHeight);
    if (!options.weights.includes(Number(style.fontWeight))) report('font-weight', el, style.fontWeight);
    if (style.fontStyle !== 'normal') report('font-style', el, style.fontStyle);
    if (style.textTransform !== 'none') report('text-transform', el, style.textTransform);
    if (style.letterSpacing !== 'normal' && parseFloat(style.letterSpacing) !== 0) report('letter-spacing', el, style.letterSpacing);
  }

  const backgroundOf = el => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const raw = getComputedStyle(node).backgroundColor;
      const colour = parseColor(raw);
      if (!colour) {
        report('colour', node, `cannot read background ${raw}`);
        continue;
      }
      if (colour.a > 0) {
        layers.push(colour);
        if (colour.a >= 1) break;
      }
    }
    let result = { r: 1, g: 1, b: 1, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) result = composite(layers[index], result);
    return result;
  };
  for (const el of [...texts, ...svgTexts]) {
    const style = getComputedStyle(el);
    const raw = el instanceof SVGElement ? style.fill : style.color;
    const foreground = parseColor(raw);
    checks += 1;
    if (!foreground) {
      report('colour', el, `cannot read ${raw}`);
      continue;
    }
    const background = backgroundOf(el);
    const ratio = contrastRatio(composite(foreground, background), background);
    if (ratio < options.minContrast) report('contrast', el, `${ratio.toFixed(2)}:1`);
  }

  // The part of an element that ancestors clipping their overflow leave visible (ellipsis cells, chip rows).
  const clippedBox = el => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = node.getBoundingClientRect();
      if (style.overflowX !== 'visible') {
        left = Math.max(left, outer.left);
        right = Math.min(right, outer.right);
      }
      if (style.overflowY !== 'visible') {
        top = Math.max(top, outer.top);
        bottom = Math.min(bottom, outer.bottom);
      }
    }
    return { left, top, right, bottom };
  };
  const atoms = [...new Set([...texts, ...root.querySelectorAll(options.atoms)])].filter(el => !(el instanceof SVGElement) && shown.has(el));
  const boxes = atoms
    .map(el => ({ el, box: clippedBox(el) }))
    .filter(({ box }) => box.right - box.left > 0.5 && box.bottom - box.top > 0.5)
    .sort((a, b) => a.box.top - b.box.top);
  checks += boxes.length;
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length && boxes[j].box.top < a.box.bottom - 0.5; j += 1) {
      const b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width > 0.5 && height > 0.5) report('overlap', a.el, describe(b.el));
    }
  }

  // The nearest ancestor whose hidden overflow cuts the element's box.
  const cutBy = el => {
    const box = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = node.getBoundingClientRect();
      const left = outer.left + node.clientLeft;
      const top = outer.top + node.clientTop;
      if (cutsBox(box, { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight }, style)) return node;
    }
    return null;
  };
  for (const el of texts) {
    const style = getComputedStyle(el);
    checks += 1;
    if (style.display !== 'inline' && el.scrollWidth > el.clientWidth + 1) {
      if (style.overflowX === 'visible') report('spill', el, `${el.scrollWidth}px of content in ${el.clientWidth}px`);
      else if (!showsEllipsis(style)) report('clipped', el, `${el.scrollWidth}px of content in ${el.clientWidth}px`);
    }
    if (style.display !== 'inline' && style.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1) report('hidden-lines', el, `${el.scrollHeight}px of lines in ${el.clientHeight}px`);
    const cut = cutBy(el);
    if (cut) report('cut', el, `cut off by ${describe(cut)}`);
    const container = el.parentElement && el.parentElement.closest(options.containers);
    if (container) {
      const box = clippedBox(el);
      const outer = container.getBoundingClientRect();
      if (box.left < outer.left - 0.5 || box.right > outer.right + 0.5) report('outside', el, `extends past ${describe(container)}`);
    }
  }

  checks += 1;
  if (document.documentElement.scrollWidth > window.innerWidth + 1) report('hscroll', document.documentElement, `${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px window`);

  for (const el of shown) {
    const style = getComputedStyle(el);
    checks += 1;
    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
      const value = parseFloat(style[prop]);
      if (Number.isFinite(value) && Math.abs(value % 4) > 0.01) report('grid', el, `${prop} ${style[prop]}`);
    }
  }
  const matching = selector => [root, ...root.querySelectorAll(selector)].filter(el => el.matches(selector) && (el === root || shown.has(el)));
  for (const [selector, px] of Object.entries(options.padding)) {
    for (const el of matching(selector)) {
      const style = getComputedStyle(el);
      const sides = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
      checks += 1;
      if (sides.some(side => side !== px)) report('padding', el, `${sides.join(' ')} instead of ${px}`);
    }
  }
  for (const [selector, px] of Object.entries(options.heights)) {
    for (const el of matching(selector)) {
      const height = el.getBoundingClientRect().height;
      checks += 1;
      if (Math.abs(height - px) > 0.5) report('height', el, `${height.toFixed(1)}px instead of ${px}px`);
    }
  }
  return { checks, issues };
}

export const AUDIT_DEFAULTS = Object.freeze({
  root: '.dash',
  minContrast: 4.5,
  sizes: [12, 14, 18],
  lineHeights: [16, 20, 24],
  weights: [400, 500],
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  atoms: '.chip,.badge,.pill,.ring,.meter,.bar,.stage,.sw,button,select,.need,.b-card,.mc,.pn,.pl-row,.tile,.kv,.fi,.h-row,.g-row,.g-track,.hb-row,.c-who,.c-trk,.c-sum,.tabs,.seg',
  containers: '.b-card,.need,.rail,.detail,.mc,.pn,.pl-row,.tile,.h-row,.run-answer,.empty,.dash',
  padding: { '.dash': 16, '.b-card': 16, '.rail': 16, '.detail': 16, '.need': 12, '.pn': 12, '.pl-row': 12, '.mc': 12 },
  heights: {
    '.chip': 24, '.badge': 20, '.pill': 20, '.d-top .seg > button': 28, '.c-bar .seg > button': 24, '.x': 28, '.pick select': 28,
    '.ring': 40, '.meter': 4, '.bar': 4, '.stage': 4, '.g-track': 12,
  },
});

/** The audit as one expression for Runtime.evaluate. */
export function auditScript(options = AUDIT_DEFAULTS) {
  const source = [oklchToSrgb, parseColor, composite, luminance, contrastRatio, showsEllipsis, cutsBox, auditPage].map(fn => fn.toString()).join('\n');
  return `(() => {\n${source}\nreturn auditPage(${JSON.stringify(options)});\n})()`;
}
