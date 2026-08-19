import './node_modules/mathlive/mathlive.min.mjs';
import { ComputeEngine, compile } from './node_modules/@cortex-js/compute-engine/dist/esm-min/compute-engine.js';
import { convertLatexToMarkup } from './node_modules/mathlive/mathlive.min.mjs';
import { computeMathJson } from './api.js';
import { getSettings, onSettingsChange, mountSettingsPanel, updateSetting } from './settings.js';
import { addEntry, mountHistory } from './history.js';
import { getWorkspace, setVar, mountWorkspace } from './workspace.js';

// Settings that feed the backend computation itself: changing any of these
// invalidates the last response, so it's re-sent rather than just re-rendered.
const RECOMPUTE_KEYS = ['angleMode', 'numberFormat', 'decimals', 'simplifyMode'];

// Front-page quick toggles: each is a single button that cycles through its
// values on click and just states the current one, rather than a segmented
// control showing every option at once.
const CYCLE_OPTIONS = {
  angleMode: [
    { value: 'rad', label: 'Radians' },
    { value: 'deg', label: 'Degrees' },
  ],
  numberFormat: [
    { value: 'standard', label: 'Standard' },
    { value: 'decimal', label: 'Decimal' },
    { value: 'engineering', label: 'Engineering' },
  ],
  simplifyMode: [
    { value: 'auto', label: 'Auto' },
    { value: 'expand', label: 'Expand' },
    { value: 'factor', label: 'Factor' },
  ],
};

const ce = new ComputeEngine();
// f/g/h are the conventional "unknown function" letters (f(x), f'(x), ODEs
// in f, ...). Without this, compute-engine has no way to know "f" names a
// function rather than a variable, so "f(x)" parses as implicit
// multiplication (f * x) instead of function application — silently
// dropping exactly the calculus problems this app is for. Other letters
// (a, b, k, ...) are left alone so "a(b+c)" still means multiplication.
ce.declare({ f: 'function', g: 'function', h: 'function' });
globalThis.MathfieldElement.computeEngine = ce;

const mf = document.getElementById('mf');
const outputPanel = document.getElementById('output-panel');
const outputBadges = document.getElementById('output-badges');
const outputRender = document.getElementById('output-render');

let lastResponse = null;

function getMathJson() {
  let mathjson = mf.getValue('math-json');
  if (typeof mathjson === 'string') mathjson = JSON.parse(mathjson);
  return mathjson;
}

// Same idea as the Plot page's constant-row detection: "a = <rhs>" (bare
// symbol on one side of an Equal, LaTeX-parsed via the boxed expression API
// rather than raw mathjson) names a workspace assignment worth remembering.
function getAssignmentParts(parsed) {
  if (parsed.operator !== 'Equal') return null;
  if (typeof parsed.op1?.symbol === 'string') return { name: parsed.op1.symbol, rhs: parsed.op2 };
  if (typeof parsed.op2?.symbol === 'string') return { name: parsed.op2.symbol, rhs: parsed.op1 };
  return null;
}

function evalNumeric(expr, vars) {
  try {
    const compiled = compile(expr, { realOnly: true });
    const value = compiled.run(vars);
    return typeof value === 'number' ? value : NaN;
  } catch {
    return NaN;
  }
}

