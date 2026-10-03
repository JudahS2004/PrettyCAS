// Applies the saved appearance (accent, secondary accent, background, panel opacity, math
// size) before first paint. Loaded as a plain blocking <script> in <head>,
// not a module, so it runs before the page renders and there's no flash of
// the default colors. theme.js reuses the same load/apply functions through
// window.PrettyCASTheme instead of keeping its own copy.
(function () {
  var STORAGE_KEY = "mathstuff2.theme";
  var DEFAULTS = {
    accent: null, // null = default accent, else "#rrggbb"
    accentSecondary: null, // null = derived from accent, else "#rrggbb"
    background: null, // null = follow the OS light/dark preference, else "#rrggbb"
    panelOpacity: 100, // percent; see --panel-alpha in styles.css
    backgroundEffect: "none", // see background-fx.js's CANVAS_EFFECTS
    animationSpeed: 1, // multiplier on the background effect's motion
    mathScale: 1, // multiplier on every rendered math surface's font size
  };
  var DEFAULT_ACCENT = "#2563eb";
  var EFFECTS = ["none", "matrix", "grid", "spiral", "orbs"];
  var DEFAULT_BG_LIGHT = "#f2f3f5";
  var DEFAULT_BG_DARK = "#17181c";

  function isHex(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  // Older saves can hold preset names ("blue") or retired keys from the
  // previous theme system. Only keep values this version understands.
  function sanitize(saved) {
    var state = {
      accent: DEFAULTS.accent,
      accentSecondary: DEFAULTS.accentSecondary,
      background: DEFAULTS.background,
      panelOpacity: DEFAULTS.panelOpacity,
      backgroundEffect: DEFAULTS.backgroundEffect,
      animationSpeed: DEFAULTS.animationSpeed,
      mathScale: DEFAULTS.mathScale,
    };
    if (!saved || typeof saved !== "object") return state;
    if (isHex(saved.accent)) state.accent = saved.accent;
    if (isHex(saved.accentSecondary)) state.accentSecondary = saved.accentSecondary;
    if (isHex(saved.background)) state.background = saved.background;
    if (typeof saved.panelOpacity === "number") {
      state.panelOpacity = Math.max(20, Math.min(100, saved.panelOpacity));
    }
    if (EFFECTS.indexOf(saved.backgroundEffect) !== -1) state.backgroundEffect = saved.backgroundEffect;
    if (typeof saved.animationSpeed === "number") {
      state.animationSpeed = Math.max(0.25, Math.min(3, saved.animationSpeed));
    }
    if (typeof saved.mathScale === "number") state.mathScale = saved.mathScale;
    return state;
  }

  function load() {
    try {
      return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch (e) {
      return sanitize(null);
    }
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Ignore unavailable storage.
    }
  }

  function isLight(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 255000 > 0.55;
  }

  // Default secondary: the accent's hue turned 40 degrees, same saturation
  // and lightness, so it always sits next to the accent on the color wheel.
  function deriveSecondary(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255;
    var g = parseInt(hex.slice(3, 5), 16) / 255;
    var b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    var h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    h = (h * 60 + 40 + 360) % 360;
    return "hsl(" + h.toFixed(1) + " " + (s * 100).toFixed(1) + "% " + (l * 100).toFixed(1) + "%)";
  }

  function apply(state) {
    var root = document.documentElement;
    var osDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var bg = state.background || (osDark ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT);
    var accent = state.accent || DEFAULT_ACCENT;

    // Panel/text/border colors follow the background's own brightness, so a
    // dark custom background gets light text regardless of the OS setting.
    root.setAttribute("data-tone", isLight(bg) ? "light" : "dark");
    root.style.setProperty("--bg", bg);
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-text", isLight(accent) ? "#111111" : "#ffffff");
    root.style.setProperty("--accent-secondary", state.accentSecondary || deriveSecondary(accent));
    root.style.setProperty("--panel-alpha", state.panelOpacity + "%");
    // Menus, popovers and the settings dialog sit over other content, so
    // they only get a little of the transparency to stay readable.
    root.style.setProperty("--overlay-alpha", (90 + state.panelOpacity * 0.1) + "%");
    root.style.setProperty("--math-scale", state.mathScale);
    root.dataset.bgFx = state.backgroundEffect;
  }

  window.PrettyCASTheme = {
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    deriveSecondary: deriveSecondary,
    load: load,
    save: save,
    apply: apply,
  };

  apply(load());
})();
