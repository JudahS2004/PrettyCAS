import { getSettings, onSettingsChange } from './settings.js';

const GLYPHS = '0123456789+-=×÷·∑∫√∞ππθλΔ∂∇≈≠≤≥∈∀∃∴'.split('');
const FONT_SIZE = 18;
const FX_ALPHA = 0.8;
// Per-frame multiplicative falloff for anything that fades (matrix glyphs,
// circuit pulse tails). Kept as one shared constant so every effect fades
// at a comparable pace.
const DECAY = 0.92;
const MIN_ALPHA = 0.02;

const canvas = document.getElementById('bg-fx-canvas');
const ctx = canvas.getContext('2d');
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

// getComputedStyle normalizes any valid CSS color (hex, hsl(), a custom
// picker value) to "rgb(r, g, b)", which is the easiest common format to
// re-composite with our own alpha for canvas fillStyle.
const colorProbe = document.createElement('div');
colorProbe.style.display = 'none';
document.body.appendChild(colorProbe);

function toRgb(colorStr, fallback) {
  colorProbe.style.color = colorStr;
  const match = getComputedStyle(colorProbe).color.match(/[\d.]+/g);
  return match ? match.slice(0, 3).map(Number) : fallback;
}

let accentRgb = [79, 91, 255];

function readColors() {
  const styles = getComputedStyle(document.documentElement);
  accentRgb = toRgb(styles.getPropertyValue('--accent').trim(), accentRgb);
}

// Every effect below fades things out by tracking each element's own age in
// JS and recomputing its alpha from scratch every frame, then fully
// clearing the canvas before redrawing — NOT by painting a translucent
// layer over old pixels and letting the canvas itself accumulate a "trail"
// via repeated compositing.
//
// That compositing approach was tried first and looked identical while an
// effect was actively drawing, but never actually finished fading: an 8-bit
// canvas blending a low-alpha color (or eroding its own alpha) over and
// over hits a rounding floor a few shades short of the true target and
// simply stops changing there, permanently — this is genuinely how the
// canvas compositing spec's math resolves at low alpha, so it's not a
// one-off implementation slip. Chromium's floor for this landed low enough
// (~2% opacity) to be invisible in testing, but Firefox's floor was clearly
// visible as the reported "streaks never disappear" grey. Computing alpha
// directly from a tracked age sidesteps the whole class of bug: nothing is
// ever blended against its own previous value, so there's no floor to hit
// in any engine.
function decayedAlpha(age) {
  return FX_ALPHA * Math.pow(DECAY, age);
}

// Each canvas-based effect exposes setup() (rebuild its layout for the
// current canvas size) and frame() (draw one animation tick). Only one runs
// at a time, picked by the "backgroundEffect" setting.

