// Appearance state (accent, secondary accent, background, background effect, panel opacity, math size), kept in
// its own localStorage key (`mathstuff2.theme`), separate from settings.js's
// computation settings. Loading, saving and applying live in theme-init.js,
// which runs before first paint; this module owns the Settings controls.
const { DEFAULT_ACCENT, deriveSecondary, load, save, apply } = window.PrettyCASTheme;

const MATH_SCALE_MIN = 0.5;
const MATH_SCALE_MAX = 2;
const MATH_SCALE_STEP = 0.05;
const PANEL_OPACITY_MIN = 20;
const ANIMATION_SPEED_MIN = 0.25;
const ANIMATION_SPEED_MAX = 3;
const ANIMATION_SPEED_STEP = 0.25;

let state = load();
const listeners = [];

if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!state.background) apply(state);
  });
}

export function getThemeSettings() {
  return { ...state };
}

export function onThemeChange(callback) {
  listeners.push(callback);
}

export function updateThemeSetting(key, value) {
  state = { ...state, [key]: value };
  save(state);
  apply(state);
  listeners.forEach((callback) => callback(getThemeSettings()));
}

function currentBackground() {
  return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
}

// The derived default is an hsl() string; <input type=color> needs #rrggbb.
function currentSecondary() {
  const probe = document.createElement("span");
  probe.style.color = deriveSecondary(state.accent || DEFAULT_ACCENT);
  document.body.appendChild(probe);
  const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g).map(Number);
  probe.remove();
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

// Renders the Appearance controls into `container` (an empty element this
// function owns).
export function mountThemePanel(container) {
  container.innerHTML = `
    <fieldset class="settings-group">
      <legend>Colors</legend>
      <div class="color-row">
        <span>Accent</span>
        <input type="color" name="accent" aria-label="Accent color">
        <button type="button" class="link-btn" data-reset="accent">Reset</button>
      </div>
      <div class="color-row">
        <span>Secondary</span>
        <input type="color" name="accentSecondary" aria-label="Secondary accent color">
        <button type="button" class="link-btn" data-reset="accentSecondary">Reset</button>
      </div>
      <div class="color-row">
        <span>Background</span>
        <input type="color" name="background" aria-label="Background color">
        <button type="button" class="link-btn" data-reset="background">Reset</button>
      </div>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Background effect</legend>
      <label><input type="radio" name="backgroundEffect" value="none"> None</label>
      <label><input type="radio" name="backgroundEffect" value="matrix"> Matrix rain</label>
      <label><input type="radio" name="backgroundEffect" value="grid"> Synthwave</label>
      <label><input type="radio" name="backgroundEffect" value="spiral"> Spiral</label>
      <label><input type="radio" name="backgroundEffect" value="orbs"> Soft orbs</label>
      <div class="slider-control">
        <span>Speed</span>
        <input type="range" name="animationSpeed" min="${ANIMATION_SPEED_MIN}" max="${ANIMATION_SPEED_MAX}" step="${ANIMATION_SPEED_STEP}">
        <span class="slider-value animation-speed-value"></span>
      </div>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Panels</legend>
      <div class="slider-control">
        <span>Opacity</span>
        <input type="range" name="panelOpacity" min="${PANEL_OPACITY_MIN}" max="100" step="1">
        <span class="slider-value panel-opacity-value"></span>
      </div>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Math display</legend>
      <div class="slider-control">
        <span>Math size</span>
        <input type="range" name="mathScale" min="${MATH_SCALE_MIN}" max="${MATH_SCALE_MAX}" step="${MATH_SCALE_STEP}">
        <span class="slider-value math-scale-value"></span>
      </div>
    </fieldset>
  `;

  const sync = () => {
    container.querySelector("input[name=accent]").value = state.accent || DEFAULT_ACCENT;
    container.querySelector("input[name=accentSecondary]").value = state.accentSecondary || currentSecondary();
    container.querySelector("input[name=background]").value = state.background || currentBackground();
    container.querySelector("[data-reset=accent]").hidden = !state.accent;
    container.querySelector("[data-reset=accentSecondary]").hidden = !state.accentSecondary;
    container.querySelector("[data-reset=background]").hidden = !state.background;
    container.querySelector("input[name=panelOpacity]").value = state.panelOpacity;
    container.querySelector(".panel-opacity-value").textContent = `${state.panelOpacity}%`;
    for (const el of container.querySelectorAll("input[name=backgroundEffect]")) {
      el.checked = el.value === state.backgroundEffect;
    }
    container.querySelector("input[name=animationSpeed]").value = state.animationSpeed;
    container.querySelector(".animation-speed-value").textContent = `${state.animationSpeed}x`;
    container.querySelector("input[name=mathScale]").value = state.mathScale;
    container.querySelector(".math-scale-value").textContent = `${Math.round(state.mathScale * 100)}%`;
  };
  sync();

  container.addEventListener("input", (event) => {
    const el = event.target;
    if (el.name === "accent" || el.name === "accentSecondary" || el.name === "background") {
      updateThemeSetting(el.name, el.value);
    } else if (el.name === "panelOpacity") {
      updateThemeSetting("panelOpacity", parseInt(el.value, 10));
    } else if (el.name === "backgroundEffect") {
      updateThemeSetting("backgroundEffect", el.value);
    } else if (el.name === "animationSpeed") {
      updateThemeSetting("animationSpeed", parseFloat(el.value));
    } else if (el.name === "mathScale") {
      updateThemeSetting("mathScale", parseFloat(el.value));
    }
  });

  container.addEventListener("click", (event) => {
    const reset = event.target.closest("[data-reset]");
    if (reset) updateThemeSetting(reset.dataset.reset, null);
  });

  onThemeChange(sync);
}
