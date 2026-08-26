import './node_modules/mathlive/mathlive.min.mjs';
import { compile } from './node_modules/@cortex-js/compute-engine/dist/esm-min/compute-engine.js';
import { computeMathJson, sampleMathJson, exportPlot } from './api.js';
import { getSettings, onSettingsChange } from './settings.js';
import { ce, PARSE_CANONICAL } from './compute-engine.js';
import { getFunctions } from './workspace.js';

// Desmos-style per-expression colors, assigned round-robin as rows are added
// (and reused for the row's color-picker swatches). An 8th "custom" swatch
// (a native <input type="color">, added alongside these in the settings
// popover markup, not part of this array) rounds the picker out to 8 without
// being eligible for round-robin auto-assignment.
const PALETTE = ['#2d70b3', '#c74440', '#388c46', '#6042a6', '#fa7e19', '#2abcbc', '#e6a000'];

const LINE_RESOLUTION_DEFAULT = 300;
const SURFACE_RESOLUTION_DEFAULT = 50;
const SURFACE_RESOLUTION_CAP = 150;

// "x" and "y" are reserved as axis names: "x=4"/"y=4" draw a reference line
// (like Desmos) instead of becoming a slider constant — otherwise defining
// one would silently steal the domain variable out from under every other
// row that plots against x or y.
const AXIS_VARS = new Set(['x', 'y']);

const COLORSCALE_OPTIONS = ['Viridis', 'Plasma', 'Cividis', 'Turbo', 'Bluered', 'Greys'];

const ASPECT_MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'cube', label: 'Cube (stretch to fill)' },
  { value: 'data', label: 'Equal (true to data)' },
  { value: 'manual', label: 'Manual ratio' },
];

const LINE_STYLES = [
  { value: 'solid', label: 'Solid' },
  { value: 'dash', label: 'Dashed' },
  { value: 'dot', label: 'Dotted' },
  { value: 'dashdot', label: 'Dash-dot' },
];

const DEFAULT_DOMAIN = { min: -10, max: 10, xMin: -10, xMax: 10, yMin: -10, yMax: 10 };

// ce and PARSE_CANONICAL come from compute-engine.js — shared with app.js so
// both math-fields on the page point at the same engine instance.

// See app.js: MathLive's "dx"/"dy"/"dt" inline shortcut expands to
// "\differentialD x" etc., which compute-engine's LaTeX parser doesn't
// recognize at all. Swapping it back to a literal "d" before parsing (the
// field itself keeps showing the prettier upright d) is what keeps that
// from becoming a syntax error.
function normalizeLatex(latex) {
  return wrapLeibnizArguments(latex.replace(/\\differentialD\s*/g, 'd'));
}

// See app.js: compute-engine's LaTeX parser treats "\frac{d}{dx}" as a
// prefix operator that greedily consumes the rest of the enclosing
// additive chain instead of binding only to the single term right after
// it - both "\frac{d}{dx}\left(\sin(x)\right)+1" and the parenthesis-free
// "\frac{d}{dx}\sin(x)+2" silently parse as D(sin(x)+1, x) / D(sin(x)+2,
// x), where the trailing term then vanishes (derivative of a constant is
// 0). Wrapping just the one atom right after "d/dx" - a function call, a
// bare symbol, a power, ... - together with the "\frac{d}{dx}" itself in
// one more explicit "\left( \right)" gives the parser a boundary it does
// respect.
function findMatchingBrace(latex, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < latex.length; i++) {
    if (latex[i] === '{') depth++;
    else if (latex[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingParen(latex, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < latex.length; i++) {
    if (latex[i] === '(') depth++;
    else if (latex[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingRight(latex, leftIdx) {
  let depth = 0;
  let i = leftIdx;
  while (i < latex.length) {
    if (latex.startsWith('\\left', i)) {
      depth++;
      i += 5;
    } else if (latex.startsWith('\\right', i)) {
      depth--;
      i += 6;
      if (depth === 0) return latex[i] === '\\' ? i + 2 : i + 1;
    } else {
      i++;
    }
  }
  return -1;
}

function skipWs(latex, i) {
  while (i < latex.length && /\s/.test(latex[i])) i++;
  return i;
}

// Finds the end of the single "atom" starting at pos: an optional function
// command (\sin, \ln, \operatorname{f}, \sqrt[n]{...}, ...) followed by its
// argument group ("\left(\right)", "(...)", "{...}", or a single bare
// symbol/digit), plus a trailing "^..." exponent if present. This mirrors
// just enough of LaTeX's primary-expression grammar to find where the
// term right after "\frac{d}{dx}" ends, without needing a full parser.
function consumeAtom(latex, pos) {
  let i = skipWs(latex, pos);
  const start = i;
  const cmdMatch = /^\\[a-zA-Z]+/.exec(latex.slice(i));
  if (cmdMatch) {
    i += cmdMatch[0].length;
    if (cmdMatch[0] === '\\operatorname') {
      i = skipWs(latex, i);
      if (latex[i] === '{') i = findMatchingBrace(latex, i) + 1;
    }
    i = skipWs(latex, i);
    if (cmdMatch[0] === '\\sqrt' && latex[i] === '[') {
      const close = latex.indexOf(']', i);
      if (close !== -1) i = skipWs(latex, close + 1);
    }
  }
  i = skipWs(latex, i);
  if (latex.startsWith('\\left', i)) {
    const end = findMatchingRight(latex, i);
    if (end !== -1) i = end;
  } else if (latex[i] === '(') {
    const end = findMatchingParen(latex, i);
    if (end !== -1) i = end + 1;
  } else if (latex[i] === '{') {
    const end = findMatchingBrace(latex, i);
    if (end !== -1) i = end + 1;
  } else if (cmdMatch) {
    // bare command with no argument group, e.g. "\pi"
  } else if (/[a-zA-Z0-9]/.test(latex[i] || '')) {
    i++;
  } else {
    return start; // nothing recognizable to consume
  }
  const afterExp = skipWs(latex, i);
  if (latex[afterExp] === '^') {
    let j = skipWs(latex, afterExp + 1);
    if (latex[j] === '{') {
      const end = findMatchingBrace(latex, j);
      if (end !== -1) i = end + 1;
    } else if (latex[j] === '\\') {
      const m = /^\\[a-zA-Z]+/.exec(latex.slice(j));
      i = j + (m ? m[0].length : 1);
    } else if (j < latex.length) {
      i = j + 1;
    }
  }
  return i;
}

function wrapLeibnizArguments(latex) {
  const marker = '\\frac{d}{d';
  let result = '';
  let searchFrom = 0;
  while (true) {
    const fracStart = latex.indexOf(marker, searchFrom);
    if (fracStart === -1) {
      result += latex.slice(searchFrom);
      return result;
    }
    const denomCloseBrace = findMatchingBrace(latex, fracStart + 8);
    if (denomCloseBrace === -1) {
      result += latex.slice(searchFrom, fracStart + marker.length);
      searchFrom = fracStart + marker.length;
      continue;
    }
    const argStart = skipWs(latex, denomCloseBrace + 1);
    const argEnd = consumeAtom(latex, denomCloseBrace + 1);
    if (argEnd <= argStart) {
      result += latex.slice(searchFrom, denomCloseBrace + 1);
      searchFrom = denomCloseBrace + 1;
      continue;
    }
    result += latex.slice(searchFrom, fracStart) + '\\left(' + latex.slice(fracStart, argEnd) + '\\right)';
    searchFrom = argEnd;
  }
}

// Assigned in mount() below, once the Plot view's markup exists — module-
// scoped so every function here can close over them without its own lookup.
let exprListEl, addExprBtn, modeButtons, plotTitleEl, plotSubtitleEl,
  graphSettingsToggle, graphSettingsPanel, exportToggle, exportMenu,
  plotPanel, plotError, plotDiv, plotPlaceholder;

let mode = '2d';
let rowIdCounter = 0;
let colorIndex = 0;
let rows = [];
let currentConstants = {};
let hasPlotted = false;
// The surface grid size (settings3d.resolution, capped) most recently handed
// to Plotly for a 3D surface — see redraw()'s use of it below.
let lastSurfaceGridN = null;

const settings2d = {
  xMin: -10, xMax: 10, xScale: 'linear',
  outputAuto: true, outputMin: -10, outputMax: 10, yScale: 'linear',
  resolution: LINE_RESOLUTION_DEFAULT,
  // 1:1 pixel-to-unit scaling (Plotly's scaleanchor/scaleratio) — only
  // meaningful for two linear axes, see computeXAxis2d.
  equalAxes: false,
};
const settings3d = {
  xMin: -10, xMax: 10, yMin: -10, yMax: 10,
  outputAuto: true, outputMin: -10, outputMax: 10,
  resolution: SURFACE_RESOLUTION_DEFAULT,
  colorscale: 'solid',
  // 'data' (Plotly's default here previously) locks the box to true 1:1:1
  // real-unit proportions, which flattens any surface whose z-range is much
  // smaller than its x/y domain into a pancake. 'auto' uses those true
  // proportions only when they're not too extreme, falling back to a cube
  // otherwise — a saner default — while 'manual' hands full control to the
  // aspectX/Y/Z ratios below for anyone who wants a specific stretch.
  aspectMode: 'auto',
  aspectX: 1, aspectY: 1, aspectZ: 1,
};

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function nextColor() {
  return PALETTE[colorIndex++ % PALETTE.length];
}

function linspace(min, max, count) {
  if (count <= 1) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + i * step);
}

function formatSliderValue(value) {
  return Number(value.toFixed(4)).toString();
}

// Rounds to a fixed count of SIGNIFICANT figures (unlike toFixed's fixed
// count of decimal PLACES, which on a value like 338844.1561 keeps all 10
// digits — every one of them "real" as far as toFixed is concerned, even
// though a value computed from a slider drag has nowhere near that much
// genuine precision). Used for the axis-range displays (the zoom sliders'
// own ±W label, the range values they write into the plain number inputs,
// and the "viewing x ∈ [...]" subtitle) — not for the slider-constant
// display (formatSliderValue above), whose fixed-decimals behavior is
// unrelated and intentional.
function roundSigFigs(value, sig = 3) {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

function formatSigFigs(value, sig = 3) {
  return roundSigFigs(value, sig).toString();
}

// A pole the sample grid straddles but never lands on exactly (e.g. 1/x at
// x=0: the backend returns a real, finite y on both neighboring grid points,
// just enormous ones of opposite sign) otherwise draws as a single line
// segment connecting +inf-ish to -inf-ish straight through the middle of the
// graph — wrong, since the function was never actually there. Flagged as a
// gap whenever a step's jump is far bigger than the curve's typical local
// step AND crosses zero, which a genuine (if steep) continuous crossing
// essentially never does at normal sampling resolution. Inserting an actual
// extra null-y sample between the two (rather than nulling one of them out)
// keeps both real, legitimately-sampled points on screen — only the segment
// that would have bridged the pole is removed.
function breakAsymptotes(xs, ys) {
  const diffs = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const a = ys[i], b = ys[i + 1];
    if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
      diffs.push(Math.abs(b - a));
    }
  }
  if (diffs.length === 0) return { x: xs, y: ys };
  diffs.sort((p, q) => p - q);
  const median = diffs[Math.floor(diffs.length / 2)];
  const threshold = Math.max(median * 25, 1e-9);

  const outX = [xs[0]];
  const outY = [ys[0]];
  for (let i = 0; i < ys.length - 1; i++) {
    const a = ys[i], b = ys[i + 1];
    if (
      typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) &&
      a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b) && Math.abs(b - a) > threshold
    ) {
      outX.push((xs[i] + xs[i + 1]) / 2);
      outY.push(null);
    }
    outX.push(xs[i + 1]);
    outY.push(ys[i + 1]);
  }
  return { x: outX, y: outY };
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

function getAssignmentParts(parsed) {
  if (parsed.operator !== 'Equal') return null;
  if (typeof parsed.op1?.symbol === 'string') return { name: parsed.op1.symbol, rhs: parsed.op2 };
  if (typeof parsed.op2?.symbol === 'string') return { name: parsed.op2.symbol, rhs: parsed.op1 };
  return null;
}

// ---------- Row lifecycle ----------

function createRow(initialLatex = '') {
  const id = ++rowIdCounter;

  const el = document.createElement('div');
  el.className = 'expr-row';
  el.dataset.id = String(id);

  const dot = document.createElement('button');
  dot.type = 'button';
  dot.className = 'expr-dot';
  dot.title = 'Color & visibility';

  const body = document.createElement('div');
  body.className = 'expr-body';

  const mf = document.createElement('math-field');
  mf.className = 'expr-field';

  const badge = document.createElement('div');
  badge.className = 'expr-badge';
  badge.hidden = true;

  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'expr-slider';
  sliderWrap.hidden = true;
  sliderWrap.innerHTML = `
    <input type="number" class="slider-min" step="any">
    <input type="range" class="slider-range" step="0.01">
    <input type="number" class="slider-max" step="any">
  `;

  body.append(mf, badge, sliderWrap);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'expr-delete';
  del.title = 'Delete expression';
  del.setAttribute('aria-label', 'Delete expression');
  del.textContent = '×';

  el.append(dot, body, del);

  const row = {
    id, el, mf, dot, badge, sliderWrap,
    minInput: sliderWrap.querySelector('.slider-min'),
    rangeInput: sliderWrap.querySelector('.slider-range'),
    maxInput: sliderWrap.querySelector('.slider-max'),
    visible: true,
    color: nextColor(),
    kind: 'empty',
    lineStyle: 'solid',
    domain: { ...DEFAULT_DOMAIN },
    // Whether "Plotted over ..." has ever been hand-edited in this row's own
    // settings popover — see syncTrackedDomains below.
    domainCustomized: false,
  };

  mf.addEventListener('input', () => scheduleClassifyAndRedraw());
  mf.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      focusNextRow(row);
    }
  });
  dot.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleRowSettingsPopover(row);
  });
  del.addEventListener('click', () => deleteRow(row));
  row.rangeInput.addEventListener('input', () => onSliderInput(row));
  row.minInput.addEventListener('change', () => onSliderBoundChange(row));
  row.maxInput.addEventListener('change', () => onSliderBoundChange(row));

  rows.push(row);
  exprListEl.appendChild(el);
  mf.menuItems = [];
  if (initialLatex) mf.value = initialLatex;

  return row;
}

