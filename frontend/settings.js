import { getCapabilities } from "./api.js";

const STORAGE_KEY = "mathstuff2.settings";

const DEFAULTS = {
  copyFormat: "latex", // "latex" | "mathjson"
  displayMode: "debug", // "debug" | "user"
  numberFormat: "standard", // "standard" | "decimal" | "engineering"
  decimals: 6,
  angleMode: "rad", // "rad" | "deg"
  simplifyMode: "auto", // "auto" | "expand" | "factor"
  enginePreference: "sympy", // "sympy" | "maxima" — which is tried first for an integral
  autoCompute: true, // whether typing recomputes on its own (see app.js's AUTO_COMPUTE_DELAY_MS) or only Enter does
  // A preset name ("blue" etc.) or an arbitrary "#rrggbb" from the color pickers below.
  accent: "blue",
  accentSecondary: null, // null = auto-derived; a preset name ("rose" etc.); or an arbitrary "#rrggbb"
  background: null, // null = theme default, else an arbitrary "#rrggbb"
  backgroundEffect: "matrix", // "none" | "matrix" | "grid" | "spiral"
  panelOpacity: 100, // 100 = solid; lower lets the background effect show through the panels
  panelBlur: 10, // px of backdrop blur behind a translucent panel; 0 = none (crisp see-through)
  animationSpeed: 1, // multiplier applied to every background effect's motion
  mathScale: 1, // multiplier applied to every rendered math surface's font size
  showHistory: true,
  squareCorners: false, // false = the theme's rounded --radius/--radius-sm; true = sharp 0px corners on inputs/buttons/panels
};

const ACCENTS = [
  { value: "blue", label: "Blue" },
  { value: "red", label: "Red" },
  { value: "purple", label: "Purple" },
  { value: "green", label: "Green" },
  { value: "orange", label: "Orange" },
  { value: "black", label: "Black" },
];

// Each sits at the color-wheel hue halfway between two adjacent primary
// accents above (blue-red-purple-green-orange-black, wrapping around) —
// see the styles.css comment by :root[data-accent-secondary="orchid"] for
// the exact hues and how the two gaps touching "black" (which has no hue
// of its own) are handled.
// Actual colors live in styles.css (:root[data-accent-secondary="orchid"]
// etc. and the matching .swatch rules) — this is just the list of valid
// values and their labels.
const SECONDARY_ACCENTS = [
  { value: "orchid", label: "Orchid" },
  { value: "rose", label: "Rose" },
  { value: "cyan", label: "Cyan" },
  { value: "olive", label: "Olive" },
  { value: "bronze", label: "Bronze" },
  { value: "slate", label: "Slate" },
];

const BACKGROUNDS = [
  { value: "#0a0a0d", label: "Black" },
  { value: "#ffffff", label: "White" },
  { value: "#e6e6ea", label: "Light gray" },
  { value: "#2a2a2e", label: "Dark gray" },
  // Bone: a warm, desaturated off-white, not a rich/saturated tan. Midnight
  // blue is the only actually saturated color left in this list; the rest,
  // bone included, stay closer to neutral.
  { value: "#e4dcc8", label: "Bone" },
  { value: "#081c4d", label: "Midnight blue" },
];

const DEFAULT_ACCENT_SWATCH = "#4f5bff";
const DEFAULT_BG_LIGHT = "#eef0f6";
const DEFAULT_BG_DARK = "#14151f";

const DECIMALS_SLIDER_MAX = 50;
const PANEL_OPACITY_MIN = 5; // down to almost fully see-through; 0 would make the panel outline the only thing left
const PANEL_BLUR_MAX = 20; // px
const ANIMATION_SPEED_MIN = 0.25;
const ANIMATION_SPEED_MAX = 2;
const ANIMATION_SPEED_STEP = 0.25;
const MATH_SCALE_MIN = 0.5;
const MATH_SCALE_MAX = 2;
const MATH_SCALE_STEP = 0.05;

