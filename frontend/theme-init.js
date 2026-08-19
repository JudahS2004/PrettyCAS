// Applies the saved accent/background before first paint, on every page.
// Loaded as a plain blocking <script> (not type="module") so it runs
// synchronously during head parsing — unlike a module script, which is
// always deferred until after the document parses and would otherwise
// paint the default look first and flip a moment later. This also covers
// pages like plot.html that don't load the rest of the app bundle at all,
// so nothing resets when navigating there.
//
// This duplicates settings.js's DEFAULTS/applyTheme logic on purpose: that
// version runs from an ES module, which can't run this early. Keep the two
// in sync if the settings shape changes.
(function () {
  var STORAGE_KEY = "mathstuff2.settings";
  var DEFAULT_BG_LIGHT = "#eef0f6";
  var DEFAULT_BG_DARK = "#14151f";
  var state = { accent: "indigo", background: null, backgroundEffect: "matrix" };
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      for (var key in state) {
        if (key in saved) state[key] = saved[key];
      }
    }
  } catch (e) {
    // Ignore corrupt/unavailable storage; fall back to defaults.
  }

  var root = document.documentElement;

  if (typeof state.accent === "string" && state.accent.charAt(0) === "#") {
    root.setAttribute("data-accent", "custom");
    root.style.setProperty("--accent-custom", state.accent);
  } else {
    root.setAttribute("data-accent", state.accent);
  }

  if (state.background) {
    root.setAttribute("data-custom-bg", "true");
    root.style.setProperty("--bg-custom", state.background);
  }

  // Panels/text/borders aren't a separate light/dark choice — their tone is
  // derived from whatever background color is actually in effect (custom,
  // or the OS-preference default), by that color's own perceived brightness.
  var osDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var effectiveBg = state.background || (osDark ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT);
  root.setAttribute("data-bg-tone", bgTone(effectiveBg));

  function bgTone(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return "light";
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    var brightness = (r * 299 + g * 587 + b * 114) / 255000;
    return brightness > 0.55 ? "light" : "dark";
  }

  // The pulse effect is pure CSS (driven entirely by this attribute) — set
  // here too, not just from background-fx.js, so it doesn't flash in a
  // moment after that deferred module script finally runs.
  root.setAttribute("data-bg-fx", state.backgroundEffect || "none");
})();
