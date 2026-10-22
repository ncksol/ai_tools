/**
 * How the regular view and the cockpit reach each other. The regular window names itself REGULAR_WINDOW when it opens
 * the cockpit in a window named COCKPIT_WINDOW; the cockpit finds the regular window by that name and sends it a
 * same-origin message, so it shows a unit's details without reloading. Both windows are in one browsing context group,
 * so a name lookup finds them. The app's side panel cannot open windows: there the control shows the address instead.
 */
import { esc } from './format.mjs';

export const REGULAR_WINDOW = 'swarm-dashboard';
export const COCKPIT_WINDOW = 'swarm-cockpit';
export const SHOW = 'swarm-dashboard:show';
export const TABS = Object.freeze(['cards', 'timeline', 'plan', 'board']);

export const cockpitPath = swarm => `/cockpit?${new URLSearchParams({ swarm })}`;

export function regularPath({ swarm, detail = null, tab = null }) {
  const query = new URLSearchParams();
  if (swarm) query.set('swarm', swarm);
  if (TABS.includes(tab)) query.set('tab', tab);
  if (detail) query.set('detail', detail);
  return `/?${query}`;
}

// The control's icon: the spaceship silhouette traced from the approved PNG, cropped to the shape.
export const COCKPIT_ICON = '<svg width="21" height="20" viewBox="0 0 853 825" aria-hidden="true" focusable="false">'
  + '<path fill="#687c96" fill-rule="evenodd" d="M361.5 811.3C356 803.7 349.9 795.5 348 793L344.5 788.5L344 771.1L343.5 753.8L329.3 749.8L315.1 745.8L314.6 740.6C314.3 737.8 313.8 730.3 313.5 724C313.2 717.7 311.8 692.2 310.5 667.5C299.7 471.1 296 398 296 382.8C296 360.1 299.6 335.5 312.1 273.5C321 229.3 334.1 181.8 347.5 145C371.3 79.7 400.9 21.8 419.4 4.1C427 -3.3 433.9 1 447.5 21.5C478.1 67.8 511.8 151.3 530.4 227.2C538 258.1 550.1 319 555.1 351.5C558 370.2 557.9 387.4 554.6 446.5C553.2 472.4 550.8 514.2 549.5 539.5C544.9 621.8 539.1 726.3 538.4 736.2L537.8 746L533.6 747.1C531.4 747.8 525 749.4 519.5 750.9L509.5 753.5L509 770.6L508.5 787.8L495 806.4L481.5 825L426.5 825L371.5 825L361.5 811.3ZM250.5 724.4C236.8 712.6 222.4 700 218.7 696.5C213.2 691.3 211.2 690 208.6 690C205.5 690 176.8 697.8 104 718.4C85.6 723.6 60.6 730.6 48.5 734C36.4 737.4 23.6 741 20.1 742.1C12.5 744.4 9.8 744.5 6.1 742.5C0.3 739.5 0.1 738.1 0.8 699.3C1.5 666 1.6 664 3.5 661.3C5.6 658.5 92.7 592.7 177.8 529.8C215.7 501.7 221 497.5 221 495.2C221.1 493.7 222.6 474.9 224.4 453.5C226.8 424.4 228.1 413.7 229.3 411.4C230.7 408.6 255.6 384.2 266.1 375.1L269.7 372L270.4 400.3C270.8 415.8 271.7 467 272.5 514C273.3 561 274.5 626 275.1 658.5C275.7 691 276 723.9 275.8 731.6L275.5 745.8L250.5 724.4ZM576.6 734.3C576.8 727.8 578.2 658.8 579.6 581C581 503.2 582.4 424.3 582.8 405.8L583.5 372.1L602.5 390.1C613.9 401 622.4 409.8 623.7 412.3C625.7 416 626.3 421 629.2 457.5C631.8 489.8 632.8 498.7 634 499.7C634.8 500.3 679.8 534 734 574.6C788.2 615.1 835.8 650.8 839.9 653.9C852.3 663.3 851.4 659.8 852.3 699.6C853.1 737.9 853 739.2 846.8 743C842.7 745.5 841.4 745.5 833.2 743C829.5 741.9 809.6 736.3 789 730.5C768.4 724.6 730.3 713.8 704.3 706.4C656.4 692.8 646 690 642.5 690C641.5 690 638.3 692.4 635.5 695.3C632.8 698.3 624.2 706 616.5 712.6C608.8 719.1 596.9 729.2 590.1 735C583.3 740.8 577.4 745.6 577 745.8C576.5 746 576.4 740.8 576.6 734.3ZM450.6 314C473.4 312.1 501.5 306.9 504.4 304C506.5 301.9 496.3 256.7 486 222.5C480.2 203.3 469.5 174.4 467.3 171.8C464.9 169.1 452 163.2 444.5 161.4C435.4 159.3 417.8 159.3 408.6 161.4C400.6 163.3 390.5 167.9 386.8 171.3C383.9 174 378.3 187.9 370 213C360.7 241.3 352.6 273.4 347.7 301.4C347.3 303.9 347.7 304.4 350.8 305.7C358.3 308.8 383.9 313.1 402.5 314.3C414.4 315.1 438.7 314.9 450.6 314Z"/></svg>';

