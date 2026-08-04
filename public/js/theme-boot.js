// Applies the signed-in user's cached theme/canvas preference before first
// paint, so there's no flash of the default theme while /api/auth/me is
// still in flight. Reads the same hammgrid:last-user cache api.js's
// requireSession() maintains - shell.js's applyTheme() reconciles this
// against the live session once it resolves. Loaded as a plain synchronous
// classic script (not a module) so it runs and blocks rendering in place,
// same as the render-blocking stylesheet link right before it.
(function () {
  try {
    var user = JSON.parse(localStorage.getItem('hammgrid:last-user') || 'null');
    var settings = (user && user.settings) || {};
    document.documentElement.dataset.theme = settings.theme || 'default';
    if (settings.darkCanvas) document.documentElement.dataset.canvasInvert = '1';
  } catch (err) {
    // localStorage blocked/corrupt - fall back to the default theme.
  }
})();
