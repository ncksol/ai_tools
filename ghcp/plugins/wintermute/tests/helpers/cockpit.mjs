/** Values shared by the cockpit's tests. A helper, not a test file, so importing it runs no tests. */
export const PANEL_TABS = Object.freeze({ 'ck-clock': 'cards', 'ck-cost': 'timeline', 'ck-needs': 'cards', 'ck-status': 'board', 'ck-activity': 'cards', 'ck-units': 'cards', 'ck-prs': 'board' });
/** Common window sizes the arrangement and the browser check are tested at. */
export const COCKPIT_SIZES = Object.freeze([[1100, 800], [1280, 800], [1440, 900], [1512, 900], [1680, 1050], [1920, 1080], [2560, 1440]]);
