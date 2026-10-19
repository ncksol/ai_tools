// A classic script, not a module: index.html loads it in <head> before the stylesheet, so the page paints in its theme
// from the first frame. The page's CSP allows no inline script. Keep the key and the rule in step with ui/theme.mjs.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('swarm-dashboard:theme');
  } catch (error) {
    theme = null;
  }
  if (theme !== 'light' && theme !== 'dark') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
}());
