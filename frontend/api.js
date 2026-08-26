// Relative, not an absolute localhost:5000 URL — the Flask backend now
// serves this frontend itself (same origin), on whatever port it's running
// on, so there's nothing to hardcode.
const BASE = "/api";

async function post(path, body, signal) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`request failed (${response.status}): ${text}`);
  }

  return response.json();
}

// `signal` (an AbortSignal) is optional — callers that want to cancel a
// stale request in flight (e.g. the compute page dropping a slow request
// when the field is cleared or edited again before it resolves) pass one;
// omitting it just means this fetch can't be cancelled early.
export async function computeMathJson(mathjson, settings, extra = {}, signal) {
  return post("/compute", {
    mathjson,
    angle_mode: settings.angleMode,
    // Always the real value, even in Standard mode — number_format alone
    // tells the backend whether to apply it. Sending it unconditionally is
    // what lets the backend hand back Standard/Decimal/Engineering results
    // together in one `formats` bundle (see app.js's use of it), so flipping
    // that toggle client-side doesn't need a fresh request at all.
    decimals: settings.decimals,
    simplify_mode: settings.simplifyMode,
    number_format: settings.numberFormat,
    engine_preference: settings.enginePreference,
    ...extra,
  }, signal);
}

// Whether the backend has Maxima available as a fallback integration
// engine — settings.js uses this once at startup to grey out that choice
// rather than let it be picked and silently no-op. Never throws: a request
// this basic failing at all means something's badly wrong with the backend
// connection, which every other feature is about to discover anyway, so
// there's no point this one call reporting it differently — it just quietly
// resolves to "not available" and lets the rest of the app surface the
// real problem.
export async function getCapabilities() {
  try {
    const response = await fetch(`${BASE}/capabilities`);
    if (!response.ok) return { maxima_available: false };
    return await response.json();
  } catch {
    return { maxima_available: false };
  }
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
