import '../node_modules/mathlive/mathlive.min.mjs';
import { convertLatexToMarkup } from '../node_modules/mathlive/mathlive.min.mjs';
import { computeMathJson } from '../api.js';
import { getSettings } from '../settings.js';

// Every example here has actually been run through the real parser and
// backend — not guessed at (each carries its own verified MathJSON rather
// than being re-parsed client-side, so this page doesn't depend on the
// exact same parse happening twice). Compute-tagged examples show their
// real, live result underneath, fetched from the backend on load — not
// hardcoded, so it can't quietly drift out of sync with what the app
// actually returns.
const SECTIONS = [
  {
    page: 'Compute',
    title: 'Arithmetic & simplifying',
    examples: [
      { latex: '2^{10}+\\sqrt{16}', mathjson: 1028, note: 'Evaluates directly.' },
      { latex: '\\frac{3}{4}+\\frac{1}{6}', mathjson: ['Rational', 11, 12], note: 'Exact fractions by default. Switch to Decimal for a numeric approximation.' },
      { latex: '(x+1)^3', mathjson: ['Power', ['Add', 'x', 1], 3], note: '"Auto" leaves this factored; the Expand/Factor toggle forces it either way.' },
    ],
  },
  {
    page: 'Compute',
    title: 'Trig & hyperbolic functions',
    examples: [
      { latex: '\\sin^{-1}\\left(\\frac{1}{2}\\right)', mathjson: ['Arcsin', ['Rational', 1, 2]], note: 'Also written arcsin(x). Degrees mode converts the result too.' },
      { latex: '\\sinh(x)+\\cosh(x)', mathjson: ['Add', ['Sinh', 'x'], ['Cosh', 'x']], note: 'sinh, cosh, tanh, their reciprocals (csch, sech, coth), and inverses (sinh⁻¹, cosh⁻¹, tanh⁻¹, …) are all supported.' },
    ],
  },
  {
    page: 'Compute',
    title: 'Solving equations',
    examples: [
      { latex: 'x^2-5x+6=0', mathjson: ['Equal', ['Add', ['Power', 'x', 2], ['Multiply', -5, 'x'], 6], 0], note: 'Solves for the one variable present.' },
      { latex: '\\sin(x)=\\frac{1}{2}', mathjson: ['Equal', ['Sin', 'x'], ['Rational', 1, 2]], note: 'Closed-form solutions where they exist.' },
    ],
  },
  {
    page: 'Compute',
    title: 'Systems of equations',
    examples: [
      { latex: '\\{x+y=5,\\ x-y=1\\}', mathjson: ['Set', ['Equal', ['Add', 'x', 'y'], 5], ['Equal', ['Add', 'x', ['Negate', 'y']], 1]], note: 'Curly braces solve as a system (the "cases" keyboard template works the same way).' },
      { latex: '\\{x^2+y^2=25,\\ x=y+1\\}', mathjson: ['Set', ['Equal', ['Add', ['Power', 'x', 2], ['Power', 'y', 2]], 25], ['Equal', 'x', ['Add', 'y', 1]]], note: 'Nonlinear systems too. Returns every solution branch.' },
      { latex: '\\{x+y=9,\\ x-y=3,\\ x\\}', mathjson: ['Set', ['Equal', ['Add', 'x', 'y'], 9], ['Equal', ['Add', 'x', ['Negate', 'y']], 3], 'x'], note: 'A bare variable in the set shows just that one value.' },
      { latex: '\\{x+y=9,\\ x\\}', mathjson: ['Set', ['Equal', ['Add', 'x', 'y'], 9], 'x'], note: 'Works for a single equation too. Rearranges to give x in terms of y.' },
    ],
  },
  {
    page: 'Compute',
    title: 'Inequalities',
    examples: [
      { latex: 'x^2>4', mathjson: ['Less', 4, ['Power', 'x', 2]], note: 'Solves to an interval, or a union of intervals.' },
      { latex: '1<x<5', mathjson: ['Less', 1, 'x', 5], note: 'Chained comparisons work too.' },
      { latex: 'x\\ne2', mathjson: ['NotEqual', 'x', 2], note: null },
    ],
  },
  {
    page: 'Compute',
    title: 'Derivatives',
    examples: [
      { latex: '\\frac{d}{dx}x^3\\sin(x)', mathjson: ['D', ['Multiply', ['Sin', 'x'], ['Power', 'x', 3]], 'x'], note: 'Standard Leibniz notation.' },
      { latex: "f''(x)", mathjson: ['Apply', ['Derivative', 'f', 2], 'x'], note: 'Prime notation on a function call. f stays abstract.' },
    ],
  },
  {
    page: 'Compute',
    title: 'Integrals',
    examples: [
      { latex: '\\int x^2\\,dx', mathjson: ['Integrate', ['Function', ['Block', ['Power', 'x', 2]], 'x'], ['Limits', 'x', 'Nothing', 'Nothing']], note: 'Indefinite. Includes the "+ C".' },
      { latex: '\\int_0^1 x^2\\,dx', mathjson: ['Integrate', ['Function', ['Block', ['Power', 'x', 2]], 'x'], ['Limits', 'x', 0, 1]], note: 'Definite, with bounds.' },
    ],
  },
  {
    page: 'Compute',
    title: 'Limits, sums & products',
    examples: [
      { latex: '\\lim_{x\\to0}\\frac{\\sin(x)}{x}', mathjson: ['Limit', ['Function', ['Block', ['Divide', ['Sin', 'x'], 'x']], 'x'], 0], note: null },
      { latex: '\\sum_{n=1}^{\\infty}\\frac{1}{n^2}', mathjson: ['Sum', ['Power', 'n', -2], ['Limits', 'n', 1, 'PositiveInfinity']], note: 'Closed form when one exists.' },
      { latex: '\\prod_{n=1}^{5}n', mathjson: ['Product', 'n', ['Limits', 'n', 1, 5]], note: null },
    ],
  },
  {
    page: 'Compute',
    title: 'Complex numbers',
    examples: [
      { latex: '\\cos(2+i)', mathjson: ['Cos', ['Complex', 2, 1]], note: 'Expands into a+bi form using cosh/sinh.' },
      { latex: 'i^2', mathjson: ['Power', ['Complex', 0, 1], 2], note: null },
    ],
  },
  {
    page: 'Compute',
    title: 'Matrices',
    examples: [
      { latex: '\\det\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}', mathjson: ['Determinant', ['Matrix', ['List', ['List', 1, 2], ['List', 3, 4]]]], note: null },
      { latex: '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}^{-1}', mathjson: ['Inverse', ['Matrix', ['List', ['List', 1, 2], ['List', 3, 4]]]], note: null },
      { latex: 'X\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}=\\begin{pmatrix}5&6\\\\7&8\\end{pmatrix}', mathjson: ['Equal', ['Multiply', 'X', ['Matrix', ['List', ['List', 1, 2], ['List', 3, 4]]]], ['Matrix', ['List', ['List', 5, 6], ['List', 7, 8]]]], note: 'Solves for an unknown matrix X by inversion. X must be a bare name multiplied against a literal matrix.' },
    ],
  },
  {
    page: 'Compute',
    title: 'Differential equations',
    examples: [
      { latex: "y'(x)=y(x)", mathjson: ['Equal', ['Apply', ['Derivative', 'y', 1], 'x'], ['y', 'x']], note: 'Prime on a function call, not a bare variable. y\'\'+y=0 alone isn\'t recognized as calculus.' },
      { latex: "y''(x)+y(x)=0", mathjson: ['Equal', ['Add', ['y', 'x'], ['Apply', ['Derivative', 'y', 2], 'x']], 0], note: 'Second-order works too.' },
      { latex: "\\{f'(x)=g(x),\\ g'(x)=-f(x)\\}", mathjson: ['Set', ['Equal', ['Apply', ['Derivative', 'f', 1], 'x'], ['g', 'x']], ['Equal', ['Apply', ['Derivative', 'g', 1], 'x'], ['Negate', ['f', 'x']]]], note: 'Systems of ODEs work too, wrapped in { } like a system of equations.' },
    ],
  },
  {
    page: 'Plot',
    title: 'Functions',
    examples: [
      { latex: 'x^2', note: 'A bare expression plots as a function of its one variable.' },
      { latex: '\\sin(x)\\cos(y)', note: 'Two variables switches the row to a 3D surface automatically.' },
      { latex: 'x^2+y^2=25', note: 'Implicit equations get solved and plotted as a curve.' },
    ],
  },
  {
    page: 'Plot',
    title: 'Constants & reference lines',
    examples: [
      { latex: 'c=2', note: 'Becomes a slider. Reference it from other rows, e.g. "c·x".' },
      { latex: 'x=4', note: '"x = " or "y = " a number draws a reference line instead of becoming a slider.' },
    ],
  },
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let exampleId = 0;

function renderSections() {
  const container = document.getElementById('help-sections');
  container.innerHTML = SECTIONS.map((section) => `
    <div class="panel help-section">
      <div class="help-section-heading">
        <h2>${escapeHtml(section.title)}</h2>
        <span class="badge">${escapeHtml(section.page)}</span>
      </div>
      <div class="help-examples">
        ${section.examples.map((ex) => {
          ex._domId = `help-result-${exampleId++}`;
          return `
          <div class="help-example">
            <div class="help-example-math">${convertLatexToMarkup(ex.latex)}</div>
            ${ex.note ? `<div class="help-example-note">${escapeHtml(ex.note)}</div>` : ''}
            ${section.page === 'Compute' ? `
              <div class="help-example-result" id="${ex._domId}">
                <span class="placeholder">Computing…</span>
              </div>
            ` : ''}
          </div>
        `;
        }).join('')}
      </div>
    </div>
  `).join('');

  const settings = getSettings();
  for (const section of SECTIONS) {
    if (section.page === 'Compute') section.examples.forEach((ex) => computeExample(ex, settings));
  }
}

// A trimmed-down version of the Compute page's own result rendering — only
// the shapes these curated examples actually return (evaluate/solve/ode
// with a .latex, or multiple solutions via .latexParts) need handling.
function exampleResultMarkup(response) {
  if (response.mode === 'error') return `<span class="help-result-error">${escapeHtml(response.result)}</span>`;
  if (Array.isArray(response.latexParts) && response.latexParts.length > 1) {
    return response.latexParts.map((part) => convertLatexToMarkup(part)).join('<span class="help-result-sep">,</span> ');
  }
  if (response.latex) return convertLatexToMarkup(response.latex);
  if (Array.isArray(response.result)) return escapeHtml(response.result.join(', ') || '(no solution)');
  return escapeHtml(String(response.result));
}

async function computeExample(ex, settings) {
  const el = document.getElementById(ex._domId);
  if (!el) return;
  try {
    const response = await computeMathJson(ex.mathjson, settings);
    el.innerHTML = exampleResultMarkup(response);
  } catch {
    el.innerHTML = `<span class="placeholder">Couldn't reach the compute backend. Is it running?</span>`;
  }
}

export function mount() {
  customElements.whenDefined('math-field').then(renderSections);
}