function deleteRow(row) {
  rows = rows.filter((r) => r !== row);
  row.el.remove();
  if (rows.length === 0) createRow('');
  classifyAndRedraw();
}

function focusNextRow(row) {
  const index = rows.indexOf(row);
  const next = rows[index + 1];
  if (next) next.mf.focus();
}

// ---------- Per-row settings popover: color, visibility, line style, domain ----------

function ensureRowSettingsPopover(row) {
  if (row.settingsPopover) return row.settingsPopover;
  const pop = document.createElement('div');
  pop.className = 'expr-settings-popover';
  pop.hidden = true;

  pop.addEventListener('click', (event) => {
    event.stopPropagation();
    // The custom-color swatch is a native <input type="color">: clicking it
    // just opens the OS picker (its own 'input'/'change' events below carry
    // the actual chosen value), so it's excluded from the fixed-palette
    // click-to-select handling here.
    const swatch = event.target.closest('.expr-color-swatch:not(.expr-color-custom)');
    if (swatch) {
      row.color = swatch.dataset.color;
      syncRowVisual(row);
      renderRowSettingsPopover(row);
      redraw();
      return;
    }
    if (event.target.dataset.action === 'toggle-visibility') {
      row.visible = !row.visible;
      syncRowVisual(row);
      renderRowSettingsPopover(row);
      redraw();
    }
  });

  pop.addEventListener('input', (event) => {
    const el = event.target;
    if (el.classList.contains('expr-color-custom')) {
      row.color = el.value;
      syncRowVisual(row);
      redraw();
      return;
    }
    if (el.dataset.action !== 'resolution') return;
    // Resolution is a per-mode setting, not per-row — this slider is just a
    // more convenient place to reach the same settings2d/settings3d value
    // the graph-settings drawer exposes, so both stay in sync live.
    const s = mode === '2d' ? settings2d : settings3d;
    s.resolution = parseInt(el.value, 10);
    const labelText = mode === '2d' ? `${s.resolution} points` : `${s.resolution} × ${s.resolution} grid`;
    const popLabel = pop.querySelector('[data-resolution-value]');
    if (popLabel) popLabel.textContent = labelText;
    const panelLabel = graphSettingsPanel?.querySelector('[data-resolution-value]');
    if (panelLabel) panelLabel.textContent = labelText;
    const panelSlider = graphSettingsPanel?.querySelector('[data-field=resolution]');
    if (panelSlider) panelSlider.value = String(s.resolution);
    debouncedRedraw();
  });

  pop.addEventListener('change', (event) => {
    const action = event.target.dataset.action;
    if (action === 'line-style') {
      row.lineStyle = event.target.value;
      redraw();
      return;
    }
    if (!action || !action.startsWith('domain-')) return;
    const value = parseFloat(event.target.value);
    if (!Number.isFinite(value)) return;
    const field = action.slice('domain-'.length);
    row.domain[field] = value;
    // A hand-edited domain is a deliberate override — from here on this row
    // stops tracking the shared axis view (see syncTrackedDomains).
    row.domainCustomized = true;
    redraw();
  });

  row.el.appendChild(pop);
  row.settingsPopover = pop;
  return pop;
}

