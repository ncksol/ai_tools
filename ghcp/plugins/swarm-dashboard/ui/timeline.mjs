/** Stub until Task 12 replaces this file with the timeline view. */
export const SPANS = Object.freeze({ '3h': 10800000, '12h': 43200000, run: null });
export const timelineWindow = (snapshot, span, now) => ({ t0: now - (SPANS[span] ?? 43200000), t1: now });
export const timelineHtml = () => '<div class="c" data-timeline><p class="none">The timeline is not built yet.</p></div>';
export const laneSvg = () => '';
export const axisSvg = () => '';
export const costSvg = () => '';
