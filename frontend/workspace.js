// The session workspace: "a = 3" remembers a for later inputs ("a + 2"),
// the same way a REPL variable would. "f(x) = x^2 + 1" does the same for a
// function definition — later inputs can call f(3), differentiate it,
// plot it, and so on. Deliberately in-memory only — unlike history, it's
// not read from or written to localStorage, so it starts empty every
// launch instead of carrying values over from a past session.

let vars = new Map();
// name -> { params: [string, ...], mathjson: <body mathjson>, latex: <body latex, display-only> }
let funcs = new Map();

// { name: value } for every stored variable, for sending along as the
// "constants" a computation should substitute in (mirrors the shape a
// plot row's slider constants already use for /api/sample).
export function getWorkspace() {
  return Object.fromEntries(vars);
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

export function setVar(name, value) {
  vars.set(name, value);
  render();
}

export function setFunction(name, params, mathjson, latex) {
  funcs.set(name, { params, mathjson, latex });
  render();
}

export function clearWorkspace() {
  vars.clear();
  funcs.clear();
  render();
}

function deleteVar(name) {
  vars.delete(name);
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
// display.
function formatValue(value) {
  return Number(value.toPrecision(10)).toString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