const matrixEffect = {
  columns: [],
  setup() {
    const count = Math.ceil(canvas.width / FONT_SIZE);
    // Staggered negative starting offsets so columns don't all begin in sync.
    this.columns = Array.from({ length: count }, (_, i) => ({
      x: i * FONT_SIZE,
      row: -Math.floor(Math.random() * canvas.height / FONT_SIZE),
      trail: [], // recently-passed glyphs still fading out: { y, glyph, age }
    }));
  },
  frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${FONT_SIZE}px ${getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace'}`;

    for (const col of this.columns) {
      const y = col.row * FONT_SIZE;

      // The newest glyph reads as a bright spark; the trail behind it fades
      // out in accent color — that two-tone leading edge is what makes it
      // read as "rain" instead of a flat wall of colored text.
      ctx.fillStyle = `rgba(255, 255, 255, ${FX_ALPHA})`;
      ctx.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], col.x, y);
      col.trail.push({ y, glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], age: 1 });

      col.trail = col.trail.filter((cell) => {
        const alpha = decayedAlpha(cell.age);
        if (alpha < MIN_ALPHA) return false;
        ctx.fillStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${alpha.toFixed(3)})`;
        ctx.fillText(cell.glyph, col.x, cell.y);
        cell.age++;
        return true;
      });

      if (y > canvas.height && Math.random() > 0.975) col.row = 0;
      col.row++;
    }
  },
};

const CIRCUIT_CELL = 46;
const CIRCUIT_PULSES = 18;
const CIRCUIT_CHIP_DENSITY = 60; // roughly one chip drawn per this many connected nodes
const CIRCUIT_TAIL_STEPS = 3;

const circuitEffect = {
  nodes: [],
  adj: new Map(),
  pulses: [],
  chips: [],
  setup() {
    const cols = Math.ceil(canvas.width / CIRCUIT_CELL) + 1;
    const rows = Math.ceil(canvas.height / CIRCUIT_CELL) + 1;
    const idx = (x, y) => y * cols + x;

    this.nodes = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) this.nodes.push({ x: x * CIRCUIT_CELL, y: y * CIRCUIT_CELL });
    }

    // A sparse maze of node-to-node traces, not a full grid — leaving most
    // edges out is what makes it read as circuitry rather than graph paper.
    this.adj = new Map();
    const link = (a, b) => {
      if (!this.adj.has(a)) this.adj.set(a, []);
      if (!this.adj.has(b)) this.adj.set(b, []);
      this.adj.get(a).push(b);
      this.adj.get(b).push(a);
    };
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x < cols - 1 && Math.random() > 0.4) link(idx(x, y), idx(x + 1, y));
        if (y < rows - 1 && Math.random() > 0.4) link(idx(x, y), idx(x, y + 1));
      }
    }

    // A handful of connected nodes get a small chip-like box drawn over
    // them, so the board reads as populated rather than pure wireframe.
    const connected = [...this.adj.keys()];
    this.chips = [];
    const chipCount = Math.floor(connected.length / CIRCUIT_CHIP_DENSITY);
    for (let i = 0; i < chipCount; i++) {
      this.chips.push(connected[Math.floor(Math.random() * connected.length)]);
    }

    this.pulses = Array.from({ length: CIRCUIT_PULSES }, () => this.spawnPulse()).filter(Boolean);
  },
  spawnPulse() {
    const starts = [...this.adj.keys()];
    if (!starts.length) return null;
    const from = starts[Math.floor(Math.random() * starts.length)];
    const neighbors = this.adj.get(from);
    const to = neighbors[Math.floor(Math.random() * neighbors.length)];
    return { from, to, t: 0, speed: 0.012 + Math.random() * 0.018 };
  },
  frame() {
    // Everything here — traces, vias, chips, pulses — is fully recomputed
    // from stored state every frame, so a plain clear is enough; nothing
    // depends on the canvas itself accumulating a trail.
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Traces
    ctx.strokeStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.18)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const [a, neighbors] of this.adj) {
      for (const b of neighbors) {
        if (b < a) continue; // adjacency is stored both ways; draw each trace once
        const na = this.nodes[a];
        const nb = this.nodes[b];
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(nb.x, nb.y);
      }
    }
    ctx.stroke();

    // Via points at every junction
    ctx.fillStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.3)`;
    for (const a of this.adj.keys()) {
      const n = this.nodes[a];
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Chip components: a small housing plus a few pin ticks on each side.
    ctx.strokeStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.4)`;
    ctx.lineWidth = 1;
    for (const node of this.chips) {
      const n = this.nodes[node];
      const size = 13;
      ctx.strokeRect(n.x - size / 2, n.y - size / 2, size, size);
      ctx.beginPath();
      for (const dy of [-4, 0, 4]) {
        ctx.moveTo(n.x - size / 2 - 4, n.y + dy);
        ctx.lineTo(n.x - size / 2, n.y + dy);
        ctx.moveTo(n.x + size / 2, n.y + dy);
        ctx.lineTo(n.x + size / 2 + 4, n.y + dy);
      }
      ctx.stroke();
    }

    // Traveling pulses: a short fading tail behind a glowing head.
    for (const pulse of this.pulses) {
      const from = this.nodes[pulse.from];
      const to = this.nodes[pulse.to];

      for (let tail = CIRCUIT_TAIL_STEPS; tail >= 1; tail--) {
        const tt = Math.max(0, pulse.t - tail * 0.06);
        const tx = from.x + (to.x - from.x) * tt;
        const ty = from.y + (to.y - from.y) * tt;
        const alpha = FX_ALPHA * (1 - tail / (CIRCUIT_TAIL_STEPS + 1));
        ctx.fillStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(tx, ty, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      const x = from.x + (to.x - from.x) * pulse.t;
      const y = from.y + (to.y - from.y) * pulse.t;
      ctx.save();
      ctx.shadowColor = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.9)`;
      ctx.shadowBlur = 8;
      ctx.fillStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${FX_ALPHA})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      pulse.t += pulse.speed;
      if (pulse.t >= 1) {
        const neighbors = this.adj.get(pulse.to);
        const next = neighbors[Math.floor(Math.random() * neighbors.length)];
        pulse.from = pulse.to;
        pulse.to = next;
        pulse.t = 0;
      }
    }
  },
};

const SPIRAL_ARMS = 3;
const SPIRAL_POINTS_PER_ARM = 160;
// Kept under 1 full turn on purpose: past that, each arm's radius grows so
// little over one revolution that it reads as a near-circle, and stacked
// across 3 arms the whole thing collapses into concentric rings instead of
// a recognizable spiral.
const SPIRAL_TURNS = 0.9;
const SPIRAL_ROTATE_SPEED = 0.0022;
const SPIRAL_CORE_RADIUS = 60;
const SPIRAL_TRAIL_STEPS = 4;
const SPIRAL_TRAIL_GAP = 0.035; // radians between each trailing ghost point

