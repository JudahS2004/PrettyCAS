import { convertLatexToMarkup } from "./node_modules/mathlive/mathlive.min.mjs";

const STORAGE_KEY = "mathstuff2.history";
const MAX_ENTRIES = 50;

let entries = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function save() {
  // Same tolerance as load(): a write failure just means history won't
  // persist, not that addEntry() throws and never renders the new entry.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore
  }
}

// `resultLatex` is the rendered result, when there is one. `summary` is the
// plain-text fallback (errors, and entries saved before resultLatex existed).
export function addEntry(inputLatex, summary, resultLatex = null) {
  entries = [{ inputLatex, summary, resultLatex, when: new Date().toLocaleTimeString() }, ...entries].slice(0, MAX_ENTRIES);
  save();
  render();
}

export function clearHistory() {
  entries = [];
  save();
  render();
}

function deleteEntry(index) {
  entries = entries.filter((_, i) => i !== index);
  save();
  render();
}

// Wires the <details class="history"> block in the page: renders existing
// entries, wires the Clear button, and calls `onReuse(inputLatex)` when a
// past entry is clicked.
let listEl = null;
let onReuse = null;

export function mountHistory(detailsEl, reuseCallback) {
  listEl = detailsEl.querySelector(".history-list");
  onReuse = reuseCallback;
  detailsEl.querySelector("#clear-history")?.addEventListener("click", clearHistory);
  render();
}

function render() {
  if (!listEl) return;
  if (entries.length === 0) {
    listEl.innerHTML = `<p class="empty-note">Nothing yet.</p>`;
    return;
  }
  listEl.innerHTML = entries
    .map(
      (entry, i) => `
      <div class="history-item" data-index="${i}">
        <div class="history-item-body">
          <div class="history-in history-math">${mathMarkup(entry.inputLatex)}</div>
          <div class="history-out">
            ${entry.resultLatex ? `<span class="history-math">${mathMarkup(entry.resultLatex)}</span>` : escapeHtml(entry.summary)}
            <span class="history-when">${entry.when}</span>
          </div>
        </div>
        <button type="button" class="item-delete" data-index="${i}" title="Delete entry" aria-label="Delete entry">&times;</button>
      </div>`
    )
    .join("");

  listEl.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", (event) => {
      const deleteBtn = event.target.closest(".item-delete");
      if (deleteBtn) {
        event.stopPropagation();
        deleteEntry(Number(deleteBtn.dataset.index));
        return;
      }
      const entry = entries[Number(el.dataset.index)];
      if (entry && onReuse) onReuse(entry.inputLatex);
    });
  });
}

function mathMarkup(latex) {
  try {
    return convertLatexToMarkup(latex);
  } catch {
    return escapeHtml(latex);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
