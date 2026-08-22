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
  var state = { accent: "blue", accentSecondary: null, background: null, backgroundEffect: "matrix", panelOpacity: 100, panelBlur: 10, animationSpeed: 1, squareCorners: false };
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

  if (typeof state.accentSecondary === "string" && state.accentSecondary.charAt(0) === "#") {
    root.setAttribute("data-accent-secondary", "custom");
    root.style.setProperty("--accent-secondary-custom", state.accentSecondary);
  } else if (state.accentSecondary) {
    root.setAttribute("data-accent-secondary", state.accentSecondary);
  }

  if (state.background) {
    root.setAttribute("data-custom-bg", "true");
    root.style.setProperty("--bg-custom", state.background);
  }

  // Set before first paint for the same reason as accent/background above:
  // without this, every page navigation (each page is its own full HTML
  // document, not a client-side route) painted the CSS default — fully
  // opaque, no blur — until the deferred settings.js module ran a moment
  // later and snapped it to the saved value. That's the flash of "briefly
  // solid, then transparent" on every page/tab switch.
  root.style.setProperty("--panel-alpha", state.panelOpacity + "%");
  // backdrop-filter: blur(0px) is not the same as no backdrop-filter at all —
  // even a zero blur forces the panel onto its own GPU compositing layer,
  // which visibly degrades text rendering under it (the "glitchy" text users
  // see with the Panel blur slider at 0). So the filter is omitted entirely
  // ("none") at 0 instead of being handed a 0px blur.
  root.style.setProperty("--panel-backdrop", state.panelBlur > 0 ? "blur(" + state.panelBlur + "px)" : "none");
  root.style.setProperty("--panel-backdrop-topbar", state.panelBlur > 0 ? "saturate(180%) blur(" + state.panelBlur + "px)" : "none");
  root.style.setProperty("--fx-speed", state.animationSpeed);

  root.setAttribute("data-corners", state.squareCorners ? "square" : "rounded");

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

  // CSS gates the canvas element itself on this attribute (hidden for
  // "none", shown otherwise — see styles.css) — set here too, not just
  // from background-fx.js, so the canvas doesn't flash visibly blank/empty
  // for a moment after that deferred module script finally runs and picks
  // an actual effect to draw.
  root.setAttribute("data-bg-fx", state.backgroundEffect || "none");
})();