const SETTINGS_TABS = [
  { id: "appearance", label: "Appearance" },
  // Everything that changes how an answer is computed or shown, as opposed
  // to how the app looks: angle/number/result-form conventions, debug vs.
  // clean output, and copy format.
  { id: "computation", label: "Computation" },
];
let activeSettingsTab = SETTINGS_TABS[0].id;

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

  if (!state.accentSecondary) {
    root.removeAttribute("data-accent-secondary");
  } else if (state.accentSecondary.startsWith("#")) {
    root.dataset.accentSecondary = "custom";
    root.style.setProperty("--accent-secondary-custom", state.accentSecondary);
  } else {
    root.dataset.accentSecondary = state.accentSecondary;
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

  root.style.setProperty("--panel-alpha", `${state.panelOpacity}%`);
  // See theme-init.js's copy of this same logic for why 0 maps to "none"
  // rather than to blur(0px): a zero-radius blur still forces a compositing
  // layer that visibly glitches the text drawn under/in the panel.
  root.style.setProperty("--panel-backdrop", state.panelBlur > 0 ? `blur(${state.panelBlur}px)` : "none");
  root.style.setProperty("--panel-backdrop-topbar", state.panelBlur > 0 ? `saturate(180%) blur(${state.panelBlur}px)` : "none");
  root.style.setProperty("--fx-speed", state.animationSpeed);
  root.style.setProperty("--math-scale", state.mathScale);

  root.dataset.corners = state.squareCorners ? "square" : "rounded";
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

// Applies a batch of settings as one atomic update — a single save/apply/
// notify instead of one per field — so multi-field changes (theme bundles)
// don't flash through partial intermediate states.
function applySettingsPatch(patch) {
  state = { ...state, ...patch };
  saveSettings();
  applyTheme();
  listeners.forEach((callback) => callback(getSettings()));
}

export function updateSetting(key, value) {
  applySettingsPatch({ [key]: value });
}

// Whether Maxima is available as an integration fallback on this machine —
// mountSettingsPanel's sync() greys out that radio until this resolves (and
// permanently, if it resolves to false). Starts false rather than assuming
// available, so a mounted panel never briefly offers a choice that turns
// out not to work.
let maximaAvailable = false;
getCapabilities().then((caps) => {
  maximaAvailable = Boolean(caps.maxima_available);
  if (!maximaAvailable && state.enginePreference === "maxima") {
    // Was picked on a machine/build that had Maxima; this one doesn't —
    // fall back to the setting that actually works rather than leave a
    // saved preference the panel can no longer even let them select.
    applySettingsPatch({ enginePreference: "sympy" });
  } else {
    listeners.forEach((callback) => callback(getSettings()));
  }
});

// Renders the settings form into `container` and wires it up to state.
// `container` should be an empty element; this owns its full contents.
export function mountSettingsPanel(container) {
  container.innerHTML = `
    <div class="settings-tabs" role="tablist">
      ${SETTINGS_TABS.map(
        (tab) => `<button type="button" class="settings-tab-btn" role="tab" data-tab="${tab.id}">${tab.label}</button>`
      ).join("")}
    </div>

    <div class="settings-tab-panel" data-tab-panel="appearance">
      <fieldset class="settings-group">
        <legend>Colors &amp; background</legend>

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
          <span class="color-field-label">Secondary accent</span>
          <div class="swatch-row" role="group" aria-label="Secondary accent color">
            ${SECONDARY_ACCENTS.map(
              (a) => `<button type="button" class="swatch" data-accent-secondary-preset="${a.value}" title="${a.label}" aria-label="${a.label}"></button>`
            ).join("")}
            <input type="color" name="accentSecondaryCustom" class="color-picker" title="Custom secondary accent color" aria-label="Custom secondary accent color" value="${DEFAULT_ACCENT_SWATCH}">
          </div>
        </div>

        <div class="color-field">
          <span class="color-field-label">Background</span>
          <div class="swatch-row" role="group" aria-label="Background color">
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
          <label><input type="radio" name="backgroundEffect" value="grid"> Synthwave</label>
          <label><input type="radio" name="backgroundEffect" value="spiral"> Spiral</label>
          <label><input type="radio" name="backgroundEffect" value="orbs"> Soft pulse orbs</label>
        </div>

        <div class="color-field">
          <span class="color-field-label">Panel transparency</span>
          <div class="slider-control">
            <input type="range" name="panelOpacity" min="${PANEL_OPACITY_MIN}" max="100" step="1">
            <span class="panel-opacity-value"></span>
          </div>
        </div>

        <div class="color-field">
          <span class="color-field-label">Panel blur</span>
          <div class="slider-control">
            <input type="range" name="panelBlur" min="0" max="${PANEL_BLUR_MAX}" step="1">
            <span class="panel-blur-value"></span>
          </div>
        </div>

        <div class="color-field">
          <span class="color-field-label">Animation speed</span>
          <div class="slider-control">
            <input type="range" name="animationSpeed" min="${ANIMATION_SPEED_MIN}" max="${ANIMATION_SPEED_MAX}" step="${ANIMATION_SPEED_STEP}">
            <span class="animation-speed-value"></span>
          </div>
        </div>

        <div class="color-field">
          <span class="color-field-label">Math size</span>
          <div class="slider-control">
            <input type="range" name="mathScale" min="${MATH_SCALE_MIN}" max="${MATH_SCALE_MAX}" step="${MATH_SCALE_STEP}">
            <span class="math-scale-value"></span>
          </div>
        </div>

        <div class="color-field">
          <span class="color-field-label">Corners</span>
          <label><input type="checkbox" name="squareCorners"> Square corners (instead of rounded)</label>
        </div>
      </fieldset>
    </div>

    <div class="settings-tab-panel" data-tab-panel="computation">
      <fieldset class="settings-group">
        <legend>Auto-compute</legend>
        <label><input type="checkbox" name="autoCompute"> Compute automatically while typing</label>
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
        <div class="slider-control decimals-control">
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
        <legend>Integration engine</legend>
        <label><input type="radio" name="enginePreference" value="sympy"> Sympy (default)</label>
        <label class="settings-subitem"><input type="radio" name="enginePreference" value="maxima" id="engine-maxima-radio"> Maxima</label>
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
    </div>
  `;

  const syncTabs = () => {
    for (const btn of container.querySelectorAll(".settings-tab-btn")) {
      btn.classList.toggle("is-active", btn.dataset.tab === activeSettingsTab);
    }
    for (const panel of container.querySelectorAll(".settings-tab-panel")) {
      panel.hidden = panel.dataset.tabPanel !== activeSettingsTab;
    }
  };
  syncTabs();

  const sync = () => {
    for (const el of container.querySelectorAll("input[type=radio]")) {
      el.checked = state[el.name] === el.value;
    }
    const maximaRadio = container.querySelector("#engine-maxima-radio");
    maximaRadio.disabled = !maximaAvailable;
    maximaRadio.closest("label").title = maximaAvailable ? "" : "Maxima isn't installed on this machine";
    container.querySelector("input[name=showHistory]").checked = state.showHistory;
    container.querySelector("input[name=autoCompute]").checked = state.autoCompute;
    container.querySelector("input[name=squareCorners]").checked = state.squareCorners;
    container.querySelector("input[name=decimals]").value = state.decimals;
    container.querySelector("input[name=decimalsSlider]").value = Math.min(state.decimals, DECIMALS_SLIDER_MAX);
    container.dataset.numberFormat = state.numberFormat;

    container.querySelector("input[name=panelOpacity]").value = state.panelOpacity;
    container.querySelector(".panel-opacity-value").textContent = `${state.panelOpacity}%`;
    container.querySelector("input[name=panelBlur]").value = state.panelBlur;
    container.querySelector(".panel-blur-value").textContent = `${state.panelBlur}px`;
    container.querySelector("input[name=animationSpeed]").value = state.animationSpeed;
    container.querySelector(".animation-speed-value").textContent = `${state.animationSpeed}x`;
    container.querySelector("input[name=mathScale]").value = state.mathScale;
    container.querySelector(".math-scale-value").textContent = `${Math.round(state.mathScale * 100)}%`;

    const customAccent = state.accent.startsWith("#");
    for (const el of container.querySelectorAll(".swatch[data-accent-preset]")) {
      el.classList.toggle("is-active", !customAccent && el.dataset.accentPreset === state.accent);
    }
    container.querySelector("input[name=accentCustom]").value = customAccent ? state.accent : DEFAULT_ACCENT_SWATCH;
    container.querySelector("input[name=accentCustom]").classList.toggle("is-active", customAccent);

    const customSecondary = typeof state.accentSecondary === "string" && state.accentSecondary.startsWith("#");
    const secondaryPresetValue = customSecondary ? "" : state.accentSecondary || "";
    for (const el of container.querySelectorAll(".swatch[data-accent-secondary-preset]")) {
      el.classList.toggle("is-active", !customSecondary && el.dataset.accentSecondaryPreset === secondaryPresetValue);
    }
    container.querySelector("input[name=accentSecondaryCustom]").value = customSecondary ? state.accentSecondary : DEFAULT_ACCENT_SWATCH;
    container.querySelector("input[name=accentSecondaryCustom]").classList.toggle("is-active", customSecondary);

    for (const el of container.querySelectorAll(".swatch[data-bg-preset]")) {
      el.classList.toggle("is-active", el.dataset.bgPreset === (state.background || ""));
    }
    const customBg = Boolean(state.background) && !BACKGROUNDS.some((b) => b.value === state.background);
    container.querySelector("input[name=bgCustom]").value = state.background || DEFAULT_ACCENT_SWATCH;
    container.querySelector("input[name=bgCustom]").classList.toggle("is-active", customBg);
  };
  sync();

  container.addEventListener("click", (event) => {
    const tabBtn = event.target.closest(".settings-tab-btn");
    if (tabBtn) {
      activeSettingsTab = tabBtn.dataset.tab;
      syncTabs();
      return;
    }
    const accentSwatch = event.target.closest(".swatch[data-accent-preset]");
    if (accentSwatch) {
      updateSetting("accent", accentSwatch.dataset.accentPreset);
      return;
    }
    const accentSecondarySwatch = event.target.closest(".swatch[data-accent-secondary-preset]");
    if (accentSecondarySwatch) {
      updateSetting("accentSecondary", accentSecondarySwatch.dataset.accentSecondaryPreset || null);
      return;
    }
    const bgSwatch = event.target.closest(".swatch[data-bg-preset]");
    if (bgSwatch) {
      updateSetting("background", bgSwatch.dataset.bgPreset || null);
      return;
    }
  });

  container.addEventListener("input", (event) => {
    const el = event.target;
    if (el.name === "decimalsSlider") {
      updateSetting("decimals", parseInt(el.value, 10));
    } else if (el.name === "panelOpacity") {
      updateSetting("panelOpacity", parseInt(el.value, 10));
    } else if (el.name === "panelBlur") {
      updateSetting("panelBlur", parseInt(el.value, 10));
    } else if (el.name === "animationSpeed") {
      updateSetting("animationSpeed", parseFloat(el.value));
    } else if (el.name === "mathScale") {
      updateSetting("mathScale", parseFloat(el.value));
    } else if (el.name === "accentCustom") {
      updateSetting("accent", el.value);
    } else if (el.name === "accentSecondaryCustom") {
      updateSetting("accentSecondary", el.value);
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