// The popover's contents depend on the row's current shape (function vs.
// reference line vs. surface), so it's rebuilt on open/update rather than
// kept static; the listeners above are delegated on the popover itself so
// they survive the innerHTML replacement.
function renderRowSettingsPopover(row) {
  const pop = row.settingsPopover;
  if (!pop) return;

  const isLine = row.plotType === 'vline' || row.plotType === 'hline';
  const showLineStyle = row.kind === 'plot' && row.dim === 1;
  const showDomain = row.kind === 'plot' && !isLine;
  const is3dSurface = row.dim === 2;
  const domainVarLabel = row.vars && row.vars[0] ? row.vars[0] : 'x';
  const s = mode === '2d' ? settings2d : settings3d;
  const resMin = mode === '2d' ? 20 : 10;
  const resMax = mode === '2d' ? 800 : 150;
  const resStep = mode === '2d' ? 10 : 5;
  const resLabel = mode === '2d' ? `${s.resolution} points` : `${s.resolution} × ${s.resolution} grid`;

  pop.innerHTML = `
    <div class="expr-settings-section">
      <div class="expr-color-swatches">
        ${PALETTE.map((c) => `<button type="button" class="expr-color-swatch" data-color="${c}" style="background:${c}"></button>`).join('')}
        <input type="color" class="expr-color-swatch expr-color-custom" value="${row.color}" title="Custom color">
      </div>
      <button type="button" class="expr-color-popover-toggle" data-action="toggle-visibility"></button>
    </div>
    <div class="expr-settings-section">
      <label class="expr-settings-label">Number of points: <span data-resolution-value>${resLabel}</span></label>
      <input type="range" data-action="resolution" min="${resMin}" max="${resMax}" step="${resStep}" value="${s.resolution}">
    </div>
    ${showLineStyle ? `
      <div class="expr-settings-section">
        <label class="expr-settings-label">Line style</label>
        <select data-action="line-style">
          ${LINE_STYLES.map((o) => `<option value="${o.value}" ${row.lineStyle === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
    ` : ''}
    ${showDomain ? (is3dSurface ? `
      <div class="expr-settings-section">
        <label class="expr-settings-label">Plotted over x ∈</label>
        <div class="plot-range-inputs">
          <input type="number" data-action="domain-xMin" value="${row.domain.xMin}">
          <input type="number" data-action="domain-xMax" value="${row.domain.xMax}">
        </div>
      </div>
      <div class="expr-settings-section">
        <label class="expr-settings-label">and y ∈</label>
        <div class="plot-range-inputs">
          <input type="number" data-action="domain-yMin" value="${row.domain.yMin}">
          <input type="number" data-action="domain-yMax" value="${row.domain.yMax}">
        </div>
      </div>
    ` : `
      <div class="expr-settings-section">
        <label class="expr-settings-label">Plotted over ${domainVarLabel} ∈</label>
        <div class="plot-range-inputs">
          <input type="number" data-action="domain-min" value="${row.domain.min}">
          <input type="number" data-action="domain-max" value="${row.domain.max}">
        </div>
      </div>
    `) : ''}
  `;

  pop.querySelectorAll('.expr-color-swatch').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.color === row.color);
  });
  const toggleBtn = pop.querySelector('[data-action=toggle-visibility]');
  if (toggleBtn) toggleBtn.textContent = row.visible ? 'Hide' : 'Show';
}

function closeAllRowSettingsPopovers() {
  for (const row of rows) {
    if (row.settingsPopover) row.settingsPopover.hidden = true;
  }
}

function toggleRowSettingsPopover(row) {
  if (row.kind !== 'plot') return;
  const pop = ensureRowSettingsPopover(row);
  const willOpen = pop.hidden;
  closeAllRowSettingsPopovers();
  if (willOpen) {
    renderRowSettingsPopover(row);
    pop.hidden = false;
  }
}

// ---------- Implicit-equation solving (via the Python/sympy backend) ----------
// The client-side compiler can only plot "y = f(x)"-shaped rows. Something
// like "x^2+y^2=25" needs an actual symbolic solve to invert, which the
// backend already does (POST /api/compute with a solve_for hint) — this
// hands it off there instead of just rejecting the row.

function applyImplicitCacheToRow(row, target, domainVar) {
  const cache = row._implicitCache;
  if (!cache) return;
  if (cache.state === 'done') {
    row.kind = 'plot';
    row.dim = 1;
    row.vars = [domainVar];
    row.branches = cache.branches;
    row.label = target;
    row.plotType = 'implicit';
  } else if (cache.state === 'error') {
    row.kind = 'error';
    row.errorMessage = cache.message;
  } else {
    row.kind = 'solving';
  }
}

async function fetchImplicitSolve(row, cacheKey, target, domainVar, constantValues) {
  const isStale = () => row._implicitCache?.key !== cacheKey;

  let mathjson;
  try {
    mathjson = ce.parse(normalizeLatex(row.mf.getValue('latex')), { canonical: PARSE_CANONICAL }).json;
  } catch (err) {
    if (isStale()) return;
    row._implicitCache = { key: cacheKey, state: 'error', message: `Couldn't read this expression: ${err.message || err}` };
    applyImplicitCacheToRow(row, target, domainVar);
    renderRowChrome();
    redraw();
    return;
  }

  let response;
  try {
    response = await computeMathJson(mathjson, getSettings(), { solve_for: target });
  } catch (err) {
    if (isStale()) return;
    row._implicitCache = {
      key: cacheKey, state: 'error',
      message: `Couldn't reach the compute backend to solve this — is the Flask server running on :5000? (${err.message || err})`,
    };
    applyImplicitCacheToRow(row, target, domainVar);
    renderRowChrome();
    redraw();
    return;
  }
  if (isStale()) return;

  if (response.mode === 'error' || response.mode === 'coming_soon') {
    row._implicitCache = { key: cacheKey, state: 'error', message: String(response.result) };
    applyImplicitCacheToRow(row, target, domainVar);
    renderRowChrome();
    redraw();
    return;
  }

  const branchLatexes = Array.isArray(response.latexParts) && response.latexParts.length
    ? response.latexParts
    : (response.latex ? [response.latex] : []);

  const branches = [];
  for (const branchLatex of branchLatexes) {
    // Backend returns "<name> = <expr>" per branch; only the expr matters.
    const rhsLatex = branchLatex.includes('=') ? branchLatex.slice(branchLatex.indexOf('=') + 1) : branchLatex;
    try {
      const branchExpr = ce.parse(rhsLatex, { canonical: PARSE_CANONICAL });
      const branchVars = [...new Set(branchExpr.unknowns)].filter((v) => !(v in constantValues));
      if (branchVars.length !== 1) continue; // shouldn't happen; skip rather than crash the row
      branches.push({ vars: branchVars, mathjson: branchExpr.json });
    } catch {
      // skip a malformed branch
    }
  }

  row._implicitCache = branches.length
    ? { key: cacheKey, state: 'done', branches }
    : { key: cacheKey, state: 'error', message: "Solved this, but couldn't turn the result back into a plottable curve." };
  applyImplicitCacheToRow(row, target, domainVar);
  renderRowChrome();
  redraw();
}

function applyImplicitRow(row, symbols, constantValues) {
  if (symbols.length < 2) {
    row.kind = 'error';
    row.errorMessage = symbols.length === 0
      ? "Couldn't resolve this equation to a value."
      : `Found only one variable (${symbols[0]}) in an equation — did you mean "${symbols[0]} = ..."?`;
    return;
  }
  if (symbols.length > 2) {
    row.kind = 'error';
    row.errorMessage = `Found ${symbols.length} variables (${symbols.join(', ')}) — only 1 or 2 are supported.`;
    return;
  }

  const target = symbols.includes('y') ? 'y' : symbols[symbols.length - 1];
  const domainVar = symbols.find((v) => v !== target);
  const cacheKey = `${row.latex}::${target}`;

  // classifyRows() reruns on every edit anywhere in the list, so a row
  // that's already solved (or already solving) for this exact text just
  // reapplies its cached result instead of re-hitting the backend.
  if (row._implicitCache?.key === cacheKey) {
    applyImplicitCacheToRow(row, target, domainVar);
    return;
  }

  row._implicitCache = { key: cacheKey, state: 'solving' };
  row.kind = 'solving';
  fetchImplicitSolve(row, cacheKey, target, domainVar, constantValues);
}

