/**
 * Make a container's content match new HTML while keeping the nodes that stay, so running animations, hover, focus,
 * text selection and tooltips survive an update and only what changed is touched. Siblings are matched by key
 * (data-key, else data-id, data-open or data-run) and otherwise by position when the tag is the same. Two attributes
 * change the rules: data-drawn marks a container whose content main.mjs draws after rendering, so its children are left
 * alone; data-phase marks an endless animation whose inline delay is kept while the element stays put with the same
 * class, because changing the delay of a running animation makes it jump.
 */
export function morph(target, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  syncChildren(target, template.content, false);
}

function keyOf(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const key = node.getAttribute('data-key') ?? node.getAttribute('data-id') ?? node.getAttribute('data-open') ?? node.getAttribute('data-run');
  return key === null ? null : `${node.nodeName}\n${key}`;
}

function syncChildren(parent, source, moved) {
  const incoming = [...source.childNodes];
  const wanted = new Set(incoming.map(keyOf).filter(key => key !== null));
  const keyed = new Map();
  for (const child of parent.childNodes) {
    const key = keyOf(child);
    if (key !== null && wanted.has(key) && !keyed.has(key)) keyed.set(key, child);
  }
  let cursor = parent.firstChild;
  for (const next of incoming) {
    // Drop keyed nodes that are no longer wanted, so the nodes after them keep their place instead of being moved.
    while (cursor && keyOf(cursor) !== null && keyed.get(keyOf(cursor)) !== cursor) {
      const after = cursor.nextSibling;
      cursor.remove();
      cursor = after;
    }
    const key = keyOf(next);
    let match = null;
    if (key !== null) match = keyed.get(key) ?? null;
    else if (cursor && keyOf(cursor) === null && cursor.nodeName === next.nodeName) match = cursor;
    if (!match) {
      parent.insertBefore(next, cursor);
      continue;
    }
    if (key !== null) keyed.delete(key);
    if (match === cursor) {
      cursor = cursor.nextSibling;
      syncNode(match, next, moved);
    } else {
      // Moving a node restarts its animations, so it takes the new delays.
      parent.insertBefore(match, cursor);
      syncNode(match, next, true);
    }
  }
  while (cursor) {
    const after = cursor.nextSibling;
    cursor.remove();
    cursor = after;
  }
}

function syncNode(from, to, moved) {
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  syncAttributes(from, to, moved);
  if (from.hasAttribute('data-drawn') && to.hasAttribute('data-drawn')) return;
  syncChildren(from, to, moved);
  if (from.nodeName === 'SELECT') {
    const chosen = to.querySelector('option[selected]') ?? to.querySelector('option');
    if (chosen) from.value = chosen.getAttribute('value') ?? chosen.textContent;
  }
}

function syncAttributes(from, to, moved) {
  const keepStyle = !moved && from.hasAttribute('data-phase') && to.hasAttribute('data-phase') && from.getAttribute('class') === to.getAttribute('class');
  for (const { name, value } of [...to.attributes]) {
    if (name === 'style' && keepStyle) continue;
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name) && !(name === 'style' && keepStyle)) from.removeAttribute(name);
  }
}
