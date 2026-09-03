// Headless-Chromium end-to-end smoke tests, driven with puppeteer-core
// (already vendored in node_modules — no new dependency) against a real,
// already-running backend instance. Run via scripts/test.sh, which starts
// that backend on an ephemeral port and passes it here as PRETTYCAS_BASE_URL
// — this file never starts or stops the server itself, so it can also be
// pointed at an already-running `python backend/app.py` for a quick manual
// check: PRETTYCAS_BASE_URL=http://127.0.0.1:5000 node --test frontend/tests
//
// Uses node:test/node:assert (built in, Node 18+) rather than a separate
// test framework — this project has no JS test runner installed yet and
// didn't need one just for this.
//
// MathLive's custom element doesn't reliably receive Puppeteer's simulated
// `.type()` keystrokes headless (confirmed live this session) — every input
// helper below sets `mf.value` directly and dispatches a real
// KeyboardEvent('keydown', {key:'Enter'}) on the field instead, which is
// what actually reaches app.js's own 'keydown' listener.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

const BASE_URL = process.env.PRETTYCAS_BASE_URL || 'http://127.0.0.1:5099';
const CHROMIUM_PATH = process.env.PRETTYCAS_CHROMIUM || '/usr/bin/chromium';

let browser;

before(async () => {
  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: 'new',
    args: ['--no-sandbox'],
  });
});

after(async () => {
  await browser.close();
});

async function openPage() {
  const page = await browser.newPage();
  const consoleErrors = [];
  const networkErrors = [];
  page.on('console', (msg) => {
    // Chrome logs a generic "Failed to load resource: ..." console error
    // for every failed network request, with no URL in the text to filter
    // on (unlike the 'response' listener below, which does have the URL
    // and is what actually excludes the known, pre-existing favicon.ico
    // 404). Skipped here rather than pattern-matched by status code, since
    // a real broken import path — exactly the kind of regression this
    // suite exists to catch — would log this same generic text: it's
    // caught instead by networkErrors (URL-filtered) and by the pageerror
    // a broken module import throws when its dependents try to use it.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:')) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().endsWith('/favicon.ico')) {
      networkErrors.push(`HTTP ${res.status()} ${res.url()}`);
    }
  });
  await page.goto(BASE_URL + '/', { waitUntil: 'networkidle0', timeout: 30000 });
  return { page, consoleErrors, networkErrors };
}

// Sets the compute field's LaTeX and presses Enter, the same way a real
// Enter keypress does (see app.js's mf.addEventListener('keydown', ...)).
async function computeEnter(page, latex) {
  await page.evaluate((value) => {
    const mf = document.getElementById('mf');
    mf.value = value;
    mf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }, latex);
  await new Promise((resolve) => setTimeout(resolve, 800));
}

async function outputText(page) {
  return page.$eval('#output-render', (el) => el.textContent);
}

test('page loads with no console or network errors', async () => {
  const { page, consoleErrors, networkErrors } = await openPage();
  try {
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(networkErrors, []);
  } finally {
    await page.close();
  }
});

test('theme-init sets the background-effect attribute before first paint', async () => {
  const { page } = await openPage();
  try {
    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-bg-fx'));
    // Default is "matrix" (see settings.js's DEFAULTS.backgroundEffect) —
    // any non-null value confirms theme/theme-init.js actually ran from its
    // new path, not just that the attribute is absent/undefined.
    assert.ok(attr, 'expected data-bg-fx to be set by theme-init.js');
  } finally {
    await page.close();
  }
});

test('basic compute round-trips through /api/compute', async () => {
  const { page } = await openPage();
  try {
    await computeEnter(page, '2+2');
    const text = await outputText(page);
    assert.match(text, /\b4\b/);
  } finally {
    await page.close();
  }
});