// ---------- Classification: figures out plot vs. constant vs. axis-line per row ----------

function classifyRows() {
  for (const row of rows) {
    const latex = row.mf.getValue('latex').trim();
    row.latex = latex;
    if (!latex) {
      row.kind = 'empty';
      row.parsed = null;
      row.assignmentParts = null;
      continue;
    }
    let parsed = null;
    try {
      parsed = ce.parse(normalizeLatex(latex), { canonical: PARSE_CANONICAL });
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.isValid) {
      row.kind = 'error';
      row.errorMessage = "Couldn't parse this.";
      row.parsed = null;
      continue;
    }
    row.parsed = parsed;
    row.assignmentParts = getAssignmentParts(parsed);
    row.kind = 'pending';
  }

  // Resolve constants and axis-reference lines ("c = 2", "x = 4"), iterating
  // so one constant can reference another (e.g. "d = c * 2") regardless of
  // row order.
  const constantValues = {};
  const pending = new Set(rows.filter((r) => r.kind === 'pending' && r.assignmentParts));
  for (let pass = 0; pass < 6 && pending.size; pass++) {
    let progressed = false;
    for (const row of pending) {
      const { name, rhs } = row.assignmentParts;
      const remaining = rhs.unknowns.filter((v) => !(v in constantValues));
      if (remaining.length !== 0) continue;
      const value = evalNumeric(rhs, constantValues);
      if (!Number.isFinite(value)) continue;
      if (AXIS_VARS.has(name)) {
        row.kind = 'plot';
        row.dim = 1;
        row.vars = [];
        row.plotType = name === 'x' ? 'vline' : 'hline';
        row.lineValue = value;
      } else {
        constantValues[name] = value;
        row.kind = 'constant';
        row.name = name;
        row.value = value;
      }
      pending.delete(row);
      progressed = true;
    }
    if (!progressed) break;
  }

  // Whatever's left is a bare function, an assignment whose RHS still has a
  // real free variable (e.g. "y = x^2"), or a genuine implicit equation.
  for (const row of rows) {
    if (row.kind !== 'pending') continue;

    if (row.parsed.operator === 'Equal' && !row.assignmentParts) {
      const symbols = [...new Set(row.parsed.unknowns)].filter((v) => !(v in constantValues)).sort();
      applyImplicitRow(row, symbols, constantValues);
      continue;
    }

    const exprForPlot = row.assignmentParts ? row.assignmentParts.rhs : row.parsed;
    row.label = row.assignmentParts ? row.assignmentParts.name : null;
    const vars = [...new Set(exprForPlot.unknowns)].filter((v) => !(v in constantValues)).sort();
    if (vars.length === 0) {
      row.kind = 'error';
      row.errorMessage = row.assignmentParts ? "Couldn't resolve this value." : 'No variable to plot against.';
      continue;
    }
    if (vars.length > 2) {
      row.kind = 'error';
      row.errorMessage = `Found ${vars.length} variables (${vars.join(', ')}) — only 1 or 2 are supported.`;
      continue;
    }
    try {
      row.mathjsonExpr = exprForPlot.json;
      row.kind = 'plot';
      row.dim = vars.length;
      row.vars = vars;
      row.plotType = 'function';
      row.branches = null;
    } catch (err) {
      row.kind = 'error';
      row.errorMessage = String(err.message || err);
    }
  }

  currentConstants = constantValues;
}

// A dim-2 row (a real function of x and y) only makes sense as a surface,
// so it's 3D-only. A dim-1 row is native to 2D, but — unless it's a
// reference line (x=4/y=4) or a multi-branch implicit solve — it's also a
// perfectly good (flat) surface in 3D: "y = x" extends into the plane
// z = x, constant across y. Only "x"/"y" named variables can map onto the
// 3D domain axes, so anything plotted against another letter stays 2D-only.
function rowWorksInMode(row, m) {
  if (row.kind !== 'plot') return false;
  if (row.dim === 2) return m === '3d';
  if (m === '2d') return true;
  return (row.plotType === 'function' || row.plotType === 'implicit') && (row.vars[0] === 'x' || row.vars[0] === 'y');
}

function renderRowChrome() {
  for (const row of rows) {
    const showSlider = row.kind === 'constant';
    row.sliderWrap.hidden = !showSlider;
    if (showSlider) {
      if (row.sliderMin === undefined || row.sliderMax === undefined) {
        row.sliderMin = Math.min(-10, row.value - 5);
        row.sliderMax = Math.max(10, row.value + 5);
      }
      row.minInput.value = formatSliderValue(row.sliderMin);
      row.maxInput.value = formatSliderValue(row.sliderMax);
      row.rangeInput.min = String(row.sliderMin);
      row.rangeInput.max = String(row.sliderMax);
      row.rangeInput.step = String((row.sliderMax - row.sliderMin) / 500 || 0.01);
      if (document.activeElement !== row.rangeInput) row.rangeInput.value = String(row.value);
    }

    row.badge.hidden = true;
    row.badge.className = 'expr-badge';
    row.el.classList.remove('is-off-mode');
    if (row.kind === 'error') {
      row.badge.hidden = false;
      row.badge.classList.add('is-error');
      row.badge.textContent = row.errorMessage;
    } else if (row.kind === 'solving') {
      row.badge.hidden = false;
      row.badge.classList.add('is-dim');
      row.badge.textContent = 'Solving…';
    } else if (row.kind === 'plot') {
      const sampleError = rowSampleError(row);
      row.badge.hidden = false;
      if (sampleError) {
        row.badge.classList.add('is-error');
        row.badge.textContent = sampleError;
      } else {
        row.badge.classList.add('is-dim');
        row.badge.textContent = row.dim === 1 && rowWorksInMode(row, '3d') ? '2D + 3D' : (row.dim === 1 ? '2D' : '3D');
        const isActive = rowWorksInMode(row, mode);
        row.badge.classList.toggle('is-inactive', !isActive);
        row.el.classList.toggle('is-off-mode', !isActive);
      }
    }

    syncRowVisual(row);
    if (row.settingsPopover && !row.settingsPopover.hidden) renderRowSettingsPopover(row);
  }
}

function syncRowVisual(row) {
  const isPlot = row.kind === 'plot';
  row.dot.disabled = !isPlot;
  row.dot.style.setProperty('--dot-color', isPlot ? row.color : 'transparent');
  row.dot.classList.toggle('is-hidden', isPlot && !row.visible);
  row.dot.classList.toggle('is-inert', !isPlot);
}

function maybeAppendTrailingEmptyRow() {
  const last = rows[rows.length - 1];
  if (last && last.kind !== 'empty') createRow('');
}

function classifyAndRedraw() {
  classifyRows();
  renderRowChrome();
  maybeAppendTrailingEmptyRow();
  redraw();
}

const scheduleClassifyAndRedraw = debounce(classifyAndRedraw, 200);

// ---------- Slider dragging (live cross-expression updates) ----------

let sliderTextRaf = null;
// Every curve depending on this constant now needs a fresh backend sample,
// so a raw drag (which fires on every pointer-move tick) would flood it
// with requests — throttled here while the slider label itself still
// updates instantly via rAF above, so dragging still feels responsive.
const throttledSliderRedraw = debounce(redraw, 90);

function onSliderInput(row) {
  const value = parseFloat(row.rangeInput.value);
  if (!Number.isFinite(value)) return;
  row.value = value;
  currentConstants[row.name] = value;
  if (sliderTextRaf) cancelAnimationFrame(sliderTextRaf);
  sliderTextRaf = requestAnimationFrame(() => {
    row.mf.value = `${row.name}=${formatSliderValue(value)}`;
  });
  throttledSliderRedraw();
}

function onSliderBoundChange(row) {
  const min = parseFloat(row.minInput.value);
  const max = parseFloat(row.maxInput.value);
  if (Number.isFinite(min)) row.sliderMin = min;
  if (Number.isFinite(max)) row.sliderMax = max;
  if (row.sliderMin >= row.sliderMax) row.sliderMax = row.sliderMin + 1;
  renderRowChrome();
  redraw();
}

// ---------- Rendering ----------

function themeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    text: style.getPropertyValue('--text').trim(),
    textDim: style.getPropertyValue('--text-dim').trim(),
    border: style.getPropertyValue('--border').trim(),
  };
}

