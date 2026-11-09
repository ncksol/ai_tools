import { foldFooter } from './model.mjs';

/** Chrome lays out in 1/64 px units: a difference this small is rounding, not a cut. */
export const LAYOUT_UNIT = 1 / 64;

/**
 * Whether an element's text needs more width than its content box gets. Measured in fractional pixels, because
 * scrollWidth and clientWidth round to whole ones and read 92 for text that needs 91.9 px and gets 91.6 px.
 */
export function cutsText(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const style = getComputedStyle(el);
  const inset = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, prop) => sum + parseFloat(style[prop]), 0);
  return range.getBoundingClientRect().width > el.getBoundingClientRect().width - inset + LAYOUT_UNIT;
}

/**
 * Whether the footer's left side does not fit: a shown child reaches past its padding box, or a shown chip cuts its
 * text, which a lone chip does because .chip caps its width at 100%.
 */
export function spills(el) {
  const right = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).borderRightWidth);
  if ([...el.children].some(child => !child.hidden && child.getBoundingClientRect().right > right + LAYOUT_UNIT)) return true;
  return [...el.querySelectorAll(':scope > .chip:not([hidden]) > .chip-t')].some(cutsText);
}

/**
 * Fold a card footer whose left side does not fit (foldFooter in ui/model.mjs has the order). It starts from the footer
 * as rendered, so it can run again after a clock in it changes width.
 */
export function fitFooter(foot) {
  const left = foot.querySelector('.b-left');
  const model = foot.querySelector('.b-model');
  const chips = [...left.querySelectorAll(':scope > .chip[data-key]')];
  const more = left.querySelector('.b-more');
  const count = left.querySelector('.b-count');
  const progress = left.querySelector('.b-prog');
  const need = foot.querySelector('.b-need');
  const [long, short] = need ? need.children : [];
  for (const chip of chips) chip.hidden = false;
  if (more) more.hidden = true;
  if (count) count.hidden = true;
  if (progress) progress.hidden = false;
  if (need) {
    long.hidden = false;
    short.hidden = true;
  }
  foldFooter({
    over: () => spills(left) || Boolean(model && cutsText(model)),
    progress: Boolean(progress),
    chips: chips.length,
    need: Boolean(need),
    hideProgress: () => { progress.hidden = true; },
    showChips: shown => {
      chips.forEach((chip, index) => { chip.hidden = index >= shown; });
      more.textContent = `+${chips.length - shown}`;
      more.hidden = false;
    },
    countChips: () => {
      for (const chip of chips) chip.hidden = true;
      more.hidden = true;
      count.hidden = false;
    },
    shortenNeed: () => {
      long.hidden = true;
      short.hidden = false;
    },
    hideCount: () => { count.hidden = true; },
  });
}
