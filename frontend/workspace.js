// The session workspace: "a = 3" remembers a for later inputs ("a + 2"),
// the same way a REPL variable would. Deliberately in-memory only — unlike
// history, it's not read from or written to localStorage, so it starts
// empty every launch instead of carrying values over from a past session.

let vars = new Map();

// { name: value } for every stored variable, for sending along as the
// "constants" a computation should substitute in (mirrors the shape a
// plot row's slider constants already use for /api/sample).
export function getWorkspace() {
  return Object.fromEntries(vars);
}

export function setVar(name, value) {
  vars.set(name, value);
  render();
}

export function clearWorkspace() {
  vars.clear();
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
  if (vars.size === 0) {
    listEl.innerHTML = `<p class="empty-note">Nothing yet — try "a = 3".</p>`;
    return;
  }
  listEl.innerHTML = [...vars.entries()]
    .map(
      ([name, value]) => `
      <div class="history-item workspace-item">
        <div class="history-in">${escapeHtml(name)}</div>
        <div class="history-out">${escapeHtml(formatValue(value))}</div>
      </div>`
    )
    .join("");
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