// navigator.clipboard.writeText() needs a permission grant that the
// desktop app's embedded webview (QtWebEngine) denies outright — it just
// silently rejects, so the copy buttons did nothing there. execCommand
// predates that permission model and isn't gated by it, so it's the
// fallback whenever the modern API isn't available or fails.
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
  } else {
    fallbackCopyText(text);
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {
    // nothing more we can do
  }
  document.body.removeChild(textarea);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function summarize(response) {
  if (response.mode === 'error') return `error: ${response.result}`;
  if (Array.isArray(response.result)) return response.result.join(', ') || '(no solution)';
  return String(response.result);
}

// The clean, pretty-rendered form of a result — used for user mode, and
// reused inside debug mode so debug is a superset (everything plus this),
// not a replacement for it.
function resultMarkup(response) {
  if (response.mode === 'check') {
    const isTrue = Boolean(response.result);
    return `<span class="result-bool ${isTrue ? 'is-true' : 'is-false'}">${isTrue ? 'True' : 'False'}</span>`;
  }
  if (Array.isArray(response.latexParts) && response.latexParts.length > 1) {
    // Multiple solutions: one per line instead of crammed onto one row.
    return `<div class="result-lines">${response.latexParts
      .map((part) => `<div class="result-line">${convertLatexToMarkup(part)}</div>`)
      .join('')}</div>`;
  }
  if (response.latex) return convertLatexToMarkup(response.latex);
  if (Array.isArray(response.result)) {
    return response.result.length
      ? escapeHtml(response.result.join(', '))
      : '<span class="placeholder">(no solution found)</span>';
  }
  return escapeHtml(String(response.result));
}

function render(response) {
  outputPanel.dataset.mode = response.mode;
  const settings = getSettings();

  if (settings.displayMode === 'debug') {
    outputBadges.innerHTML =
      `<span class="badge">${escapeHtml(response.mode)}</span>` +
      (response.method ? `<span class="badge">${escapeHtml(response.method)}</span>` : '');

    let inputMathJson;
    try {
      inputMathJson = JSON.stringify(getMathJson(), null, 2);
    } catch (err) {
      inputMathJson = `couldn't read the input: ${err.message}`;
    }

    outputRender.innerHTML = `
      <div class="debug-section">
        <div class="debug-label">Input field (LaTeX)</div>
        <pre class="output-debug">${escapeHtml(mf.getValue('latex') || '(empty)')}</pre>
      </div>
      <div class="debug-section">
        <div class="debug-label">Input (MathJSON)</div>
        <pre class="output-debug">${escapeHtml(inputMathJson)}</pre>
      </div>
      <div class="debug-section">
        <div class="debug-label">Rendered result</div>
        <div class="debug-rendered">${resultMarkup(response)}</div>
      </div>
      <div class="debug-section">
        <div class="debug-label">Raw response</div>
        <pre class="output-debug">${escapeHtml(JSON.stringify(response, null, 2))}</pre>
      </div>
    `;
    return;
  }

  // User mode: just the clean result, no mode/method chrome.
  outputBadges.innerHTML = '';
  outputRender.innerHTML = resultMarkup(response);
}

async function runCompute(saveToHistory = false) {
  const latex = mf.getValue('latex');

  // Something like "1+" or "\sqrt{" parses into a valid-looking MathJSON
  // tree with an embedded ["Error", ...] node rather than throwing, so it'd
  // otherwise sail past getMathJson() and hit the backend as a garbled
  // expression it can't make sense of. Catching invalid input here, before
  // ever sending it, is what turns that into a clean "Syntax error" instead.
  let parsed;
  try {
    parsed = ce.parse(latex);
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.isValid) {
    const response = { mode: 'error', result: 'Syntax error — check your input.' };
    lastResponse = response;
    render(response);
    if (saveToHistory) addEntry(latex, summarize(response));
    return;
  }

  let mathjson;
  try {
    mathjson = getMathJson();
  } catch (err) {
    render({ mode: 'error', result: `couldn't read the input: ${err.message}` });
    return;
  }

  outputPanel.dataset.mode = 'pending';
  outputBadges.innerHTML = '';
  outputRender.innerHTML = '<span class="placeholder">Computing…</span>';

  // "a = <rhs>" is a workspace assignment — its own name is left out of the
  // constants sent along for *this* computation, otherwise substituting a's
  // old value into "a = 3" would turn the assignment into a true/false
  // check of the old value against the new one instead of solving/defining it.
  const assignment = getAssignmentParts(parsed);
  const constants = getWorkspace();
  if (assignment) delete constants[assignment.name];

  let response;
  try {
    response = await computeMathJson(mathjson, getSettings(), { constants });
  } catch (err) {
    response = { mode: 'error', result: String(err.message || err) };
  }

  lastResponse = response;
  render(response);
  if (saveToHistory) {
    addEntry(mf.getValue('latex'), summarize(response));
    if (assignment && response.mode !== 'error') {
      // Evaluated locally (not taken from the backend response) so the
      // stored value keeps full double precision regardless of the
      // current decimals/number-format display setting.
      const value = evalNumeric(assignment.rhs, getWorkspace());
      if (Number.isFinite(value)) setVar(assignment.name, value);
    }
  }
}

// There's no explicit "Compute" button — an empty field just resets to the
// idle placeholder instead of sending a request that can only error.
function runComputeIfNonEmpty(saveToHistory = false) {
  if (!mf.getValue('latex').trim()) {
    lastResponse = null;
    outputPanel.dataset.mode = 'idle';
    outputBadges.innerHTML = '';
    outputRender.innerHTML = '<span class="placeholder">Result will show up here.</span>';
    return;
  }
  runCompute(saveToHistory);
}

// Typing auto-computes (for instant feedback) but only Enter saves a
// history entry — otherwise every intermediate keystroke's result would
// get logged on its way to what you actually meant to type.
let inputRunTimer = null;
mf.addEventListener('input', () => {
  clearTimeout(inputRunTimer);
  inputRunTimer = setTimeout(() => runComputeIfNonEmpty(false), 400);
});

mf.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(inputRunTimer);
    runComputeIfNonEmpty(true);
  }
});