// Theme colors as a fragment to spread INTO each axis object (never as a
// standalone xaxis/yaxis of its own) — Object.assign-ing a bare {xaxis:...}
// patch over an already-built layout clobbers range/autorange/type instead
// of blending with them, since it replaces the whole key rather than merging.
function axisTheme() {
  const colors = themeColors();
  return { gridcolor: colors.border, zerolinecolor: colors.border, color: colors.textDim };
}

function chromeTheme() {
  const colors = themeColors();
  return {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: colors.text },
    margin: { t: 20, r: 20, b: 40, l: 50 },
    showlegend: false,
  };
}

function rowCurves(row) {
  if (row.branches) return row.branches;
  return [{ vars: row.vars, mathjson: row.mathjsonExpr }];
}

// ---------- Numeric sampling (via the Python/sympy+numpy backend) ----------
// The actual function evaluation for every curve/surface happens server
// side; the browser only ever sees back plain {x,y} / {x,y,z} arrays to
// hand to Plotly. Each row keeps a small cache of its last few sampled
// curves, keyed by everything that can change the result (expression,
// domain, resolution, slider constants, angle mode), so a redraw that
// hasn't actually changed anything for a given curve doesn't refetch it.

function sampleCacheKey(kind, mathjson, params) {
  return JSON.stringify({ kind, mathjson, params, angleMode: getSettings().angleMode });
}

// Returns the freshest data available for this exact request right now —
// either the just-finished fetch, or (while a new one is in flight) the
// previous result, so the plot doesn't flash empty on every keystroke or
// slider tick. Returns null only the very first time a curve is sampled.
function getOrFetchSample(row, slot, kind, mathjson, params) {
  const key = sampleCacheKey(kind, mathjson, params);
  const cache = row._sampleCache || (row._sampleCache = {});
  const entry = cache[slot];
  if (entry && entry.key === key) return entry.state === 'done' ? entry.data : (entry.previous || null);

  const previous = entry && (entry.state === 'done' ? entry.data : entry.previous);
  cache[slot] = { key, state: 'loading', previous };
  fetchSample(row, slot, key, kind, mathjson, params);
  return previous || null;
}

async function fetchSample(row, slot, key, kind, mathjson, params) {
  const isStale = () => row._sampleCache?.[slot]?.key !== key;
  let data;
  try {
    data = await sampleMathJson(mathjson, getSettings(), { kind, ...params });
  } catch (err) {
    if (isStale()) return;
    row._sampleCache[slot] = {
      key, state: 'error',
      message: `Couldn't reach the compute backend to plot this — is the Flask server running on :5000? (${err.message || err})`,
    };
    renderRowChrome();
    redraw();
    return;
  }
  if (isStale()) return;
  row._sampleCache[slot] = { key, state: 'done', data };
  redraw();
}

// Any curve on this row whose latest sample fetch errored out (e.g. the
// backend is unreachable), for surfacing in the row's badge.
function rowSampleError(row) {
  const cache = row._sampleCache;
  if (!cache) return null;
  const failed = Object.values(cache).find((entry) => entry.state === 'error');
  return failed ? failed.message : null;
}

// The lower bound a log-scaled axis samples/renders from, when the
// configured min is itself invalid for log (<= 0): falls back to a few
// decades below the max instead of refusing to render.
function logLowerBound(min, max) {
  return min > 0 ? min : max / 1e4;
}

function build2dTraces(activeRows, s) {
  const traces = [];
  for (const row of activeRows) {
    if (row.plotType === 'vline' || row.plotType === 'hline') continue; // drawn as shapes below
    const curves = rowCurves(row);
    curves.forEach((curve, i) => {
      // Sampled from the ROW's own "plotted over" domain (set per-expression
      // in its settings popover), not the shared axis view range — a row can
      // be zoomed out past, or restricted narrower than, what's visible.
      const params = { var: curve.vars[0], domain: row.domain, resolution: s.resolution, scale: s.xScale, constants: currentConstants, functions: getFunctions() };
      const data = getOrFetchSample(row, `2d:${i}`, 'curve', curve.mathjson, params);
      if (!data) return; // nothing sampled yet for this curve — skip this redraw, another is on the way

      // A log y-axis can't place zero/negative values — null them out so
      // Plotly treats them as gaps instead of letting them (or their
      // near-zero neighbors) drag the auto-range down into a mostly-dead
      // multi-decade tail.
      const y = s.yScale === 'log' ? data.y.map((v) => (v > 0 ? v : null)) : data.y;
      const gapped = breakAsymptotes(data.x, y);

      traces.push({
        x: gapped.x,
        y: gapped.y,
        type: 'scatter',
        mode: 'lines',
        line: { color: row.color, width: 2.5, dash: row.lineStyle === 'solid' ? undefined : row.lineStyle },
        name: row.label ? `${row.label}(${curve.vars[0]})${curves.length > 1 ? ` #${i + 1}` : ''}` : row.latex,
      });
    });
  }
  return traces;
}

function build2dShapes(activeRows) {
  return activeRows
    .filter((row) => row.plotType === 'vline' || row.plotType === 'hline')
    .map((row) => (row.plotType === 'vline'
      ? { type: 'line', x0: row.lineValue, x1: row.lineValue, y0: 0, y1: 1, yref: 'paper', line: { color: row.color, width: 2.5 } }
      : { type: 'line', y0: row.lineValue, y1: row.lineValue, x0: 0, x1: 1, xref: 'paper', line: { color: row.color, width: 2.5 } }));
}

function build3dTraces(activeRows, s) {
  const n = Math.max(Math.min(s.resolution, SURFACE_RESOLUTION_CAP), 2);
  const opacity = activeRows.length > 1 ? 0.78 : 1;
  const useGradient = s.colorscale !== 'solid';
  const traces = [];

  for (const row of activeRows) {
    // A dim-2 row samples its own x/y domain (its settings popover exposes
    // both) as a true surface from the backend. A dim-1 row extended into 3D
    // (see rowWorksInMode) only has one variable's domain of its own — it's
    // sampled as a plain 1D curve from the backend, then tiled across the
    // OTHER axis (the current 3D view range) client-side, since that's just
    // repeating an already-computed row/column, not new math.
    if (row.dim === 2) {
      const params = {
        vars: row.vars,
        domainX: { min: row.domain.xMin, max: row.domain.xMax },
        domainY: { min: row.domain.yMin, max: row.domain.yMax },
        resolution: n,
        constants: currentConstants,
        functions: getFunctions(),
      };
      const data = getOrFetchSample(row, 'surface', 'surface', row.mathjsonExpr, params);
      if (!data || !data.z.some((zRow) => zRow.some((v) => v !== null))) continue;
      traces.push({
        x: data.x, y: data.y, z: data.z,
        type: 'surface',
        colorscale: useGradient ? s.colorscale : [[0, row.color], [1, row.color]],
        showscale: useGradient && traces.length === 0,
        opacity,
        name: row.label || row.latex,
      });
      continue;
    }

    rowCurves(row).forEach((curve, i) => {
      const alongX = curve.vars[0] === 'x';
      const params = { var: curve.vars[0], domain: row.domain, resolution: n, scale: 'linear', constants: currentConstants, functions: getFunctions() };
      const data = getOrFetchSample(row, `3d:${i}`, 'curve', curve.mathjson, params);
      if (!data) return;

      const xs = alongX ? data.x : linspace(s.xMin, s.xMax, n);
      const ys = alongX ? linspace(s.yMin, s.yMax, n) : data.x;
      const z = alongX ? ys.map(() => data.y) : data.y.map((v) => xs.map(() => v));
      // Plotly's WebGL surface renderer can throw an opaque internal error
      // on a fully-NaN buffer (no finite values to build a color scale
      // from) — skip a degenerate trace instead of handing it that.
      if (!z.some((zRow) => zRow.some((v) => v !== null))) return;

      traces.push({
        x: xs, y: ys, z,
        type: 'surface',
        colorscale: useGradient ? s.colorscale : [[0, row.color], [1, row.color]],
        showscale: useGradient && traces.length === 0,
        opacity,
        name: row.label || row.latex,
      });
    });
  }
  return traces;
}

function updateSubtitle(activeRows) {
  plotTitleEl.textContent = mode === '2d' ? '2D Graph' : '3D Graph';
  if (activeRows.length === 0) {
    plotSubtitleEl.textContent = mode === '2d' ? 'No 2D functions yet' : 'No 3D surfaces yet';
    return;
  }
  const s = mode === '2d' ? settings2d : settings3d;
  const noun = mode === '2d'
    ? (activeRows.length === 1 ? 'expression' : 'expressions')
    : (activeRows.length === 1 ? 'surface' : 'surfaces');
  // Each expression samples its own domain now (set per-row), so the
  // subtitle describes the shared axis view instead of a shared domain.
  plotSubtitleEl.textContent = mode === '2d'
    ? `Plotting ${activeRows.length} ${noun} — viewing x ∈ [${formatSigFigs(s.xMin)}, ${formatSigFigs(s.xMax)}]`
    : `Plotting ${activeRows.length} ${noun} — viewing x ∈ [${formatSigFigs(s.xMin)}, ${formatSigFigs(s.xMax)}], y ∈ [${formatSigFigs(s.yMin)}, ${formatSigFigs(s.yMax)}]`;
}

