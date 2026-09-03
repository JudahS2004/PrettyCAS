// The session workspace: "a = 3" remembers a for later inputs ("a + 2"),
// the same way a REPL variable would. "f(x) = x^2 + 1" does the same for a
// function definition — later inputs can call f(3), differentiate it,
// plot it, and so on. Deliberately in-memory only — unlike history, it's
// not read from or written to localStorage, so it starts empty every
// launch instead of carrying values over from a past session.

let vars = new Map();
// name -> exact MathJSON tree for that variable's value, when the backend
// could derive one (see compute.py's _exact_mathjson) — e.g. sqrt(2)/2, not
// a decimal approximation of it. Absent for a name whose value has no exact
// form (a genuine irrational-looking Float) or came from the evalNumeric
// fallback rather than the backend. Kept as a second map, entirely separate
// from `vars`, so the display path (render()/formatValue() below, both
// still reading `vars` directly) never has to know this exists.
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
    listEl.innerHTML = `<p class="empty-note">Nothing yet — try "a = 3" or "f(x) = x^2".</p>`;
    return;
  }
  const varItems = [...vars.entries()].map(
    ([name, value]) => itemMarkup(name, formatValue(value), "var", name, "variable")
  );
  const funcItems = [...funcs.entries()].map(
    ([name, def]) => itemMarkup(`${name}(${def.params.join(", ")})`, def.latex, "func", name, "function")
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

function itemMarkup(label, value, kind, name, deleteTitle) {
  return `
    <div class="history-item workspace-item">
      <div class="history-item-body">
        <div class="history-in">${escapeHtml(label)}</div>
        <div class="history-out">${escapeHtml(value)}</div>
      </div>
      <button type="button" class="item-delete" data-name="${escapeHtml(name)}" data-kind="${kind}" title="Delete ${deleteTitle}" aria-label="Delete ${deleteTitle}">&times;</button>
    </div>`;
}

// Full double precision is kept in `vars` (so it stays as accurate as
// possible when reused in later computations) — this is just a readable
// display rounding for the panel, same idea as the plot page's slider value
// display. A complex assignment ("X = 50 - 30i") caches app.js's compiled
// {re, im} shape here rather than a plain number — see evalNumeric's own
// comment in app.js — so this needs its own a+bi rendering instead of
// assuming every stored value has a .toPrecision(). A matrix assignment
// ("M = [[1,2],[3,4]]") caches compute.py's own {"numeric"} shape (see its
// comment) — a plain nested array of rows, each cell itself either shape
// above — so that has to be told apart from a complex {re, im} object
// before reaching the object branch below, since Array.isArray is also
// `typeof value === 'object'`. Rendered MATLAB-style ("[1 0;0 1]") rather
// than as a bracketed/comma'd JS array literal — compact enough for the
// workspace panel's single-line row, no rendering (MathLive, KaTeX, ...)
// needed for it.
function formatValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((row) => row.map(formatValue).join(' ')).join(';')}]`;
  }
  if (value && typeof value === 'object') {
    const re = Number(value.re.toPrecision(10));
    const im = Number(value.im.toPrecision(10));
    const sign = im < 0 ? '-' : '+';
    return `${re} ${sign} ${Math.abs(im)}i`;
  }
  return Number(value.toPrecision(10)).toString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