const spiralEffect = {
  arms: [],
  rotation: 0,
  setup() {
    const maxRadius = Math.hypot(canvas.width, canvas.height) / 2;
    this.arms = [];
    for (let arm = 0; arm < SPIRAL_ARMS; arm++) {
      const armOffset = (arm * Math.PI * 2) / SPIRAL_ARMS;
      const points = [];
      for (let i = 0; i < SPIRAL_POINTS_PER_ARM; i++) {
        const t = i / SPIRAL_POINTS_PER_ARM;
        points.push({
          radius: t * maxRadius,
          baseAngle: t * Math.PI * 2 * SPIRAL_TURNS + armOffset,
          fade: 1 - t * 0.7, // outer points dim out instead of hard-stopping
          size: 0.9 + Math.random() * 1.3,
          twinklePhase: Math.random() * Math.PI * 2,
        });
      }
      this.arms.push(points);
    }
    this.rotation = 0;
  },
  frame() {
    // Every point's position is a deterministic function of this.rotation,
    // so a short comet-tail can be drawn explicitly (a few ghost copies at
    // slightly earlier rotation angles) instead of relying on the canvas to
    // accumulate one via a fading overlay.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    this.rotation += SPIRAL_ROTATE_SPEED;

    // Faint stroke along each arm so it reads as a continuous swirl
    // underneath the dots, not a scatter of disconnected points.
    ctx.strokeStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.1)`;
    ctx.lineWidth = 1;
    for (const points of this.arms) {
      ctx.beginPath();
      points.forEach((p, i) => {
        const angle = p.baseAngle + this.rotation;
        const x = cx + p.radius * Math.cos(angle);
        const y = cy + p.radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Soft glow at the core, like a galaxy nucleus.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, SPIRAL_CORE_RADIUS);
    core.addColorStop(0, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.35)`);
    core.addColorStop(1, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, SPIRAL_CORE_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    for (const points of this.arms) {
      for (const p of points) {
        const angle = p.baseAngle + this.rotation;
        const twinkle = 0.5 + 0.5 * Math.sin(angle * 3 + p.radius * 0.01 + p.twinklePhase);
        const baseAlpha = FX_ALPHA * p.fade * twinkle;

        for (let step = SPIRAL_TRAIL_STEPS; step >= 0; step--) {
          const a = angle - step * SPIRAL_TRAIL_GAP;
          const x = cx + p.radius * Math.cos(a);
          const y = cy + p.radius * Math.sin(a);
          const alpha = baseAlpha * decayedAlpha(step) / FX_ALPHA;
          if (alpha < MIN_ALPHA) continue;
          ctx.fillStyle = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  },
};

const CANVAS_EFFECTS = { matrix: matrixEffect, circuit: circuitEffect, spiral: spiralEffect };

let currentEffect = null;
let animationId = null;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  if (currentEffect) currentEffect.setup();
}

function loop() {
  currentEffect.frame();
  animationId = requestAnimationFrame(loop);
}

function startCanvasEffect(effect) {
  if (currentEffect === effect && animationId !== null) return;
  currentEffect = effect;
  resize();
  if (animationId === null) animationId = requestAnimationFrame(loop);
}

function stopCanvasEffect() {
  if (animationId !== null) cancelAnimationFrame(animationId);
  animationId = null;
  currentEffect = null;
}

function applyEffect() {
  // Picking an effect in Settings is explicit user consent, so it's shown
  // even when the OS requests reduced motion — that OS default is for
  // effects the user hasn't opted into, not ones they just asked for.
  const effect = getSettings().backgroundEffect;
  // Same attribute (and element) theme-init.js sets before first paint —
  // keep them in sync so this doesn't fight or flash against that.
  document.documentElement.dataset.bgFx = effect;

  const canvasEffect = CANVAS_EFFECTS[effect];
  if (canvasEffect) {
    // Re-read on every settings change (not just on start) so an accent or
    // theme swap while an effect is already running updates its color live.
    readColors();
    startCanvasEffect(canvasEffect);
  } else {
    stopCanvasEffect();
  }
}

window.addEventListener('resize', () => {
  if (animationId !== null) resize();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCanvasEffect();
  else applyEffect();
});

// The default (no custom color picked) background tracks the OS setting
// directly, with no corresponding settings.js state change to trigger
// onSettingsChange, so this needs its own listener to pick up the colors
// flipping.
darkScheme.addEventListener('change', () => {
  if (!getSettings().background) applyEffect();
});
onSettingsChange(applyEffect);
applyEffect();
