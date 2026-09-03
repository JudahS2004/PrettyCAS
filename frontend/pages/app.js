import '../node_modules/mathlive/mathlive.min.mjs';
import { compile } from '../node_modules/@cortex-js/compute-engine/dist/esm-min/compute-engine.js';
import { convertLatexToMarkup } from '../node_modules/mathlive/mathlive.min.mjs';
import { computeMathJson } from '../api.js';
import { getSettings, onSettingsChange, updateSetting } from '../settings.js';
import { addEntry, mountHistory } from '../history.js';
import { getWorkspace, setVar, getFunctions, setFunction, mountWorkspace } from '../workspace.js';
import { ce, PARSE_CANONICAL, PARSE_CANONICAL_WITH_DIVIDE, USER_FUNCTION_NAMES } from '../compute-engine.js';

// Settings that feed the backend computation itself: changing any of these
// invalidates the last response, so it's re-sent rather than just re-rendered.
// numberFormat is deliberately not here — the backend sends back every
// format (standard/decimal/engineering) up front in `formats` (see
// withFormat below), so flipping that toggle is a local re-render instead.
const RECOMPUTE_KEYS = ['angleMode', 'decimals', 'simplifyMode', 'complexForm'];

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

// MathLive's own inline shortcuts turn "dx"/"dy"/"dt" into "\differentialD x"
// etc. as you finish typing them — the ISO-style upright "d" for a
// differential, e.g. in d/dx or under an integral's dx. It's a nicer render,
// but compute-engine's LaTeX parser has no grammar rule for \differentialD
// at all and errors out on it ("unexpected-command") rather than treating it
// as a plain d. Swapping it back to a literal "d" before parsing — only for
// interpretation; the field itself still displays the pretty upright d — is
// what lets d/dx(...), \int ... dx, etc. resolve instead of hitting a
// syntax error the moment MathLive "straightens" the input.
function normalizeLatex(latex) {
  return wrapLeibnizArguments(latex.replace(/\\differentialD\s*/g, 'd'));
}

// ce.parse() under PARSE_CANONICAL can throw outright (not just come back
// invalid) on a narrow class of otherwise-legitimate input — see
// PARSE_CANONICAL_WITH_DIVIDE's comment in compute-engine.js for the actual
// bug. Retrying with that fallback list turns those cases into a real parse
// instead of a false "Syntax error", without weakening the precision
// PARSE_CANONICAL protects for every other input (the fallback only ever
// runs after the primary list has already thrown).
function parseLatex(latex) {
  try {
    return ce.parse(latex, { canonical: PARSE_CANONICAL });
  } catch {
    try {
      return ce.parse(latex, { canonical: PARSE_CANONICAL_WITH_DIVIDE });
    } catch {
      return null;
    }
  }
}

// compute-engine's LaTeX parser treats "\frac{d}{dx}" as a prefix operator
// that greedily consumes everything to its right up through the end of the
// enclosing additive chain, instead of binding only to the single term
// immediately after it. So both "\frac{d}{dx}\left(\sin(x)\right)+1" and
// the parenthesis-free "\frac{d}{dx}\sin(x)+2" parse as D(sin(x)+1, x) /
// D(sin(x)+2, x) - silently pulling the trailing "+1"/"+2" inside the
// derivative, where it then vanishes (the derivative of a constant is 0).
// Wrapping just the intended argument - the one atom right after the
// "d/dx" (a function call, a bare symbol, a power, ...) - together with
// the "\frac{d}{dx}" itself in one more explicit "\left( \right)" gives
// the parser a boundary it does respect.
//
// The exact same bug hits "\frac{\partial}{\partial x}" (and higher-order/
// mixed forms like "\frac{\partial^2}{\partial x\partial y}") the same way
// - compute-engine's grammar maps \partial to the same "D" op as plain d,
// so it inherits the identical greedy-argument behavior. wrapLeibnizArguments
// below handles both operators uniformly instead of only literal "d".
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
    // A bare single-letter symbol immediately followed by a parenthesized
    // group is a function call - u(x,t), not just u - and compute-engine's
    // parser treats it that way, so the call's arguments need to stay in
    // the same atom, same as \sin(x) above. Otherwise "\frac{\partial}
    // {\partial t}u(x,t)+2" wraps only the bare "u", leaving "(x,t)"
    // dangling outside the derivative it belongs to.
    const afterIdent = skipWs(latex, i);
    if (latex.startsWith('\\left', afterIdent)) {
      const end = findMatchingRight(latex, afterIdent);
      if (end !== -1) i = end;
    } else if (latex[afterIdent] === '(') {
      const end = findMatchingParen(latex, afterIdent);
      if (end !== -1) i = end + 1;
    }
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

