const STORAGE_KEY = "mathstuff2.settings";

const DEFAULTS = {
  copyFormat: "latex", // "latex" | "mathjson"
  displayMode: "debug", // "debug" | "user"
  numberFormat: "standard", // "standard" | "decimal" | "engineering"
  decimals: 6,
  angleMode: "rad", // "rad" | "deg"
  simplifyMode: "auto", // "auto" | "expand" | "factor"
  // A preset name ("indigo" etc.) or an arbitrary "#rrggbb" from the color pickers below.
  accent: "indigo",
  background: null, // null = theme default, else an arbitrary "#rrggbb"
  backgroundEffect: "matrix", // "none" | "matrix" | "circuit" | "spiral" | "pulse"
  showHistory: true,
};

const ACCENTS = [
  { value: "indigo", label: "Indigo" },
  { value: "crimson", label: "Red" },
  { value: "sand", label: "Beige" },
  { value: "emerald", label: "Green" },
  { value: "violet", label: "Purple" },
  { value: "slate", label: "Slate" },
];

const BACKGROUNDS = [
  { value: "#eef0f6", label: "Cool gray" },
  { value: "#f6f1e6", label: "Cream" },
  { value: "#0f1115", label: "Midnight" },
  { value: "#0d1912", label: "Forest" },
];

const DEFAULT_ACCENT_SWATCH = "#4f5bff";
const DEFAULT_BG_LIGHT = "#eef0f6";
const DEFAULT_BG_DARK = "#14151f";

const DECIMALS_SLIDER_MAX = 50;

// Panels/text/borders aren't a separate light/dark choice — their tone is
// derived from whatever background color is actually in effect (custom, or
// the OS-preference default), by that color's own perceived brightness.
// Duplicated in theme-init.js (see the comment there for why).
function bgTone(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return "light";
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 255000;
  return brightness > 0.55 ? "light" : "dark";
}

let state = loadSettings();
const listeners = [];

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  // Swallow write failures (localStorage disabled/unavailable, quota, etc.)
  // the same way loadSettings() already tolerates read failures — settings
  // just won't persist rather than throwing and aborting updateSetting()
  // before it applies the change or notifies listeners.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function applyTheme() {
  const root = document.documentElement;

  if (state.accent.startsWith("#")) {
    root.dataset.accent = "custom";
    root.style.setProperty("--accent-custom", state.accent);
  } else {
    root.dataset.accent = state.accent;
  }

  if (state.background) {
    root.dataset.customBg = "true";
    root.style.setProperty("--bg-custom", state.background);
  } else {
    root.removeAttribute("data-custom-bg");
  }

  const osDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effectiveBg = state.background || (osDark ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT);
  root.dataset.bgTone = bgTone(effectiveBg);
}

applyTheme();

// The OS preference only matters when there's no custom background — but
// unlike --bg itself (a pure CSS media query), data-bg-tone is JS-computed
// and needs its own listener to stay live when the OS setting flips.
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!state.background) applyTheme();
  });
}

export function getSettings() {
  return { ...state };
}

export function onSettingsChange(callback) {
  listeners.push(callback);
}

export function updateSetting(key, value) {
  state = { ...state, [key]: value };
  saveSettings();
  applyTheme();
  listeners.forEach((callback) => callback(getSettings()));
}

