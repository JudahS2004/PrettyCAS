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

export function addEntry(inputLatex, summary) {
  entries = [{ inputLatex, summary, when: new Date().toLocaleTimeString() }, ...entries].slice(0, MAX_ENTRIES);
  save();
  render();
}

export function clearHistory() {
  entries = [];
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
        <div class="history-in">${escapeHtml(entry.inputLatex)}</div>
        <div class="history-out">${escapeHtml(entry.summary)} · ${entry.when}</div>
      </div>`
    )
    .join("");

  listEl.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", () => {
      const entry = entries[Number(el.dataset.index)];
      if (entry && onReuse) onReuse(entry.inputLatex);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
