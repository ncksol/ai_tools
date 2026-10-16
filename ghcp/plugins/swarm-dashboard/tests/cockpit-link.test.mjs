import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COCKPIT_WINDOW, REGULAR_WINDOW, SHOW, cockpitAddressHtml, cockpitControlHtml, cockpitPath, copyAddress, openCockpit, regularPath, showInRegular, showRequest,
} from '../ui/cockpit-link.mjs';

const BASE = 'http://127.0.0.1:7927';
function target(href) {
  const t = { focused: false, replaced: null, messages: [], location: { href, replace(url) { t.replaced = url; } }, focus() { t.focused = true; }, postMessage(data, origin) { t.messages.push({ data, origin }); } };
  return t;
}
function page(opened, href = `${BASE}/?host=browser`) {
  const calls = [];
  const win = { name: '', screen: { availWidth: 1512, availHeight: 945 }, location: { href, origin: new URL(href).origin }, open(url, name, features) { calls.push([url, name, features]); return opened; } };
  return { win, calls };
}

test('addresses for the cockpit and for the regular view', () => {
  assert.equal(cockpitPath('ws 1'), '/cockpit?swarm=ws+1');
  assert.equal(regularPath({ swarm: 'ws-1', detail: 'u1', tab: 'board' }), '/?swarm=ws-1&tab=board&detail=u1');
  assert.equal(regularPath({ swarm: 'ws-1', tab: 'nonsense' }), '/?swarm=ws-1');
});

test('the Cockpit control shows on the Live page once a swarm shows', () => {
  const snapshot = { run: { id: 'ws-1' } };
  assert.equal(cockpitControlHtml({ page: 'live', snapshot }), '<div class="seg ck-open"><button type="button" data-cockpit>Cockpit</button></div>');
  assert.equal(cockpitControlHtml({ page: 'history', snapshot }), '');
  assert.equal(cockpitControlHtml({ page: 'live', snapshot: null }), '');
});

test('in the canvas the control returns the address to show and opens nothing', () => {
  const { win, calls } = page(null, `${BASE}/?host=canvas&session=s1`);
  assert.deepEqual(openCockpit(win, { swarm: 'ws-1', host: 'canvas' }), { url: `${BASE}/cockpit?swarm=ws-1`, reason: 'canvas', copied: null });
  assert.deepEqual(calls, []);
  const html = cockpitAddressHtml({ url: `${BASE}/cockpit?swarm=ws-1`, reason: 'canvas', copied: null });
  assert.equal(html, `<div class="ck-addr" role="status"><span class="small muted">Open this address in your browser:</span><span class="code ck-addr-url">${BASE}/cockpit?swarm=ws-1</span><button type="button" class="link" data-cockpit-copy>Copy</button></div>`);
  assert.match(cockpitAddressHtml({ url: 'x', reason: 'blocked', copied: false }), /The browser blocked the new window\. Open this address instead:[\s\S]*<span class="small muted">Select the address and copy it<\/span>/);
  assert.match(cockpitAddressHtml({ url: 'x', reason: 'canvas', copied: true }), /<span class="small muted">Copied<\/span>/);
  assert.equal(cockpitAddressHtml(null), '');
});

test('in a browser the control opens a named window sized to the screen, or reuses it', () => {
  const blank = target('about:blank');
  const fresh = page(blank);
  assert.equal(openCockpit(fresh.win, { swarm: 'ws-1', host: 'browser' }), null);
  assert.equal(fresh.win.name, REGULAR_WINDOW);
  assert.deepEqual(fresh.calls, [['', COCKPIT_WINDOW, 'popup=yes,left=0,top=0,width=1512,height=945']]);
  assert.equal(blank.replaced, `${BASE}/cockpit?swarm=ws-1`);
  assert.equal(blank.focused, true);
  const same = target(`${BASE}/cockpit?swarm=ws-1&quality=high`);
  openCockpit(page(same).win, { swarm: 'ws-1', host: 'browser' });
  assert.deepEqual([same.replaced, same.focused], [null, true]);
  const other = target(`${BASE}/cockpit?swarm=ws-2`);
  openCockpit(page(other).win, { swarm: 'ws-1', host: 'browser' });
  assert.equal(other.replaced, `${BASE}/cockpit?swarm=ws-1`);
  assert.deepEqual(openCockpit(page(null).win, { swarm: 'ws-1', host: 'browser' }), { url: `${BASE}/cockpit?swarm=ws-1`, reason: 'blocked', copied: null });
});

test('copying uses the clipboard, then the selected address, and says when neither works', async () => {
  const selection = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges.push(range); } };
  const doc = ok => ({ createRange: () => ({ selectNodeContents(el) { this.el = el; } }), getSelection: () => selection, execCommand: () => ok });
  assert.equal(await copyAddress({ clipboard: { writeText: async () => {} } }, doc(false), {}, 'u'), true);
  assert.equal(await copyAddress({ clipboard: { writeText: async () => { throw new Error('denied'); } } }, doc(true), {}, 'u'), true);
  assert.equal(selection.ranges.length, 1, 'the address stays selected');
  assert.equal(await copyAddress({}, doc(false), {}, 'u'), false);
});

test('the regular view opens what the cockpit asks for in place, or loads the swarm it names', () => {
  const view = { snapshot: { run: { id: 'ws-1' } } };
  assert.equal(showRequest(view, { kind: 'other' }), null);
  assert.equal(showRequest(view, null), null);
  assert.deepEqual(showRequest(view, { kind: SHOW, swarm: 'ws-1', detail: 'u1', tab: 'cards' }), { detail: 'u1', tab: 'cards' });
  assert.deepEqual(showRequest(view, { kind: SHOW, swarm: 'ws-1', detail: null, tab: 'bogus' }), { detail: null, tab: null });
  assert.deepEqual(showRequest(view, { kind: SHOW, swarm: 'ws-2', detail: 'u1', tab: null }), { reload: '/?swarm=ws-2&detail=u1' });
  assert.deepEqual(showRequest({ snapshot: null }, { kind: SHOW, swarm: 'ws-1', detail: null, tab: 'board' }), { reload: '/?swarm=ws-1&tab=board' });
});

test('the cockpit sends its request to the regular window, or opens one when it is gone', () => {
  const regular = target(`${BASE}/?swarm=ws-1`);
  const live = page(regular, `${BASE}/cockpit?swarm=ws-1`);
  assert.equal(showInRegular(live.win, { swarm: 'ws-1', detail: 'u1', tab: null }), true);
  assert.deepEqual(live.calls, [['', REGULAR_WINDOW, undefined]]);
  assert.deepEqual(regular.messages, [{ data: { kind: SHOW, swarm: 'ws-1', detail: 'u1', tab: null }, origin: BASE }]);
  assert.equal(regular.focused, true);
  const blank = target('about:blank');
  showInRegular(page(blank, `${BASE}/cockpit?swarm=ws-1`).win, { swarm: 'ws-1', detail: null, tab: 'board' });
  assert.equal(blank.replaced, `${BASE}/?swarm=ws-1&tab=board`);
  assert.equal(showInRegular(page(null, `${BASE}/cockpit?swarm=ws-1`).win, { swarm: 'ws-1', detail: null, tab: null }), false);
});
