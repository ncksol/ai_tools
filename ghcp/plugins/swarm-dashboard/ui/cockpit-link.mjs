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

export const cockpitControlHtml = view => (view.page === 'live' && view.snapshot ? '<div class="seg ck-open"><button type="button" data-cockpit>Cockpit</button></div>' : '');

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