document.getElementById('copy-input').addEventListener('click', () => {
  const settings = getSettings();
  let text;
  try {
    text = settings.copyFormat === 'mathjson' ? JSON.stringify(getMathJson()) : mf.getValue('latex');
  } catch {
    text = mf.getValue('latex');
  }
  copyText(text);
});

document.getElementById('copy-output').addEventListener('click', () => {
  if (!lastResponse) return;
  const settings = getSettings();
  let text;
  if (settings.copyFormat === 'mathjson' && lastResponse.latex) {
    try {
      text = JSON.stringify(ce.parse(lastResponse.latex).json);
    } catch {
      text = lastResponse.latex;
    }
  } else if (lastResponse.latex) {
    text = lastResponse.latex;
  } else if (Array.isArray(lastResponse.result)) {
    text = lastResponse.result.join(', ');
  } else {
    text = String(lastResponse.result);
  }
  copyText(text);
});

// Settings panel open/close.
const settingsBackdrop = document.getElementById('settings-backdrop');
document.getElementById('settings-toggle').addEventListener('click', () => settingsBackdrop.classList.add('open'));
settingsBackdrop.addEventListener('click', (event) => {
  if (event.target === settingsBackdrop) settingsBackdrop.classList.remove('open');
});
mountSettingsPanel(document.getElementById('settings-body'));

// Hamburger dropdown (currently just "Misc") — a click-away popover, not a
// full backdrop like Settings, since it's just a couple of nav links.
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

// Front-page quick toggles for the settings people flip constantly (angle
// mode, number format, result form) without opening the settings drawer.
// Each is a single button that cycles to the next value on click and just
// states the current one, so it stays compact instead of a segmented
// control listing every option.
function wireCycleToggle(id, settingKey) {
  const button = document.getElementById(id);
  const options = CYCLE_OPTIONS[settingKey];
  button.addEventListener('click', () => {
    const index = options.findIndex((option) => option.value === getSettings()[settingKey]);
    const next = options[(index + 1) % options.length];
    updateSetting(settingKey, next.value);
  });
  return () => {
    const current = options.find((option) => option.value === getSettings()[settingKey]) || options[0];
    button.textContent = current.label;
  };
}
const syncAngleToggle = wireCycleToggle('angle-toggle', 'angleMode');
const syncNumberToggle = wireCycleToggle('number-toggle', 'numberFormat');
const syncSimplifyToggle = wireCycleToggle('simplify-toggle', 'simplifyMode');
syncAngleToggle();
syncNumberToggle();
syncSimplifyToggle();

const historyEl = document.getElementById('history');
function syncHistoryVisibility() {
  historyEl.hidden = !getSettings().showHistory;
}
syncHistoryVisibility();

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

// Settings that feed the computation itself (angle mode, number format,
// decimals) re-run the compute so the shown result always matches the
// currently selected mode; purely-cosmetic settings just re-render.
// Debounced so dragging the decimals slider doesn't fire a request per tick.
let prevSettings = getSettings();
let recomputeTimer = null;
onSettingsChange((settings) => {
  syncAngleToggle();
  syncNumberToggle();
  syncSimplifyToggle();
  syncHistoryVisibility();
  syncAppTitle();

  const changedRecomputeKey = RECOMPUTE_KEYS.some((key) => settings[key] !== prevSettings[key]);
  prevSettings = settings;

  if (changedRecomputeKey && lastResponse) {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(runCompute, 300);
  } else if (lastResponse) {
    render(lastResponse);
  }
});

mountHistory(document.getElementById('history'), (latex) => {
  mf.value = latex;
  mf.focus();
});

mountWorkspace(document.getElementById('workspace'));
