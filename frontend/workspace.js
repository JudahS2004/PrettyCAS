// The session workspace: "a = 3" remembers a for later inputs ("a + 2"),
// the same way a REPL variable would. "f(x) = x^2 + 1" does the same for a
// function definition — later inputs can call f(3), differentiate it,
// plot it, and so on. Deliberately in-memory only — unlike history, it's
// not read from or written to localStorage, so it starts empty every
// launch instead of carrying values over from a past session.

import { convertLatexToMarkup } from "./node_modules/mathlive/mathlive.min.mjs";
import { ce } from "./compute-engine.js";

let vars = new Map();
// name -> exact MathJSON tree for that variable's value, when the backend
// could derive one (see compute.py's _exact_mathjson) — e.g. sqrt(2)/2, not
// a decimal approximation of it. Absent for a name whose value has no exact
// form (a genuine irrational-looking Float) or came from the evalNumeric
// fallback rather than the backend. Kept as a second map, entirely separate
// from `vars`. The panel shows it (varLatex) next to the rounded decimal.
let varsExact = new Map();
// name -> { params: [string, ...], mathjson: <body mathjson>, latex: <body latex, display-only> }
let funcs = new Map();

// { name: value } for every stored variable, for sending along as the
// "constants" a computation should substitute in (mirrors the shape a
// plot row's slider constants already use for /api/sample). A name with a
// cached exact form is sent as { exact: <mathjson> } instead of its plain
// decimal value — see backend/functions/mathjson.py's sympify_constant,
// which reconstructs that straight back into the exact symbolic value
// (e.g. sqrt(2)/2) rather than the ~16-digit decimal-derived Rational a
// bare double would round-trip through.
export function getWorkspace() {
  return Object.fromEntries(
    [...vars.entries()].map(([name, value]) => {
      const exact = varsExact.get(name);
      return [name, exact !== undefined ? { exact } : value];
    })
  );
}

// { name: { params, body } } for every stored function, for sending along
// as "functions" — the shape backend/functions/mathjson.py's
// substitute_functions expects. Only params/mathjson are sent; the display
// latex stays client-side.
export function getFunctions() {
  return Object.fromEntries(
    [...funcs.entries()].map(([name, def]) => [name, { params: def.params, body: def.mathjson }])
  );
}

export function setVar(name, value, exact) {
  vars.set(name, value);
  if (exact !== undefined && exact !== null) varsExact.set(name, exact);
  else varsExact.delete(name);
  render();
}

export function setFunction(name, params, mathjson, latex) {
  funcs.set(name, { params, mathjson, latex });
  render();
}

export function clearWorkspace() {
  vars.clear();
  varsExact.clear();
  funcs.clear();
  render();
}

function deleteVar(name) {
  vars.delete(name);
  varsExact.delete(name);
  render();
}

function deleteFunc(name) {
  funcs.delete(name);
  render();
}

let listEl = null;

// Wires the <details class="history" id="workspace"> block in the page:
// renders existing entries and wires the Clear button.
export function mountWorkspace(detailsEl) {
  listEl = detailsEl.querySelector(".workspace-list");
  detailsEl.querySelector("#clear-workspace")?.addEventListener("click", clearWorkspace);
  render();
}

function render() {
  if (!listEl) return;
  if (vars.size === 0 && funcs.size === 0) {
    listEl.innerHTML = `<p class="empty-note">Nothing yet. Try "a = 3" or "f(x) = x^2".</p>`;
    return;
  }
  const varItems = [...vars.entries()].map(
    ([name, value]) => itemMarkup(varLatex(name, value), "var", name, "variable", valueLatex(value))
  );
  const funcItems = [...funcs.entries()].map(
    ([name, def]) => itemMarkup(
      `${symbolLatex(name)}(${def.params.map(symbolLatex).join(",")})=${def.latex}`,
      "func", name, "function"
    )
  );
  listEl.innerHTML = [...varItems, ...funcItems].join("");

  listEl.querySelectorAll(".item-delete").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (btn.dataset.kind === "func") deleteFunc(btn.dataset.name);
      else deleteVar(btn.dataset.name);
    });
  });
}

// data-name/data-value carry the plain name and value LaTeX for tests.
function itemMarkup(latex, kind, name, deleteTitle, valueText = "") {
  let body;
  try {
    body = convertLatexToMarkup(latex);
  } catch {
    body = escapeHtml(latex);
  }
  return `
    <div class="history-item workspace-item" data-name="${escapeHtml(name)}" data-value="${escapeHtml(valueText)}">
      <div class="history-item-body history-math">${body}</div>
      <button type="button" class="item-delete" data-name="${escapeHtml(name)}" data-kind="${kind}" title="Delete ${deleteTitle}" aria-label="Delete ${deleteTitle}">&times;</button>
    </div>`;
}

// "h_t" -> "h_{t}", "rho" -> "\\rho": compute-engine already knows how to
// write its own symbol names as LaTeX.
function symbolLatex(name) {
  try {
    return ce.box(name, { canonical: false }).latex || name;
  } catch {
    return name;
  }
}

// Full double precision stays in `vars`; the panel just rounds to 10
// significant digits. A complex value is app.js's {re, im} shape and a
// matrix is a nested array of rows (see evalNumeric / compute.py's numeric).
// "name = value". Shows the exact form too when there is one that isn't
// just the same plain number, e.g. rho = sqrt(2)/2 ~ 0.7071067812.
function varLatex(name, value) {
  const decimal = valueLatex(value);
  const exact = varsExact.get(name);
  let exactLatex = null;
  if (exact !== undefined && !isPlainNumber(exact)) {
    try {
      exactLatex = ce.box(exact, { canonical: false }).latex;
    } catch {
      exactLatex = null;
    }
  }
  const lhs = symbolLatex(name);
  if (exactLatex && exactLatex !== decimal) return `${lhs}=${exactLatex}\\approx ${decimal}`;
  return `${lhs}=${decimal}`;
}

// True for an exact value that's already just a number, like 3, 2.5 or
// 50 - 30i. Showing it next to its own decimal would repeat it.
const PLAIN_NUMBER_HEADS = new Set(["Add", "Subtract", "Negate", "Multiply", "Complex"]);
function isPlainNumber(json) {
  if (typeof json === "number") return true;
  if (typeof json === "string") return json === "ImaginaryUnit" || /^-?\d+(\.\d+)?$/.test(json);
  if (json && typeof json === "object" && !Array.isArray(json) && "num" in json) return true;
  if (Array.isArray(json)) return PLAIN_NUMBER_HEADS.has(json[0]) && json.slice(1).every(isPlainNumber);
  return false;
}

function valueLatex(value) {
  if (Array.isArray(value)) {
    const rows = value.map((row) => row.map(valueLatex).join("&")).join("\\\\");
    return `\\begin{bmatrix}${rows}\\end{bmatrix}`;
  }
  if (value && typeof value === "object") {
    const re = Number(value.re.toPrecision(10));
    const im = Number(value.im.toPrecision(10));
    if (im === 0) return numberLatex(re);
    const imPart = `${Math.abs(im) === 1 ? "" : numberLatex(Math.abs(im))}i`;
    if (re === 0) return `${im < 0 ? "-" : ""}${imPart}`;
    return `${numberLatex(re)}${im < 0 ? "-" : "+"}${imPart}`;
  }
  return numberLatex(Number(value.toPrecision(10)));
}

function numberLatex(n) {
  const [mantissa, exponent] = n.toString().split("e");
  return exponent === undefined ? mantissa : `${mantissa}\\times 10^{${Number(exponent)}}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
