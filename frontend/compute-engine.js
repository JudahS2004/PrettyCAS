import { ComputeEngine } from './node_modules/@cortex-js/compute-engine/dist/esm-min/compute-engine.js';

// Shared by app.js and plot.js — both `math-field`s on the page need to
// point at the same engine instance, and ES module caching gives that for
// free (every importer gets this same already-constructed `ce`) as long as
// each imports './node_modules/mathlive/mathlive.min.mjs' first, since this
// depends on globalThis.MathfieldElement already existing.
export const ce = new ComputeEngine();
// f/g/h are the conventional "unknown function" letters (f(x), f'(x), ODEs
// in f, ...) — also the only names a workspace function definition
// ("f(x) = x^2 + 1", see workspace.js/app.js) can use. Without declaring
// them, compute-engine has no way to know "f" names a function rather than
// a variable, so "f(x)" parses as implicit multiplication (f * x) instead
// of function application — silently dropping exactly the calculus
// problems this app is for. Other letters (a, b, k, ...) are left alone so
// "a(b+c)" still means multiplication.
export const USER_FUNCTION_NAMES = ['f', 'g', 'h'];
ce.declare(Object.fromEntries(USER_FUNCTION_NAMES.map((name) => [name, 'function'])));
globalThis.MathfieldElement.computeEngine = ce;

// Every canonicalization pass except "Divide". Compute-engine's default
// "Divide" pass includes a "1/a = a^-1" rule that, for a non-integer decimal
// like 3.3487, eagerly computes a numeric reciprocal at its default 21-digit
// precision (e.g. "1/3.3487" becomes a rounded {num: "0.298623...458297"}
// literal) — a fixed-precision approximation computed and baked in before
// the expression ever reaches sympy's exact arithmetic backend. Dropping
// just this pass leaves that kind of division as a plain ["Divide", 1,
// 3.3487] node instead, which the backend turns into an exact fraction; the
// other passes (integer/whole-number folding, "2x" -> Multiply(2,x), sum/
// product ordering, etc.) are all still needed and stay on.
export const PARSE_CANONICAL = ['InvisibleOperator', 'Number', 'Multiply', 'Add', 'Power', 'Flatten', 'Order'];
