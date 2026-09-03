// The single entry point for the whole app: owns the shared chrome (settings
// drawer, misc menu, app-title debug toggle) that used to be duplicated
// verbatim in app.js/plot.js/help.js/misc.js — one page load now, one of
// each of these elements exists, so each only needs wiring once, here —
// and the view-switching logic that replaces what used to be real page
// navigations (see index.html's <main data-view> landmarks).
import { getSettings, onSettingsChange, mountSettingsPanel, updateSetting } from './settings.js';
import { mount as mountCompute } from './pages/app.js';

// ---------- Shared chrome ----------

const settingsBackdrop = document.getElementById('settings-backdrop');
document.getElementById('settings-toggle').addEventListener('click', () => settingsBackdrop.classList.add('open'));
settingsBackdrop.addEventListener('click', (event) => {
  if (event.target === settingsBackdrop) settingsBackdrop.classList.remove('open');
});
mountSettingsPanel(document.getElementById('settings-body'));

const miscMenuToggle = document.getElementById('misc-menu-toggle');
const miscMenu = document.getElementById('misc-menu');
miscMenuToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  miscMenu.hidden = !miscMenu.hidden;
});
document.addEventListener('click', (event) => {
  if (!miscMenu.hidden && !miscMenu.contains(event.target) && event.target !== miscMenuToggle) {
    miscMenu.hidden = true;
  }
});

// Clicking the title toggles debug mode — a quicker path than opening
// Settings for something that gets flipped this often.
const appTitle = document.getElementById('app-title');
appTitle.addEventListener('click', () => {
  updateSetting('displayMode', getSettings().displayMode === 'debug' ? 'user' : 'debug');
});
function syncAppTitle() {
  appTitle.classList.toggle('is-debug', getSettings().displayMode === 'debug');
}
syncAppTitle();
onSettingsChange(syncAppTitle);

// ---------- View switching ----------

const views = document.querySelectorAll('main[data-view]');
const navLinks = document.querySelectorAll('a[data-view]');
const mounted = new Set(['compute']);
let plotModule = null;

// Plotly is loaded via a plain classic <script> (not an import — plot.js
// only ever references the resulting global, never at module-body scope),
// injected only once Plot is actually opened rather than unconditionally on
// every launch, since most sessions may never visit it. Memoized so
// switching to Plot repeatedly doesn't re-inject the tag.
let plotlyReady = null;
function ensurePlotlyLoaded() {
  if (!plotlyReady) {
    plotlyReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './node_modules/plotly.js-gl3d-dist-min/plotly-gl3d.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  return plotlyReady;
}

async function switchView(view) {
  if (!mounted.has(view)) {
    mounted.add(view);
    if (view === 'plot') {
      await ensurePlotlyLoaded();
      plotModule = await import('./pages/plot.js');
      plotModule.mount();
    } else if (view === 'help') {
      const helpModule = await import('./pages/help.js');
      helpModule.mount();
    }
    // 'misc' has no module — its markup is static, nothing to mount.
  }

  for (const el of views) el.hidden = el.dataset.view !== view;
  for (const link of navLinks) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  // Called on every switch, not just the first mount, so Plot's background
  // work (redraws, backend fetches) pauses while hidden and resumes —
  // resized against its now-current container size — when shown again.
  if (plotModule) plotModule.setActive(view === 'plot');
}

for (const link of navLinks) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    // The misc-menu link used to close on click for free, as a side effect
    // of the real page navigation it triggered; now that switching views
    // doesn't navigate, it has to be told to close explicitly.
    miscMenu.hidden = true;
    switchView(link.dataset.view);
  });
}

mountCompute();