test('workspace assignment reuses its own saved value in a later equation', async () => {
  // Regression test for this session's fix: "x = 2" saves x; retyping
  // "x = y + 4" should solve using x's saved value (2 = y + 4 -> y = -2)
  // instead of stripping x and echoing the equation back unsolved. See
  // app.js's isRealAssignment / PROJECT_SUMMARY's writeup of this bug.
  const { page } = await openPage();
  try {
    await computeEnter(page, 'x=2');
    const workspaceNames = await page.$$eval('#workspace .history-in', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(workspaceNames.includes('x'), `expected x in workspace, got: ${workspaceNames}`);

    await computeEnter(page, 'x=y+4');
    const text = await outputText(page);
    assert.match(text, /-2/);
  } finally {
    await page.close();
  }
});

test('assignment with an integral RHS saves to a fresh name', async () => {
  // Regression test: compute-engine's own .unknowns/.freeVariables getters
  // wrongly report an \int's own bound variable as free (confirmed live via
  // direct Node tests against the bundled package), which made
  // isRealAssignment false for any assignment whose RHS contains an
  // integral/sum/product/limit — so "Z = \int_2^{400}x\,dx" computed the
  // right answer but never saved it. See app.js's freeSymbolsOf/
  // boundVariableNames and PROJECT_SUMMARY's writeup of this bug.
  const { page } = await openPage();
  try {
    await computeEnter(page, 'Z=\\int_2^{400}xdx');
    const workspaceNames = await page.$$eval('#workspace .history-in', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(workspaceNames.includes('Z'), `expected Z in workspace, got: ${workspaceNames}`);
  } finally {
    await page.close();
  }
});

test('reassigning an already-saved name with an integral RHS reassigns instead of returning false', async () => {
  // Companion regression test: with the bug above, "A = <integral>" while A
  // was already saved substituted A's *old* value back in (isRealAssignment
  // false meant A wasn't stripped from constants), turning the reassignment
  // into a true/false equality check of the old value against the new one.
  const { page } = await openPage();
  try {
    await computeEnter(page, 'A=3');
    await computeEnter(page, 'A=\\int_2^{400}xdx');
    const text = await outputText(page);
    assert.doesNotMatch(text, /\bfalse\b/i);
    const workspaceValues = await page.$$eval('#workspace .history-out', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(!workspaceValues.includes('3'), `expected A's saved value to change from 3, got: ${workspaceValues}`);
  } finally {
    await page.close();
  }
});

test('a matrix can be saved to the workspace and reused', async () => {
  // Regression test for this session's matrix-workspace feature: a matrix
  // assignment used to come back as a plain "false" check (sp.Eq(Symbol,
  // Matrix) auto-evaluates to BooleanFalse in sympy) instead of ever saving.
  // See PROJECT_SUMMARY's "Matrix workspace variables" writeup.
  const { page } = await openPage();
  try {
    await computeEnter(page, 'M=\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}');
    const workspaceNames = await page.$$eval('#workspace .history-in', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(workspaceNames.includes('M'), `expected M in workspace, got: ${workspaceNames}`);
    const workspaceValues = await page.$$eval('#workspace .history-out', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(workspaceValues.some((v) => v.includes('1') && v.includes('4')), `expected M's value shown, got: ${workspaceValues}`);

    await computeEnter(page, '\\det M');
    const text = await outputText(page);
    assert.match(text, /-2/);
  } finally {
    await page.close();
  }
});

test('a bracket-style matrix transpose computes correctly', async () => {
  // Regression test for this session's fix: user-reported
  // \operatorname{Transpose}{(...)} on a \left[...\right]-bracketed matrix
  // literal — parses identically to A^T, both to a ["Transpose", ...]
  // MathJSON node — errored outright ("takes 1 positional argument but 2
  // were given"), because a bracket/bmatrix literal (unlike \begin{pmatrix})
  // carries an extra delimiter-style marker arg and an outer List wrapper
  // neither of which the old OPS["Matrix"]/to_sympy handled. See
  // PROJECT_SUMMARY's "bracket-style matrix" writeup for the full root
  // cause — not actually specific to Transpose.
  const { page } = await openPage();
  try {
    await computeEnter(page, '\\operatorname{Transpose}{\\left(\\left[\\begin{matrix}1 & 2\\\\3 & 4\\end{matrix}\\right]\\right)}');
    const text = await outputText(page);
    assert.match(text, /\bmode.*evaluate\b|"mode":\s*"evaluate"/, `expected a successful evaluate, got: ${text}`);
    assert.doesNotMatch(text, /"mode":\s*"error"/, `expected no error, got: ${text}`);
  } finally {
    await page.close();
  }
});

test('a workspace constant keeps its exact form, not just a rounded decimal', async () => {
  // Regression test for this session's fix: "rho = 1/sqrt(2)" used to cache
  // only a 17-significant-digit decimal (compute.py's _numeric_value),
  // reconstructed on reuse as an exact-but-ugly ~16-digit Rational
  // (sympify_constant's str(float)->Rational) rather than the clean
  // sqrt(2)/2 rho actually is. Squaring it in a later input compounded that
  // into a ~31-digit Rational instead of simplifying to 1/2 — user-reported
  // live as "e^(rho^2)" hanging/showing garbage in "Factor" mode (see the
  // "Factor" simplify-mode fix above) and, separately, as just an ugly
  // answer even outside Factor mode. Fixed via _exact_mathjson: the backend
  // now also hands back the exact symbolic form of a resolved value, and
  // app.js/workspace.js cache that instead of/alongside the decimal.
  const { page } = await openPage();
  try {
    await computeEnter(page, '\\rho=\\frac{1}{\\sqrt{2}}');
    const workspaceNames = await page.$$eval('#workspace .history-in', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(workspaceNames.includes('rho'), `expected rho in workspace, got: ${workspaceNames}`);

    await computeEnter(page, 'e^{\\rho^2}');
    const text = await outputText(page);
    // A regression here shows up as a huge decimal-derived fraction (~31
    // digits on either side of a "/") instead of the clean exp(1/2) — check
    // for that specific shape rather than "any long run of digits", since
    // the panel's own debug dump legitimately includes a 17-significant-
    // digit `numeric` field even for this correct result.
    assert.doesNotMatch(text, /\d{10,}\s*\/\s*\d{10,}/, `expected no huge ugly fraction, got: ${text}`);
    assert.match(text, /exp\(1\/2\)/, `expected the clean exp(1/2) result, got: ${text}`);
  } finally {
    await page.close();
  }
});

test('switching to Plot and Help views loads their modules with no errors', async () => {
  const { page, consoleErrors, networkErrors } = await openPage();
  try {
    await page.click('a[data-view="plot"]');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await page.click('a[data-view="help"]');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(networkErrors, []);
  } finally {
    await page.close();
  }
});