// log10-space X range for a Plotly log axis (its `range` is always in log10
// units regardless of the underlying data's units).
function computeXAxis2d(s, at) {
  if (s.xScale !== 'log' || s.xMax <= 0) {
    // scaleanchor/scaleratio only make sense between two linear axes — a
    // log axis has no fixed unit-per-pixel to match, so equalAxes is a
    // no-op whenever either scale is log (checked here and, for y, in
    // computeYAxis2d never setting it in the first place).
    const equal = s.equalAxes && s.yScale !== 'log';
    return {
      ...at, title: 'x', range: [s.xMin, s.xMax], type: 'linear',
      ...(equal ? { scaleanchor: 'y', scaleratio: 1 } : {}),
    };
  }
  const lo = logLowerBound(s.xMin, s.xMax);
  return { ...at, title: 'x', range: [Math.log10(lo), Math.log10(s.xMax)], type: 'log' };
}

// A well-behaved function that dips toward zero (e.g. x^2 near its vertex)
// has sample values spanning many decades once log-scaled, and Plotly's own
// log autorange happily stretches to cover all of them — burying the
// visually-interesting part in a mostly-dead multi-decade tail near the
// bottom. Clamping the auto range to a bounded number of decades below the
// max keeps the visible window meaningful.
function computeLogAutoRange(traces) {
  let max = -Infinity;
  let min = Infinity;
  for (const t of traces) {
    for (const v of t.y) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
  }
  if (!Number.isFinite(max)) return null;
  const clampedMin = Math.max(min, max / 1e4);
  return [Math.log10(clampedMin) - 0.15, Math.log10(max) + 0.15];
}

// The linear-scale sibling of computeLogAutoRange: a pole sampled
// arbitrarily close to (but never exactly at) its asymptote produces one or
// two enormous y values — plain Plotly autorange stretches the whole view to
// fit them, squashing the actually-interesting part near y=0 down to a
// sliver and (together with breakAsymptotes' gap) is what made the "hole"
// invisible in practice: the two steep branches on either side still reached
// almost to the top/bottom of frame regardless. Clamps to a few multiples of
// the 95th-percentile |y| only when the data's actual spread is well beyond
// that — several times wider than typical — since that gap is exactly what
// marks "one single outlier spike," not a genuinely tall but ordinary curve;
// returns null for anything else so those keep Plotly's normal tight
// autorange fit.
function computeLinearAutoRange(traces) {
  const values = [];
  for (const t of traces) {
    for (const v of t.y) {
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
    }
  }
  if (values.length === 0) return null;
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  const trueMax = Math.max(...values);
  const trueMin = Math.min(...values);
  const p95 = abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))];
  const cap = Math.max(p95 * 3, 1e-9);
  if (trueMax === trueMin || trueMax - trueMin <= cap * 2.5) return null;
  const hi = Math.min(trueMax, cap);
  const lo = Math.max(trueMin, -cap);
  const pad = (hi - lo) * 0.08 || cap * 0.08;
  return [lo - pad, hi + pad];
}

function computeYAxis2d(s, at, traces) {
  if (s.yScale !== 'log') {
    if (!s.outputAuto) {
      return { ...at, title: 'y', autorange: false, range: [s.outputMin, s.outputMax], type: 'linear' };
    }
    const clamped = computeLinearAutoRange(traces);
    return clamped
      ? { ...at, title: 'y', autorange: false, range: clamped, type: 'linear' }
      : { ...at, title: 'y', autorange: true, type: 'linear' };
  }
  if (!s.outputAuto) {
    const hi = s.outputMax > 0 ? s.outputMax : 1;
    const lo = logLowerBound(s.outputMin, hi);
    return { ...at, title: 'y', autorange: false, range: [Math.log10(lo), Math.log10(hi)], type: 'log' };
  }
  const clamped = computeLogAutoRange(traces);
  return clamped
    ? { ...at, title: 'y', autorange: false, range: clamped, type: 'log' }
    : { ...at, title: 'y', autorange: true, type: 'log' };
}

const PLOTLY_CONFIG = { responsive: true, displayModeBar: false, scrollZoom: true };

// The SPA shell keeps this module (and its debounce timers, onSettingsChange
// callback, and backend-fetch .then() handlers below) alive and listening
// even while the Plot view is hidden behind Compute/Help/Misc — none of
// those trigger sources are worth individually gating, since they all
// eventually funnel into this one function. Gating redraw() itself here
// covers all of them in one place: no wasted Plotly/WebGL work happens
// while hidden, and shell.js's setActive(true) (below) flushes whatever
// would have redrawn once the view is visible again.
// Named viewActive rather than isActive to avoid colliding with the
// unrelated local `isActive` inside renderRowChrome() below (per-row
// mode-relevance, not view visibility).
let viewActive = false;
let redrawPending = false;

// A row's "plotted over" domain is intentionally decoupled from the shared
// axis view (see build2dTraces's comment) so it's possible to view a wider
// window than what's actually plotted, or restrict a function to a
// sub-domain — but that flexibility made the X/Y zoom sliders feel inert for
// the common case of an untouched row: zooming out just revealed more of a
// domain the row was never sampled over, leaving its curve confined to a
// tiny sliver near the middle. A row that's never had its domain hand-edited
// (row.domainCustomized, set in the settings popover's domain-* handler
// above) tracks the current view instead, so the default case is that
// dragging a zoom slider actually resamples the curve wider/narrower to
// match, while a row someone has deliberately restricted keeps that
// override regardless of how far the view zooms.
function syncTrackedDomains() {
  for (const row of rows) {
    if (row.kind !== 'plot' || row.domainCustomized) continue;
    if (row.dim === 2) {
      row.domain.xMin = settings3d.xMin;
      row.domain.xMax = settings3d.xMax;
      row.domain.yMin = settings3d.yMin;
      row.domain.yMax = settings3d.yMax;
      continue;
    }
    const s = mode === '2d' ? settings2d : settings3d;
    if (mode === '3d' && row.vars && row.vars[0] === 'y') {
      row.domain.min = settings3d.yMin;
      row.domain.max = settings3d.yMax;
    } else {
      row.domain.min = s.xMin;
      row.domain.max = s.xMax;
    }
  }
}

