import { getCapabilities } from "./api.js";

const STORAGE_KEY = "mathstuff2.settings";

const DEFAULTS = {
  copyFormat: "latex", // "latex" | "mathjson"
  displayMode: "debug", // "debug" | "user"
  numberFormat: "standard", // "standard" | "decimal" | "engineering"
  decimals: 6,
  angleMode: "rad", // "rad" | "deg"
  simplifyMode: "auto", // "auto" | "expand" | "factor"
  complexForm: "rectangular", // "rectangular" (a+bi) | "polar" (r*e^(i*theta)) — applies in every number format
  enginePreference: "sympy", // "sympy" | "maxima" — which is tried first for an integral or a general simplification
  preferAlgebraic: false, // hard equations/systems: try an exact solve first (slower) instead of going straight to numeric
  autoCompute: true, // whether typing recomputes on its own (see app.js's AUTO_COMPUTE_DELAY_MS) or only Enter does
  showHistory: true,
  uiZoom: 100, // percent — scales html's base font-size (see the --ui-zoom rule in styles.css), so it scales the whole rem-based UI
};

const DECIMALS_SLIDER_MAX = 50;
// The decimals slider is logarithmic: its raw 0..DECIMALS_SLIDER_STEPS
// position maps to 1..DECIMALS_SLIDER_MAX on a log scale, so small counts
// get most of the track instead of a sliver of it.
const DECIMALS_SLIDER_STEPS = 1000;

function sliderToDecimals(position) {
  return Math.round(Math.pow(DECIMALS_SLIDER_MAX, position / DECIMALS_SLIDER_STEPS));
}

function decimalsToSlider(decimals) {
  const clamped = Math.max(1, Math.min(decimals, DECIMALS_SLIDER_MAX));
  return Math.round((Math.log(clamped) / Math.log(DECIMALS_SLIDER_MAX)) * DECIMALS_SLIDER_STEPS);
}
const UI_ZOOM_MIN = 75;
const UI_ZOOM_MAX = 150;

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

export function getSettings() {
  return { ...state };
}

export function onSettingsChange(callback) {
  listeners.push(callback);
}

// Applied unconditionally on every settings change (not just from within
// mountSettingsPanel) so zoom keeps working even when the settings panel
// isn't currently mounted, and applied once up front so a saved zoom takes
// effect before the panel is ever opened.
function applyZoom(settings) {
  document.documentElement.style.setProperty("--ui-zoom", settings.uiZoom / 100);
}
applyZoom(state);
onSettingsChange(applyZoom);

// Applies a batch of settings as one atomic update — a single save/apply/
// notify instead of one per field — so multi-field changes (theme bundles)
// don't flash through partial intermediate states.
function applySettingsPatch(patch) {
  state = { ...state, ...patch };
  saveSettings();
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

const SETTINGS_TABS = [
  { id: "computation", label: "Computation" },
  // Filled by theme.js's mountThemePanel (mounted into #appearance-body).
  { id: "appearance", label: "Appearance" },
];
let activeSettingsTab = SETTINGS_TABS[0].id;

// Renders the settings form into `container` and wires it up to state.
// `container` should be an empty element; this owns its full contents.
export function mountSettingsPanel(container) {
  container.innerHTML = `
    <div class="settings-tabs" role="tablist">
      ${SETTINGS_TABS.map(
        (tab) => `<button type="button" class="settings-tab-btn" role="tab" data-tab="${tab.id}">${tab.label}</button>`
      ).join("")}
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
          <input type="range" name="decimalsSlider" min="0" max="${DECIMALS_SLIDER_STEPS}" step="1">
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
        <legend>Complex numbers</legend>
        <label><input type="radio" name="complexForm" value="rectangular"> Rectangular (a + bi)</label>
        <label><input type="radio" name="complexForm" value="polar"> Polar (r·e^(i&theta;))</label>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Solving</legend>
        <label><input type="checkbox" name="preferAlgebraic"> Prefer algebraic solutions</label>
        <p class="settings-hint">Hard equations and systems try an exact answer first, then a numeric one. Slower. Off: they go straight to numeric.</p>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Math engine</legend>
        <label><input type="radio" name="enginePreference" value="sympy"> Sympy (default)</label>
        <label class="settings-subitem"><input type="radio" name="enginePreference" value="maxima" id="engine-maxima-radio"> Maxima</label>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Display</legend>
        <label><input type="radio" name="displayMode" value="user"> User (clean result)</label>
        <label><input type="radio" name="displayMode" value="debug"> Debug (raw response)</label>
        <label class="settings-subitem"><input type="checkbox" name="showHistory"> Show history on this page</label>
        <div class="settings-subitem slider-control zoom-control">
          <span>Zoom</span>
          <input type="range" name="uiZoomSlider" min="${UI_ZOOM_MIN}" max="${UI_ZOOM_MAX}" step="5">
          <span class="zoom-value"></span>
        </div>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Copy as</legend>
        <label><input type="radio" name="copyFormat" value="latex"> LaTeX</label>
        <label><input type="radio" name="copyFormat" value="mathjson"> MathJSON</label>
      </fieldset>
    </div>

    <div class="settings-tab-panel" data-tab-panel="appearance">
      <div id="appearance-body"></div>
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

  container.addEventListener("click", (event) => {
    const tabBtn = event.target.closest(".settings-tab-btn");
    if (tabBtn) {
      activeSettingsTab = tabBtn.dataset.tab;
      syncTabs();
    }
  });

  const sync = () => {
    for (const el of container.querySelectorAll("input[type=radio]")) {
      el.checked = state[el.name] === el.value;
    }
    const maximaRadio = container.querySelector("#engine-maxima-radio");
    maximaRadio.disabled = !maximaAvailable;
    maximaRadio.closest("label").title = maximaAvailable ? "" : "Maxima isn't installed on this machine";
    container.querySelector("input[name=showHistory]").checked = state.showHistory;
    container.querySelector("input[name=autoCompute]").checked = state.autoCompute;
    container.querySelector("input[name=preferAlgebraic]").checked = state.preferAlgebraic;
    container.querySelector("input[name=decimals]").value = state.decimals;
    // Leave the thumb alone while it already maps to the current value, so
    // it doesn't snap around mid-drag.
    const slider = container.querySelector("input[name=decimalsSlider]");
    if (sliderToDecimals(Number(slider.value)) !== Math.min(state.decimals, DECIMALS_SLIDER_MAX)) {
      slider.value = decimalsToSlider(state.decimals);
    }
    container.querySelector("input[name=uiZoomSlider]").value = state.uiZoom;
    container.querySelector(".zoom-value").textContent = `${state.uiZoom}%`;
    container.dataset.numberFormat = state.numberFormat;
  };
  sync();

  container.addEventListener("input", (event) => {
    const el = event.target;
    if (el.name === "decimalsSlider") {
      const value = sliderToDecimals(parseInt(el.value, 10));
      if (value !== state.decimals) updateSetting("decimals", value);
    } else if (el.name === "uiZoomSlider") {
      updateSetting("uiZoom", parseInt(el.value, 10));
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
