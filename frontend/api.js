// Relative, not an absolute localhost:5000 URL — the Flask backend now
// serves this frontend itself (same origin), on whatever port it's running
// on, so there's nothing to hardcode.
const BASE = "/api";

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`request failed (${response.status}): ${text}`);
  }

  return response.json();
}

export async function computeMathJson(mathjson, settings, extra = {}) {
  return post("/compute", {
    mathjson,
    angle_mode: settings.angleMode,
    decimals: settings.numberFormat === "standard" ? null : settings.decimals,
    simplify_mode: settings.simplifyMode,
    number_format: settings.numberFormat,
    ...extra,
  });
}

// Evaluates an expression over a domain on the Python/sympy+numpy backend —
// the actual numeric math for plotting lives there, not in the browser.
// `kind: "curve"` samples one variable over `domain`; `kind: "surface"`
// samples two over `domainX`/`domainY` on a resolution x resolution grid.
export async function sampleMathJson(mathjson, settings, params) {
  return post("/sample", { mathjson, angle_mode: settings.angleMode, ...params });
}

// Renders the whole plot server-side (matplotlib) for a real vector export —
// svg/pdf/eps come back as actual vector graphics, not a rasterized canvas
// snapshot. Returns a Blob for the caller to save.
export async function exportPlot(payload, settings) {
  const response = await fetch(`${BASE}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ angle_mode: settings.angleMode, ...payload }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`request failed (${response.status}): ${text}`);
  }

  return response.blob();
}
