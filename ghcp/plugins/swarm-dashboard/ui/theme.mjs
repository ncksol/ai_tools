/**
 * The regular view's light and dark themes. ui/theme-boot.mjs sets data-theme on the root element before the first
 * paint, from the saved choice or else the system setting; the button next to the cockpit control switches it and saves
 * the choice. The cockpit has one dark look of its own, so it has no theme switch.
 */
export const THEME_KEY = 'swarm-dashboard:theme';
export const THEMES = Object.freeze(['light', 'dark']);

/** The theme to show: the saved choice, else the system setting. */
export const startTheme = (saved, prefersDark) => (THEMES.includes(saved) ? saved : prefersDark ? 'dark' : 'light');
export const otherTheme = theme => (theme === 'dark' ? 'light' : 'dark');
/** What a click on the switch does. The button shows the icon of that theme: a moon in the light theme, a sun in the dark one. */
export const themeLabel = theme => `Switch to ${otherTheme(theme)} theme`;

export const MOON_ICON = '<svg class="th-moon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">'
  + '<path fill="currentColor" d="M16.5 12.6A7 7 0 0 1 7.4 3.5a7 7 0 1 0 9.1 9.1Z"/></svg>';
export const SUN_ICON = '<svg class="th-sun" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">'
  + '<circle cx="10" cy="10" r="3.5" fill="currentColor"/>'
  + '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M10 1.75v2.5M10 15.75v2.5M1.75 10h2.5M15.75 10h2.5M4.17 4.17l1.77 1.77M14.06 14.06l1.77 1.77M15.83 4.17l-1.77 1.77M5.94 14.06l-1.77 1.77"/></svg>';

/** The switch. Both icons are drawn and CSS shows the one for the current theme, so a switch can animate between them. */
export function themeControlHtml(theme) {
  const label = themeLabel(theme === 'dark' ? 'dark' : 'light');
  return `<div class="seg th-open"><button type="button" data-theme-toggle aria-label="${label}" title="${label}"><span class="th-icon">${MOON_ICON}${SUN_ICON}</span></button></div>`;
}

export function readTheme(storage) {
  try {
    const saved = storage.getItem(THEME_KEY);
    return THEMES.includes(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function saveTheme(storage, theme) {
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable; the switch still works until the page reloads.
  }
}