export const cockpitControlHtml = view => (view.page === 'live' && view.snapshot
  ? `<div class="seg ck-open"><button type="button" data-cockpit aria-label="Cockpit" title="Cockpit">${COCKPIT_ICON}</button></div>`
  : '');

export function cockpitAddressHtml(note) {
  if (!note) return '';
  const lead = note.reason === 'blocked' ? 'The browser blocked the new window. Open this address instead:' : 'Open this address in your browser:';
  const said = note.copied === true ? 'Copied' : note.copied === false ? 'Select the address and copy it' : '';
  return `<div class="ck-addr" role="status"><span class="small muted">${lead}</span><span class="code ck-addr-url">${esc(note.url)}</span>`
    + `<button type="button" class="link" data-cockpit-copy>Copy</button>${said ? `<span class="small muted">${said}</span>` : ''}</div>`;
}

const hrefOf = win => {
  try {
    return win.location.href;
  } catch {
    return null;
  }
};

/** Open or focus the cockpit for a swarm. Returns the address to show when no window can open, else null. */
export function openCockpit(win, { swarm, host }) {
  const url = new URL(cockpitPath(swarm), win.location.href).href;
  if (host === 'canvas') return { url, reason: 'canvas', copied: null };
  win.name = REGULAR_WINDOW;
  const { availWidth, availHeight } = win.screen;
  const cockpit = win.open('', COCKPIT_WINDOW, `popup=yes,left=0,top=0,width=${availWidth},height=${availHeight}`);
  if (!cockpit) return { url, reason: 'blocked', copied: null };
  const shown = hrefOf(cockpit);
  const same = shown !== null && shown !== 'about:blank' && new URL(shown).pathname === '/cockpit' && new URL(shown).searchParams.get('swarm') === swarm;
  if (!same) cockpit.location.replace(url);
  cockpit.focus();
  return null;
}

/** Copy the address: the clipboard first, then the selected address. Leaves the address selected either way. */
export async function copyAddress(nav, doc, el, url) {
  try {
    await nav.clipboard.writeText(url);
    return true;
  } catch {
    // The clipboard API can be missing or refused inside the app's panel.
  }
  try {
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  }
}

/**
 * What the regular view does with a cockpit's message: open a unit or tab in place, or load the swarm it names (also
 * when it is a finished swarm shown by default, which the page hides behind its placeholder).
 */
export function showRequest(view, data) {
  if (!data || data.kind !== SHOW || typeof data.swarm !== 'string') return null;
  const detail = typeof data.detail === 'string' ? data.detail : null;
  const tab = TABS.includes(data.tab) ? data.tab : null;
  if (view.snapshot?.run.id !== data.swarm) return { reload: regularPath({ swarm: data.swarm, detail, tab }) };
  if (view.snapshot.run.lifecycle === 'finished' && !view.swarm) return { reload: regularPath({ swarm: data.swarm, detail, tab }) };
  return { detail, tab };
}

/** From the cockpit: show a unit's details or a tab in the regular window, opening one when it is gone. */
export function showInRegular(win, { swarm, detail = null, tab = null }) {
  const regular = win.open('', REGULAR_WINDOW);
  if (!regular) return false;
  if (hrefOf(regular) === 'about:blank') regular.location.replace(new URL(regularPath({ swarm, detail, tab }), win.location.href).href);
  else regular.postMessage({ kind: SHOW, swarm, detail, tab }, win.location.origin);
  regular.focus();
  return true;
}