function redraw() {
  if (!viewActive) { redrawPending = true; return; }
  redrawPending = false;
  syncTrackedDomains();
  const modeRows = rows.filter((r) => rowWorksInMode(r, mode));
  const activeRows = modeRows.filter((r) => r.visible);
  updateSubtitle(activeRows);

  if (activeRows.length === 0) {
    if (hasPlotted) Plotly.purge(plotDiv);
    hasPlotted = false;
    lastSurfaceGridN = null;
    plotDiv.hidden = true;
    plotError.hidden = true;
    const anyPlots = rows.some((r) => r.kind === 'plot');
    plotPlaceholder.hidden = false;
    plotPlaceholder.textContent = modeRows.length > 0
      ? 'Every expression here is hidden — click its dot to show it.'
      : (anyPlots
        ? `Nothing to show in ${mode.toUpperCase()} — switch modes, or add a ${mode === '2d' ? '1' : '2'}-variable expression.`
        : 'Add an expression on the left to get started.');
    return;
  }

  let traces, layout;
  try {
    const s = mode === '2d' ? settings2d : settings3d;
    const at = axisTheme();
    traces = mode === '2d' ? build2dTraces(activeRows, s) : build3dTraces(activeRows, s);
    layout = mode === '2d'
      ? {
          ...chromeTheme(),
          dragmode: 'pan',
          xaxis: computeXAxis2d(s, at),
          yaxis: computeYAxis2d(s, at, traces),
          shapes: build2dShapes(activeRows),
        }
      : {
          ...chromeTheme(),
          scene: {
            aspectmode: s.aspectMode,
            ...(s.aspectMode === 'manual' ? { aspectratio: { x: s.aspectX, y: s.aspectY, z: s.aspectZ } } : {}),
            xaxis: { ...at, title: 'x', range: [s.xMin, s.xMax] },
            yaxis: { ...at, title: 'y', range: [s.yMin, s.yMax] },
            zaxis: s.outputAuto
              ? { ...at, title: 'z', autorange: true }
              : { ...at, title: 'z', autorange: false, range: [s.outputMin, s.outputMax] },
            bgcolor: 'transparent',
          },
        };
  } catch (err) {
    plotError.textContent = `Couldn't build this plot: ${err.message || err}`;
    plotError.hidden = false;
    return;
  }

  plotDiv.hidden = false;
  plotPlaceholder.hidden = true;
  plotError.hidden = true;

  // Plotly's WebGL gl3d surface renderer can leave stale, misaligned GPU
  // buffers when Plotly.react() hands it a surface trace whose z grid is a
  // different size than the one already on screen (e.g. dragging the
  // Resolution slider) — the update lands as a jumble of spiky, torn
  // triangles instead of a clean re-tessellation, because react() tries to
  // patch the existing buffers in place rather than reallocating them. A
  // full Plotly.newPlot() forces that reallocation. The current camera is
  // carried over into the new layout first so an incidental resolution
  // change mid-orbit doesn't also reset the view.
  const surfaceN = mode === '3d' ? Math.max(Math.min(settings3d.resolution, SURFACE_RESOLUTION_CAP), 2) : null;
  const needsFullRecreate = mode === '3d' && hasPlotted && surfaceN !== lastSurfaceGridN;
  lastSurfaceGridN = surfaceN;
  if (needsFullRecreate && plotDiv.layout?.scene?.camera) {
    layout.scene.camera = plotDiv.layout.scene.camera;
  }

  // Plotly.react's/newPlot's promise can reject from async WebGL/render
  // failures (a common source of an opaque "null" error, especially for 3D
  // surfaces in some GPU/driver setups) that a synchronous try/catch
  // wouldn't see.
  const renderPromise = needsFullRecreate
    ? Plotly.newPlot(plotDiv, traces, layout, PLOTLY_CONFIG)
    : Plotly.react(plotDiv, traces, layout, PLOTLY_CONFIG);
  renderPromise
    .then(() => { hasPlotted = true; })
    .catch((err) => {
      hasPlotted = false;
      plotError.textContent = `Couldn't render this plot: ${err.message || err}`;
      plotError.hidden = false;
    });
}

// Called by shell.js every time the user switches into or out of the Plot
// view. Resizing on re-entry matters because Plotly measures its container
// on every real draw call, and a display:none container while hidden means
// whatever it last measured is stale (typically 0×0) by the time it's shown
// again; flushing a pending redraw covers whatever tried to happen while
// inactive (a settings change, a finished backend fetch, ...).
export function setActive(active) {
  viewActive = active;
  if (active) {
    if (hasPlotted) Plotly.Plots.resize(plotDiv);
    if (redrawPending) redraw();
  }
}

// ---------- Mode toggle ----------

function setMode(newMode) {
  if (newMode === mode) return;
  mode = newMode;
  modeButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
  renderGraphSettingsPanel();
  renderRowChrome();
  redraw();
}

// ---------- Graph settings drawer (everything global/chrome-y lives here) ----------

// Symmetric ±W log-scale slider for an axis: exponent range covers W from
// 0.01 to 1,000,000 with fine control throughout, rather than a linear
// slider that'd be all-or-nothing between "tiny" and "huge" ranges.
const LOG_AXIS_SLIDER_MIN = -2;
const LOG_AXIS_SLIDER_MAX = 6;

function logAxisSliderRow(axis, label, half) {
  const exponent = Math.log10(Math.max(half, 1e-9));
  return `
    <div class="settings-row">
      <label>${label}: <span data-logaxis-value="${axis}">±${formatSigFigs(half)}</span></label>
      <input type="range" data-log-axis="${axis}" min="${LOG_AXIS_SLIDER_MIN}" max="${LOG_AXIS_SLIDER_MAX}" step="0.01" value="${exponent}">
    </div>
  `;
}

