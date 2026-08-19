import { getSettings, onSettingsChange, mountSettingsPanel, updateSetting } from './settings.js';

// ---------- Shared page chrome (settings drawer, hamburger menu, title debug-toggle) ----------

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

const appTitle = document.getElementById('app-title');
appTitle.addEventListener('click', () => {
  updateSetting('displayMode', getSettings().displayMode === 'debug' ? 'user' : 'debug');
});
function syncAppTitle() {
  appTitle.classList.toggle('is-debug', getSettings().displayMode === 'debug');
}
syncAppTitle();
onSettingsChange(syncAppTitle);