// Recognizes a Leibniz derivative "operator token" - literal "d" or
// "\partial" - starting at pos. For "d" this requires the next character to
// NOT be another letter, so a numerator like "dx" (the product of d and x,
// not a derivative) doesn't false-positive; "\partial" is an unambiguous
// LaTeX command name so no such guard is needed for it. Returns the token's
// kind ('d'/'partial'), or null if pos doesn't start with either.
function matchDerivMarker(latex, pos) {
  if (latex.startsWith('\\partial', pos)) return 'partial';
  if (latex[pos] === 'd' && !/[a-zA-Z]/.test(latex[pos + 1] || '')) return 'd';
  return null;
}

function wrapLeibnizArguments(latex) {
  let result = '';
  let searchFrom = 0;
  while (true) {
    const fracStart = latex.indexOf('\\frac{', searchFrom);
    if (fracStart === -1) {
      result += latex.slice(searchFrom);
      return result;
    }
    const numOpenBrace = fracStart + 5; // index of the numerator's "{"
    const numKind = matchDerivMarker(latex, numOpenBrace + 1);
    if (!numKind) {
      result += latex.slice(searchFrom, numOpenBrace + 1);
      searchFrom = numOpenBrace + 1;
      continue;
    }
    const numCloseBrace = findMatchingBrace(latex, numOpenBrace);
    if (numCloseBrace === -1 || latex[numCloseBrace + 1] !== '{') {
      result += latex.slice(searchFrom, numOpenBrace + 1);
      searchFrom = numOpenBrace + 1;
      continue;
    }
    const denomOpenBrace = numCloseBrace + 1;
    // Denominator must open with the *same* operator (e.g. reject a
    // genuine fraction like "\frac{d}{x}" whose numerator just happens to
    // be a variable literally named "d") - here the operator legitimately
    // runs straight into the variable name ("dx", "\partial x"), so no
    // not-a-letter guard on what follows.
    const denomKind = latex.startsWith('\\partial', denomOpenBrace + 1)
      ? 'partial'
      : latex[denomOpenBrace + 1] === 'd'
        ? 'd'
        : null;
    const denomCloseBrace = findMatchingBrace(latex, denomOpenBrace);
    if (denomCloseBrace === -1 || denomKind !== numKind) {
      result += latex.slice(searchFrom, denomOpenBrace + 1);
      searchFrom = denomOpenBrace + 1;
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

// Assigned in mount() below, once #mf and friends exist — module-scoped so
// every helper function here can close over them without each needing its
// own DOM lookup.
let mf, outputPanel, outputBadges, outputRender;

let lastResponse = null;

// Parsed directly with ce.parse() (not mf.getValue('math-json')) so
// PARSE_CANONICAL above actually applies — the math-field's own math-json
// serialization calls ce.parse() internally with no way to pass options.
function getMathJson() {
  return parseLatex(normalizeLatex(mf.getValue('latex'))).json;
}

// Flattens a bare symbol, or a Subscript(base, sub) node whose base and
// subscript are themselves bare symbols (\mu_r, k_B, ...), into one name
// string — mirrors sympy's own Symbol("base_sub") convention on the backend
// (mathjson.py's OPS["Subscript"]) so the two stay in lockstep as the same
// workspace key. A digit subscript never reaches the Subscript branch at
// all: compute-engine's parser already flattens "X_1" straight to the
// symbol string "X_1" itself, before this ever runs.
function symbolName(box) {
  if (typeof box?.symbol === 'string') return box.symbol;
  if (box?.operator === 'Subscript') {
    const [base, sub] = box.ops || [];
    const baseName = symbolName(base);
    const subName = symbolName(sub);
    if (baseName && subName) return `${baseName}_${subName}`;
  }
  return null;
}

// compute-engine's own `.unknowns`/`.freeVariables`/`.symbols` getters all
// report a \int/\sum/\prod's own bound variable as a free unknown —
// confirmed live: `\int_2^{400}x\,dx` reports "x" as free even though it's
// fully bound by the integral itself, identically for `.freeVariables`. Used
// below (isRealAssignment) to decide whether an assignment's RHS is fully
// resolvable from known constants; with the buggy getter, any assignment
// whose RHS is an integral/sum/product looked like it had a stray unresolved
// symbol, so "Z = \int_2^{400}x\,dx" silently never saved to Z (isRealAssignment
// false skipped the save entirely), and worse, "A = \int_2^{400}x\,dx" with A
// already saved substituted A's *old* value back in as if this were a
// true/false check instead of a reassignment. `boundVariableNames` mirrors
// exactly the shapes backend/functions/mathjson.py's own to_sympy already
// relies on for these same three ops (`_BOUNDED_OPS`'s `[body, ["Tuple",
// var, lo, hi]]` shape for a definite Sum/Product/Integral, or a bare
// `[body, var]` for an indefinite Integral) plus \lim's own `["Limit",
// ["Function", body, var], point]` shape.
function boundVariableNames(node) {
  if (!Array.isArray(node)) return [];
  const [op, ...args] = node;
  if ((op === 'Integrate' || op === 'Sum' || op === 'Product') && args.length >= 2) {
    const spec = args[args.length - 1];
    if (Array.isArray(spec) && spec[0] === 'Tuple' && typeof spec[1] === 'string') return [spec[1]];
    if (typeof spec === 'string') return [spec];
  }
  if (op === 'Limit' && Array.isArray(args[0]) && args[0][0] === 'Function') {
    return args[0].slice(2).filter((a) => typeof a === 'string');
  }
  return [];
}

// The actual free symbol names in a raw MathJSON tree (as from a boxed
// expression's own `.json`), correctly excluding whatever boundVariableNames
// says a \int/\sum/\prod/\lim node binds within itself — see its own comment
// on why this exists instead of just using compute-engine's `.unknowns`.
function freeSymbolsOf(node, bound = new Set()) {
  if (typeof node === 'string') return bound.has(node) ? new Set() : new Set([node]);
  if (!Array.isArray(node)) return new Set();
  const [, ...args] = node;
  const localBound = new Set([...bound, ...boundVariableNames(node)]);
  const result = new Set();
  for (const arg of args) {
    for (const sym of freeSymbolsOf(arg, localBound)) result.add(sym);
  }
  return result;
}

// Same idea as the Plot page's constant-row detection: "a = <rhs>" (bare
// symbol on one side of an Equal, LaTeX-parsed via the boxed expression API
// rather than raw mathjson) names a workspace assignment worth remembering.
function getAssignmentParts(parsed) {
  if (parsed.operator !== 'Equal') return null;
  const name1 = symbolName(parsed.op1);
  if (name1) return { name: name1, rhs: parsed.op2 };
  const name2 = symbolName(parsed.op2);
  if (name2) return { name: name2, rhs: parsed.op1 };
  return null;
}

// Same idea as getAssignmentParts, but for "f(x) = <rhs>" defining a
// function instead of a variable. The target has to be a name
// compute-engine parses call-parens on as a function application at all —
// f/g/h (explicitly declared in compute-engine.js) or, confirmed live, any
// single uppercase letter at all (its own built-in convention: "Q(x)"
// parses straight to ["Q","x"] with no declare() needed, while "p(x)"
// parses as Multiply("p","x")) — so e.g. "p(x) = x^2" never reaches here
// shaped like a function definition to begin with. The call's arguments
// all have to be bare symbols (the parameter list, e.g. "x" in f(x)) —
// this is what keeps a genuine equation like "sin(x) = 1" (op1.operator
// "Sin", not a definable name) from ever matching, and guards against
// something like "f(x^2) = ..." that isn't a parameter list.
function isDefinableFunctionName(name) {
  return USER_FUNCTION_NAMES.includes(name) || /^[A-Z]$/.test(name);
}

function getFunctionDefinitionParts(parsed) {
  if (parsed.operator !== 'Equal') return null;
  const fromCall = (call, rhs) => {
    if (typeof call?.operator !== 'string' || !isDefinableFunctionName(call.operator)) return null;
    const args = call.ops || [];
    const params = args.map((a) => (typeof a.symbol === 'string' ? a.symbol : null));
    if (params.length === 0 || params.includes(null) || new Set(params).size !== params.length) return null;
    return { name: call.operator, params, rhs };
  };
  return fromCall(parsed.op1, parsed.op2) || fromCall(parsed.op2, parsed.op1);
}

// No `realOnly: true` here (unlike plot.js's own copy, which feeds a
// real-valued slider and should keep rejecting complex results): a
// workspace assignment like "X = 50 - 30i" is a completely ordinary input,
// and realOnly was making compute-engine collapse that compiled result to a
// bare NaN — Number.isFinite(NaN) then failed the caller's save-to-workspace
// check every time, so a complex assignment displayed correctly but never
// actually got cached, identically to (and easily mistaken for another
// instance of) the auto-compute race documented above. Without realOnly,
// compute-engine's own compiled value for a complex result is a plain `{re,
// im}` object instead of a JS number — returned here as-is so the caller can
// cache it into the workspace as a real value; a later expression that
// itself references a complex-valued workspace variable still isn't
// supported (compute-engine's compiled JS has no complex-arithmetic
// operators, so e.g. compiling "X + 1" against a cached {re,im} X produces
// garbage, not a real result) and correctly falls through to `null` below,
// same known-gap shape as the workspace-function-call limit documented
// elsewhere in this file.
function evalNumeric(expr, vars) {
  try {
    const compiled = compile(expr, {});
    const value = compiled.run(vars);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value && Number.isFinite(value.re) && Number.isFinite(value.im)) return value;
    return null;
  } catch {
    return null;
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

// The backend hands back every number format (standard/decimal/engineering)
// up front in `response.formats` (see api.js), computed once from the same
// resolved value — so switching the toggle is just picking a different
// pre-computed branch of the response already in hand, not a new request.
// Falls back to `response` itself unchanged for a mode that has no
// `formats` (an error, a true/false check, ...), where every format would
// look identical anyway.
function withFormat(response, numberFormat) {
  const alt = response?.formats?.[numberFormat];
  return alt ? { ...response, ...alt } : response;
}

function render(response) {
  const settings = getSettings();
  const active = withFormat(response, settings.numberFormat);
  outputPanel.dataset.mode = active.mode;

  if (settings.displayMode === 'debug') {
    outputBadges.innerHTML =
      `<span class="badge">${escapeHtml(active.mode)}</span>` +
      (active.method ? `<span class="badge">${escapeHtml(active.method)}</span>` : '');

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
        <div class="debug-rendered">${resultMarkup(active)}</div>
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
  outputRender.innerHTML = resultMarkup(active);
}

// Tracks whichever /api/compute request is currently in flight, so a new
// one (fresh keystroke, Enter, a settings-driven recompute, ...) can cancel
// it instead of leaving it to resolve later and clobber whatever's on
// screen by then — including after the field's been cleared back to idle,
// which doesn't call runCompute() at all (see runComputeIfNonEmpty below).
// Confirmed live this was a real problem, not just theoretical: a slow
// request left stale was free to render its result over a field the user
// had already cleared and moved on from.
let currentComputeController = null;

// True while a saveToHistory compute (Enter) is between dispatching its
// /api/compute request and that request resolving. The debounced
// auto-compute timer (armed on every keystroke, including ones mathlive
// itself fires as a side effect of handling Enter) checks this before
// calling runComputeIfNonEmpty(false) — otherwise it can fire while an
// Enter-triggered request is still in flight, and runCompute()'s own
// currentComputeController.abort() kills that request before it ever
// reaches the code that saves to history/workspace. The auto-compute's own
// result still renders fine in that case (nothing looks wrong on screen),
// which is what made this so easy to mistake for "assignment just doesn't
// save" rather than a race — confirmed live: function definitions never
// hit this because they resolve synchronously with no network round trip
// in between, so there's no window for anything to interrupt them; a
// variable assignment's evalNumeric()/setVar() call only happens after
// awaiting the backend response, which is exactly that window.
let historyComputeInFlight = false;

async function runCompute(saveToHistory = false) {
  currentComputeController?.abort();
  const controller = new AbortController();
  currentComputeController = controller;

  const latex = mf.getValue('latex');

  // Something like "1+" or "\sqrt{" parses into a valid-looking MathJSON
  // tree with an embedded ["Error", ...] node rather than throwing, so it'd
  // otherwise sail past getMathJson() and hit the backend as a garbled
  // expression it can't make sense of. Catching invalid input here, before
  // ever sending it, is what turns that into a clean "Syntax error" instead.
  const parsed = parseLatex(normalizeLatex(latex));
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

  // "f(x) = <rhs>" defines a workspace function (see workspace.js) —
  // handled entirely client-side rather than round-tripped to /api/compute:
  // the backend's equation solver has no well-defined notion of "solve"
  // for an equation whose left side is a function application rather than
  // a bare symbol, so this is resolved locally instead of risking that
  // being misread as something to actually solve.
  const funcDef = getFunctionDefinitionParts(parsed);
  if (funcDef) {
    const head = `${funcDef.name}(${funcDef.params.join(', ')})`;
    const response = { mode: 'evaluate', result: `${head} = ${funcDef.rhs.toString()}`, latex: `${head} = ${funcDef.rhs.latex}` };
    lastResponse = response;
    render(response);
    if (saveToHistory) {
      addEntry(latex, summarize(response));
      setFunction(funcDef.name, funcDef.params, funcDef.rhs.json, funcDef.rhs.latex);
    }
    return;
  }

  outputPanel.dataset.mode = 'pending';
  outputBadges.innerHTML = '';
  outputRender.innerHTML = '<span class="placeholder">Computing…</span>';

  // "a = <rhs>" is a workspace assignment — its own name is left out of the
  // constants sent along for *this* computation, otherwise substituting a's
  // old value into "a = 3" would turn the assignment into a true/false
  // check of the old value against the new one instead of solving/defining it.
  //
  // But that's only valid when rhs can actually resolve to a plain number
  // from the rest of the workspace — a workspace variable is never anything
  // but a plain number (see workspace.js), so if rhs still has a genuinely
  // unknown symbol (e.g. re-typing "L_u = ..." as an equation to solve for
  // some other variable, with L_u itself already saved), this was never
  // going to succeed as a redefinition anyway: nothing ends up saved either
  // way, but stripping the name here would also break the equation itself,
  // discarding the one thing (L_u's own saved value) needed to solve it.
  // freeSymbolsOf (not compute-engine's own `.unknowns` — see its own
  // comment) mirrors plot.js's own free-symbol check; the assignment's own
  // name is always allowed through so a self-referencing case like
  // "x = 2x + 1" still resolves (and saves) exactly as before.
  const assignment = getAssignmentParts(parsed);
  const constants = getWorkspace();
  const isRealAssignment = assignment
    && [...freeSymbolsOf(assignment.rhs.json)].every((sym) => sym === assignment.name || sym in constants);
  if (isRealAssignment) delete constants[assignment.name];
  const functions = getFunctions();

  let response;
  if (saveToHistory) historyComputeInFlight = true;
  try {
    response = await computeMathJson(mathjson, getSettings(), { constants, functions }, controller.signal);
  } catch (err) {
    // A superseded request landing here (aborted by a newer one above, or
    // by the Clear-while-pending path in runComputeIfNonEmpty) isn't a real
    // error — surfacing "AbortError" would just be confusing noise over
    // whatever's already on screen for the request that actually won.
    if (err.name === 'AbortError') return;
    response = { mode: 'error', result: String(err.message || err) };
  } finally {
    if (saveToHistory) historyComputeInFlight = false;
  }

  lastResponse = response;
  render(response);
  if (saveToHistory) {
    addEntry(mf.getValue('latex'), summarize(response));
    if (isRealAssignment && response.mode !== 'error') {
      // Prefer the backend's own full-double-precision numeric value
      // (response.numeric — see compute.py's _numeric_value) over a local
      // recompile: the backend already substituted workspace constants and
      // functions to resolve the RHS, so it has no trouble with an RHS that
      // itself references an already-complex workspace variable ("Gamma =
      // (Zl-Z0)/(Zl+Z0)" with Zl/Z0 complex) or calls a workspace function —
      // both cases evalNumeric's local compute-engine compile can't handle
      // (see its own comment) and would otherwise silently fail to save.
      // evalNumeric stays as a fallback for the rare kind _render doesn't
      // attach `numeric` to.
      const value = response.numeric !== undefined && response.numeric !== null
        ? response.numeric
        : evalNumeric(assignment.rhs, getWorkspace());
      // response.exact (compute.py's _exact_mathjson) is the symbolic form
      // of the same value, e.g. sqrt(2)/2 rather than 0.7071067811865476 —
      // cached alongside `value` so a later computation that reuses this
      // name substitutes the exact expression instead of a decimal
      // approximation of it (see workspace.js's setVar/getWorkspace).
      // Undefined for a kind _render doesn't attach it to (falls through to
      // decimal-only, same as before this existed) or a value with no exact
      // form to begin with.
      if (value !== null && value !== undefined) setVar(assignment.name, value, response.exact);
    }
  }
}

// A tall construct (integral, fraction stack, ...) can leave #mf stuck
// oversized even after it's removed again (backspaced out or cleared) — not
// a CSS/reflow issue but a real self-referential bug in mathlive's own
// internal updateToggleLayout() (mathlive.mjs, the "ML__toggles--vertical"
// class it toggles on the keyboard/menu-toggle button stack): it decides
// vertical-vs-horizontal by reading the *host's* offsetHeight, but the
// vertical stack is itself a flex sibling of the field content, so once
// triggered it inflates the very height being measured to decide whether to
// un-trigger it — height never drops below its own 100px threshold again,
// no matter how short the actual math content gets. Confirmed live: after
// typing then clearing \int_0^1 x^2 dx, the host stays at ~110px (matching
// a fresh field's 72px plus the 38px the stuck-vertical toggle stack adds)
// until this runs.
// The fix mirrors mathlive's own logic (same class, same 100px threshold)
// but breaks the circularity: temporarily drop the vertical class, then
// only put it back if the host is still genuinely tall without it.
// mathlive re-renders the field content asynchronously after a value
// change (its own updateToggleLayout() runs off a ResizeObserver callback,
// not synchronously with the edit), so this has to wait for that to land
// too — running it synchronously right after the edit just re-measures the
// still-tall old content and immediately restores the class. Two rAFs
// (confirmed the minimum needed empirically) gets past both mathlive's own
// render pass and its ResizeObserver-driven follow-up.
function fixToggleLayout() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const toggles = mf.shadowRoot?.querySelector('.ML__toggles');
    if (!toggles || !toggles.classList.contains('ML__toggles--vertical')) return;
    toggles.classList.remove('ML__toggles--vertical');
    if (mf.offsetHeight >= 100) toggles.classList.add('ML__toggles--vertical');
  }));
}

// There's no explicit "Compute" button — an empty field just resets to the
// idle placeholder instead of sending a request that can only error.
function runComputeIfNonEmpty(saveToHistory = false) {
  if (!mf.getValue('latex').trim()) {
    // Doesn't call runCompute() below, so it has to cancel a pending
    // request itself — otherwise a slow one from before the field was
    // cleared is still free to land later and overwrite this idle state.
    currentComputeController?.abort();
    lastResponse = null;
    outputPanel.dataset.mode = 'idle';
    outputBadges.innerHTML = '';
    outputRender.innerHTML = '<span class="placeholder">Result will show up here.</span>';
    return;
  }
  runCompute(saveToHistory);
}

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

// Not 0: mathlive can fire more than one 'input' event for a single
// keystroke (e.g. an autocomplete/template expansion), so this still
// coalesces those into one compute rather than sending one per event — just
// too short for a human to perceive as a delay, unlike the 400ms this used
// to be (the backend itself answers something like "4-1" in ~5ms; that
// 400ms was actually most of the felt lag, not compute time).
const AUTO_COMPUTE_DELAY_MS = 10;

let inputRunTimer = null;
let prevSettings = null;
let recomputeTimer = null;

export function mount() {
  mf = document.getElementById('mf');
  outputPanel = document.getElementById('output-panel');
  outputBadges = document.getElementById('output-badges');
  outputRender = document.getElementById('output-render');

  // Typing auto-computes (for instant feedback) but only Enter saves a
  // history entry — otherwise every intermediate keystroke's result would
  // get logged on its way to what you actually meant to type. Auto-compute
  // itself is a setting (default on) — off, only Enter computes at all.
  mf.addEventListener('input', () => {
    fixToggleLayout();
    clearTimeout(inputRunTimer);
    if (!getSettings().autoCompute) return;
    inputRunTimer = setTimeout(() => {
      // Skip entirely rather than let this go on to call runCompute():
      // runCompute() unconditionally aborts whatever's currently in flight,
      // and a saveToHistory request already has this input's real result on
      // the way — an auto-compute here would only abort it out from under
      // itself, right before it reaches the code that saves to
      // history/workspace, for a render that would look identical anyway.
      if (historyComputeInFlight) return;
      runComputeIfNonEmpty(false);
    }, AUTO_COMPUTE_DELAY_MS);
  });

  mf.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(inputRunTimer);
      runComputeIfNonEmpty(true);
    }
  });

  document.getElementById('clear-input').addEventListener('click', () => {
    mf.value = '';
    fixToggleLayout();
    mf.focus();
    runComputeIfNonEmpty(false);
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
    const active = withFormat(lastResponse, settings.numberFormat);
    let text;
    if (settings.copyFormat === 'mathjson' && active.latex) {
      const box = parseLatex(active.latex);
      text = box ? JSON.stringify(box.json) : active.latex;
    } else if (active.latex) {
      text = active.latex;
    } else if (Array.isArray(active.result)) {
      text = active.result.join(', ');
    } else {
      text = String(active.result);
    }
    copyText(text);
  });

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

  // Settings that feed the computation itself (angle mode, number format,
  // decimals) re-run the compute so the shown result always matches the
  // currently selected mode; purely-cosmetic settings just re-render.
  // Debounced so dragging the decimals slider doesn't fire a request per tick.
  prevSettings = getSettings();
  onSettingsChange((settings) => {
    syncAngleToggle();
    syncNumberToggle();
    syncSimplifyToggle();
    syncHistoryVisibility();

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
}