function renderGraphSettingsPanel() {
  const s = mode === '2d' ? settings2d : settings3d;
  graphSettingsPanel.innerHTML = mode === '2d' ? `
    <div class="settings-row">
      <label><input type="checkbox" data-field="equalAxes" ${s.equalAxes ? 'checked' : ''}> Equalize axes (1:1)</label>
    </div>
    <div class="settings-row">
      <label>X range</label>
      <div class="plot-range-inputs">
        <input type="number" data-field="xMin" value="${s.xMin}">
        <input type="number" data-field="xMax" value="${s.xMax}">
      </div>
    </div>
    ${logAxisSliderRow('x', 'X zoom', Math.max(Math.abs(s.xMin), Math.abs(s.xMax)))}
    <div class="settings-row">
      <label><input type="checkbox" data-field="outputAuto" ${s.outputAuto ? 'checked' : ''}> Auto Y range</label>
      <div class="plot-range-inputs ${s.outputAuto ? 'is-disabled' : ''}" data-role="output-range">
        <input type="number" data-field="outputMin" value="${s.outputMin}">
        <input type="number" data-field="outputMax" value="${s.outputMax}">
      </div>
    </div>
    ${logAxisSliderRow('y', 'Y zoom', Math.max(Math.abs(s.outputMin), Math.abs(s.outputMax)))}
    <div class="settings-row">
      <label>Resolution: <span data-resolution-value>${s.resolution} points</span></label>
      <input type="range" data-field="resolution" min="20" max="800" step="10" value="${s.resolution}">
    </div>
    <div class="settings-row">
      <div class="settings-row-pair">
        <div>
          <label>X scale</label>
          <select data-field="xScale">
            <option value="linear" ${s.xScale !== 'log' ? 'selected' : ''}>Linear</option>
            <option value="log" ${s.xScale === 'log' ? 'selected' : ''}>Log</option>
          </select>
        </div>
        <div>
          <label>Y scale</label>
          <select data-field="yScale">
            <option value="linear" ${s.yScale !== 'log' ? 'selected' : ''}>Linear</option>
            <option value="log" ${s.yScale === 'log' ? 'selected' : ''}>Log</option>
          </select>
        </div>
      </div>
    </div>
  ` : `
    <div class="settings-row">
      <label>X range</label>
      <div class="plot-range-inputs">
        <input type="number" data-field="xMin" value="${s.xMin}">
        <input type="number" data-field="xMax" value="${s.xMax}">
      </div>
    </div>
    ${logAxisSliderRow('x', 'X zoom', Math.max(Math.abs(s.xMin), Math.abs(s.xMax)))}
    <div class="settings-row">
      <label>Y range</label>
      <div class="plot-range-inputs">
        <input type="number" data-field="yMin" value="${s.yMin}">
        <input type="number" data-field="yMax" value="${s.yMax}">
      </div>
    </div>
    ${logAxisSliderRow('y', 'Y zoom', Math.max(Math.abs(s.yMin), Math.abs(s.yMax)))}
    <div class="settings-row">
      <label><input type="checkbox" data-field="outputAuto" ${s.outputAuto ? 'checked' : ''}> Auto Z range</label>
      <div class="plot-range-inputs ${s.outputAuto ? 'is-disabled' : ''}" data-role="output-range">
        <input type="number" data-field="outputMin" value="${s.outputMin}">
        <input type="number" data-field="outputMax" value="${s.outputMax}">
      </div>
    </div>
    <div class="settings-row">
      <label>Resolution: <span data-resolution-value>${s.resolution} × ${s.resolution} grid</span></label>
      <input type="range" data-field="resolution" min="10" max="150" step="5" value="${s.resolution}">
    </div>
    <div class="settings-row">
      <label>Surface colors</label>
      <select data-field="colorscale">
        <option value="solid" ${s.colorscale === 'solid' ? 'selected' : ''}>Solid (per-expression color)</option>
        ${COLORSCALE_OPTIONS.map((c) => `<option value="${c}" ${s.colorscale === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
    </div>
    <div class="settings-row">
      <label>Axis scaling</label>
      <select data-field="aspectMode">
        ${ASPECT_MODES.map((o) => `<option value="${o.value}" ${s.aspectMode === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </div>
    ${s.aspectMode === 'manual' ? `
      <div class="settings-row">
        <label>Ratio (x : y : z)</label>
        <div class="plot-range-inputs">
          <input type="number" min="0.05" step="0.05" data-field="aspectX" value="${s.aspectX}">
          <input type="number" min="0.05" step="0.05" data-field="aspectY" value="${s.aspectY}">
          <input type="number" min="0.05" step="0.05" data-field="aspectZ" value="${s.aspectZ}">
        </div>
      </div>
    ` : ''}
  `;
}

const debouncedRedraw = debounce(redraw, 120);

// Applies a symmetric ±half range from a log-axis slider drag directly to
// the DOM (rather than a full renderGraphSettingsPanel() re-render, which
// would destroy the very <input type="range"> the user has mid-drag and
// break the gesture) — mirrors the resolution slider's own label-only patch
// below.
function applyLogAxisSlider(axis, rawHalf) {
  // Rounded once here, then reused for both the stored setting and every
  // displayed value below — rounding only the display and leaving the raw
  // 10^exponent float (e.g. 338844.1561...) in settings2d/3d itself would
  // still leak all that noise into the "viewing x ∈ [...]" subtitle, which
  // reads straight from the setting rather than from any of these inputs.
  const half = roundSigFigs(rawHalf, 3);
  const s = mode === '2d' ? settings2d : settings3d;
  if (mode === '2d' && axis === 'y') {
    s.outputAuto = false;
    s.outputMin = -half;
    s.outputMax = half;
    const autoCheckbox = graphSettingsPanel.querySelector('[data-field=outputAuto]');
    if (autoCheckbox) autoCheckbox.checked = false;
    graphSettingsPanel.querySelector('[data-role=output-range]')?.classList.remove('is-disabled');
    const minEl = graphSettingsPanel.querySelector('[data-field=outputMin]');
    const maxEl = graphSettingsPanel.querySelector('[data-field=outputMax]');
    if (minEl) minEl.value = String(-half);
    if (maxEl) maxEl.value = String(half);
  } else {
    s[`${axis}Min`] = -half;
    s[`${axis}Max`] = half;
    const minEl = graphSettingsPanel.querySelector(`[data-field=${axis}Min]`);
    const maxEl = graphSettingsPanel.querySelector(`[data-field=${axis}Max]`);
    if (minEl) minEl.value = String(-half);
    if (maxEl) maxEl.value = String(half);
  }
  const label = graphSettingsPanel.querySelector(`[data-logaxis-value="${axis}"]`);
  if (label) label.textContent = `±${half}`;
}

function wireGraphSettingsPanel() {
  graphSettingsPanel.addEventListener('input', (event) => {
    const el = event.target;

    if (el.dataset.logAxis) {
      applyLogAxisSlider(el.dataset.logAxis, Math.pow(10, parseFloat(el.value)));
      debouncedRedraw();
      return;
    }

    const field = el.dataset.field;
    if (!field) return;
    const s = mode === '2d' ? settings2d : settings3d;

    if (el.type === 'checkbox') {
      s[field] = el.checked;
      if (field === 'outputAuto') {
        graphSettingsPanel.querySelector('[data-role=output-range]')?.classList.toggle('is-disabled', el.checked);
      }
    } else if (el.type === 'range') {
      s[field] = parseInt(el.value, 10);
      const label = graphSettingsPanel.querySelector('[data-resolution-value]');
      if (label) label.textContent = mode === '2d' ? `${s[field]} points` : `${s[field]} × ${s[field]} grid`;
    } else if (el.tagName === 'SELECT') {
      s[field] = el.value;
      if (field === 'aspectMode') renderGraphSettingsPanel(); // reveal/hide the manual-ratio row
    } else {
      const value = parseFloat(el.value);
      if (Number.isFinite(value)) s[field] = value;
    }
    debouncedRedraw();
  });

  graphSettingsToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    graphSettingsPanel.hidden = !graphSettingsPanel.hidden;
    exportMenu.hidden = true;
  });
  document.addEventListener('click', (event) => {
    if (!graphSettingsPanel.hidden && !graphSettingsPanel.contains(event.target) && event.target !== graphSettingsToggle) {
      graphSettingsPanel.hidden = true;
    }
  });
}

// ---------- Export ----------

const RASTER_FORMATS = new Set(['png', 'jpeg']);

// Same row/curve walk as build2dTraces/build3dTraces, but producing a plain
// spec (expression + styling, not sampled points) for the backend to render
// itself — a real vector export needs the backend's own renderer
// (matplotlib), not a snapshot of what Plotly already drew on screen.
function buildExportPayload(format) {
  const s = mode === '2d' ? settings2d : settings3d;
  const activeRows = rows.filter((r) => rowWorksInMode(r, mode) && r.visible);
  const specs = [];

  for (const row of activeRows) {
    if (row.plotType === 'vline' || row.plotType === 'hline') {
      specs.push({ kind: row.plotType, value: row.lineValue, color: row.color, label: row.latex });
      continue;
    }
    if (mode === '3d' && row.dim === 2) {
      specs.push({
        kind: 'surface',
        mathjson: row.mathjsonExpr, vars: row.vars,
        domainX: { min: row.domain.xMin, max: row.domain.xMax },
        domainY: { min: row.domain.yMin, max: row.domain.yMax },
        color: row.color, label: row.label || row.latex,
      });
      continue;
    }
    const curves = rowCurves(row);
    curves.forEach((curve, i) => {
      const label = row.label ? `${row.label}(${curve.vars[0]})${curves.length > 1 ? ` #${i + 1}` : ''}` : row.latex;
      specs.push(mode === '3d'
        ? { kind: 'wall', mathjson: curve.mathjson, var: curve.vars[0], domain: row.domain, alongX: curve.vars[0] === 'x', color: row.color, label }
        : { kind: 'curve', mathjson: curve.mathjson, var: curve.vars[0], domain: row.domain, color: row.color, lineStyle: row.lineStyle, label });
    });
  }

  const view = mode === '2d'
    ? { xMin: s.xMin, xMax: s.xMax, xScale: s.xScale, yScale: s.yScale, outputAuto: s.outputAuto, outputMin: s.outputMin, outputMax: s.outputMax }
    : {
        xMin: s.xMin, xMax: s.xMax, yMin: s.yMin, yMax: s.yMax,
        outputAuto: s.outputAuto, outputMin: s.outputMin, outputMax: s.outputMax,
        aspectMode: s.aspectMode, aspectX: s.aspectX, aspectY: s.aspectY, aspectZ: s.aspectZ,
      };
  const resolution = mode === '2d' ? s.resolution : Math.max(Math.min(s.resolution, SURFACE_RESOLUTION_CAP), 2);

  return { mode, format, rows: specs, view, resolution, constants: currentConstants, functions: getFunctions() };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function wireExport() {
  exportToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
    graphSettingsPanel.hidden = true;
  });
  document.addEventListener('click', () => { exportMenu.hidden = true; });
  exportMenu.addEventListener('click', (event) => event.stopPropagation());
  exportMenu.querySelectorAll('button[data-format]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      exportMenu.hidden = true;
      if (!hasPlotted) return;
      const format = btn.dataset.format;

      if (RASTER_FORMATS.has(format)) {
        Plotly.downloadImage(plotDiv, { format, filename: `prettycas-${mode}-plot`, width: 1200, height: 900 });
        return;
      }

      try {
        const blob = await exportPlot(buildExportPayload(format), getSettings());
        downloadBlob(blob, `prettycas-${mode}-plot.${format}`);
      } catch (err) {
        plotError.textContent = `Couldn't export this plot: ${err.message || err}`;
        plotError.hidden = false;
      }
    });
  });
}

// ---------- Bootstrap ----------

export function mount() {
  exprListEl = document.getElementById('expr-list');
  addExprBtn = document.getElementById('add-expr');
  modeButtons = [...document.querySelectorAll('.mode-btn')];
  plotTitleEl = document.getElementById('plot-title');
  plotSubtitleEl = document.getElementById('plot-subtitle');
  graphSettingsToggle = document.getElementById('graph-settings-toggle');
  graphSettingsPanel = document.getElementById('graph-settings-panel');
  exportToggle = document.getElementById('export-toggle');
  exportMenu = document.getElementById('export-menu');
  plotPanel = document.getElementById('plot-panel');
  plotError = document.getElementById('plot-error');
  plotDiv = document.getElementById('plot');
  plotPlaceholder = document.getElementById('plot-placeholder');

  document.addEventListener('click', closeAllRowSettingsPopovers);
  modeButtons.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  wireGraphSettingsPanel();
  wireExport();

  addExprBtn.addEventListener('click', () => {
    const empty = rows.find((r) => r.kind === 'empty');
    if (empty) empty.mf.focus();
    else {
      const row = createRow('');
      row.mf.focus();
    }
  });

  onSettingsChange(() => {
    if (hasPlotted) redraw();
  });
  const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  darkMediaQuery.addEventListener('change', () => {
    if (!getSettings().background && hasPlotted) redraw();
  });

  customElements.whenDefined('math-field').then(() => {
    createRow('');
    renderGraphSettingsPanel();
    classifyAndRedraw();
  });
}