// Renders the settings form into `container` and wires it up to state.
// `container` should be an empty element; this owns its full contents.
export function mountSettingsPanel(container) {
  container.innerHTML = `
    <fieldset class="settings-group">
      <legend>Appearance</legend>

      <div class="color-field">
        <span class="color-field-label">Accent</span>
        <div class="swatch-row" role="group" aria-label="Accent color">
          ${ACCENTS.map(
            (a) => `<button type="button" class="swatch" data-accent-preset="${a.value}" title="${a.label}" aria-label="${a.label}"></button>`
          ).join("")}
          <input type="color" name="accentCustom" class="color-picker" title="Custom accent color" aria-label="Custom accent color" value="${DEFAULT_ACCENT_SWATCH}">
        </div>
      </div>

      <div class="color-field">
        <span class="color-field-label">Background</span>
        <div class="swatch-row" role="group" aria-label="Background color">
          <button type="button" class="swatch swatch-reset" data-bg-preset="" title="Default (follows system light/dark)" aria-label="Default background">&times;</button>
          ${BACKGROUNDS.map(
            (b) => `<button type="button" class="swatch" data-bg-preset="${b.value}" style="background:${b.value}" title="${b.label}" aria-label="${b.label}"></button>`
          ).join("")}
          <input type="color" name="bgCustom" class="color-picker" title="Custom background color" aria-label="Custom background color" value="${DEFAULT_ACCENT_SWATCH}">
        </div>
      </div>

      <div class="color-field">
        <span class="color-field-label">Background effect</span>
        <label><input type="radio" name="backgroundEffect" value="none"> None</label>
        <label><input type="radio" name="backgroundEffect" value="matrix"> Matrix rain</label>
        <label><input type="radio" name="backgroundEffect" value="circuit"> Circuitry</label>
        <label><input type="radio" name="backgroundEffect" value="spiral"> Spiral</label>
        <label><input type="radio" name="backgroundEffect" value="pulse"> Pulse glow</label>
      </div>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Angles</legend>
      <label><input type="radio" name="angleMode" value="rad"> Radians</label>
      <label><input type="radio" name="angleMode" value="deg"> Degrees</label>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Numbers</legend>
      <label><input type="radio" name="numberFormat" value="standard"> Standard (exact)</label>
      <label><input type="radio" name="numberFormat" value="decimal"> Decimal</label>
      <label><input type="radio" name="numberFormat" value="engineering"> Engineering</label>
      <div class="decimals-control">
        <input type="range" name="decimalsSlider" min="1" max="${DECIMALS_SLIDER_MAX}" step="1">
        <input type="number" name="decimals" min="1" max="1000" step="1">
      </div>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Result form</legend>
      <label><input type="radio" name="simplifyMode" value="auto"> Auto (simplify)</label>
      <label><input type="radio" name="simplifyMode" value="expand"> Expand</label>
      <label><input type="radio" name="simplifyMode" value="factor"> Factor</label>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Display</legend>
      <label><input type="radio" name="displayMode" value="user"> User (clean result)</label>
      <label><input type="radio" name="displayMode" value="debug"> Debug (raw response)</label>
      <label class="settings-subitem"><input type="checkbox" name="showHistory"> Show history on this page</label>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Copy as</legend>
      <label><input type="radio" name="copyFormat" value="latex"> LaTeX</label>
      <label><input type="radio" name="copyFormat" value="mathjson"> MathJSON</label>
    </fieldset>
  `;

  const sync = () => {
    for (const el of container.querySelectorAll("input[type=radio]")) {
      el.checked = state[el.name] === el.value;
    }
    container.querySelector("input[name=showHistory]").checked = state.showHistory;
    container.querySelector("input[name=decimals]").value = state.decimals;
    container.querySelector("input[name=decimalsSlider]").value = Math.min(state.decimals, DECIMALS_SLIDER_MAX);
    container.dataset.numberFormat = state.numberFormat;

    const customAccent = state.accent.startsWith("#");
    for (const el of container.querySelectorAll(".swatch[data-accent-preset]")) {
      el.classList.toggle("is-active", !customAccent && el.dataset.accentPreset === state.accent);
    }
    container.querySelector("input[name=accentCustom]").value = customAccent ? state.accent : DEFAULT_ACCENT_SWATCH;
    container.querySelector("input[name=accentCustom]").classList.toggle("is-active", customAccent);

    for (const el of container.querySelectorAll(".swatch[data-bg-preset]")) {
      el.classList.toggle("is-active", el.dataset.bgPreset === (state.background || ""));
    }
    const customBg = Boolean(state.background) && !BACKGROUNDS.some((b) => b.value === state.background);
    container.querySelector("input[name=bgCustom]").value = state.background || DEFAULT_ACCENT_SWATCH;
    container.querySelector("input[name=bgCustom]").classList.toggle("is-active", customBg);
  };
  sync();

  container.addEventListener("click", (event) => {
    const accentSwatch = event.target.closest(".swatch[data-accent-preset]");
    if (accentSwatch) {
      updateSetting("accent", accentSwatch.dataset.accentPreset);
      return;
    }
    const bgSwatch = event.target.closest(".swatch[data-bg-preset]");
    if (bgSwatch) updateSetting("background", bgSwatch.dataset.bgPreset || null);
  });

  container.addEventListener("input", (event) => {
    const el = event.target;
    if (el.name === "decimalsSlider") {
      updateSetting("decimals", parseInt(el.value, 10));
    } else if (el.name === "accentCustom") {
      updateSetting("accent", el.value);
    } else if (el.name === "bgCustom") {
      updateSetting("background", el.value);
    }
  });

  container.addEventListener("change", (event) => {
    const el = event.target;
    if (el.type === "radio") {
      updateSetting(el.name, el.value);
    } else if (el.type === "checkbox") {
      updateSetting(el.name, el.checked);
    } else if (el.name === "decimals") {
      const value = Math.max(1, Math.min(1000, parseInt(el.value, 10) || DEFAULTS.decimals));
      el.value = value;
      updateSetting("decimals", value);
    }
  });

  onSettingsChange(sync);
}
