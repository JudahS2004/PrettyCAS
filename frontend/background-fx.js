import { getSettings, onSettingsChange } from './settings.js';

const GLYPHS = '0123456789+-=×÷·∑∫√∞ππθλΔ∂∇≈≠≤≥∈∀∃∴'.split('');
const FONT_SIZE = 18;
const FX_ALPHA = 0.8;
// Per-frame multiplicative falloff for anything that fades (matrix glyphs,
// spiral trails). Kept as one shared constant so every effect fades at a
// comparable pace.
const DECAY = 0.92;
const MIN_ALPHA = 0.02;

function mod(n, m) {
  return ((n % m) + m) % m;
}

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
let secondaryRgb = [138, 91, 255];

function readColors() {
  const styles = getComputedStyle(document.documentElement);
  accentRgb = toRgb(styles.getPropertyValue('--accent').trim(), accentRgb);
  secondaryRgb = toRgb(styles.getPropertyValue('--accent-secondary').trim(), secondaryRgb);
}

// Multiplier applied to every effect's per-frame motion (fall speed, drift,
// rotation), driven by the "Animation speed" setting. Re-read whenever
// settings change rather than every frame, since it only ever changes then.
let speedMultiplier = 1;

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

      // The newest glyph reads as a bright spark in the secondary accent;
      // the trail behind it fades out in the primary accent — that two-tone
      // leading edge is what makes it read as "rain" instead of a flat wall
      // of colored text.
      ctx.fillStyle = `rgba(${secondaryRgb[0]}, ${secondaryRgb[1]}, ${secondaryRgb[2]}, ${FX_ALPHA})`;
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
      col.row += speedMultiplier;
    }
  },
};

// A retro synthwave/outrun scene: a sun sitting on the horizon behind a
// couple of jagged mountain silhouettes, above a perspective floor grid that
// endlessly scrolls toward the viewer. Everything is still derived purely
// from --accent (no hardcoded neon palette) so it stays in step with
// whatever theme is active, the same rule every other effect here follows.
const SYNTH_HORIZON_RATIO = 0.52; // fraction down the canvas where the horizon sits
const SYNTH_SUN_RADIUS_RATIO = 0.16; // relative to min(width, height)
const SYNTH_SUN_BAND_GROWTH = 1.35; // each retro "cut" band through the sun is this much taller than the last
// Both ridges are fully opaque — "far" vs. "near" reads through color alone
// (a dimmer accent tint vs. a near-black silhouette), not transparency, so
// neither ridge ever lets the sun's disc or glow show back through it.
// lineAlpha controls the perimeter stroke drawMountainRidge draws along the
// ridge (see below) — the near layer's is a bit stronger since it sits
// closer to the "camera".
const SYNTH_MOUNTAIN_LAYERS = [
  { peaks: 6, heightRatio: 0.16, colorMix: 0.5, alpha: 1, lineAlpha: 0.3 }, // far range: dim, accent-tinted
  { peaks: 8, heightRatio: 0.24, colorMix: 0.12, alpha: 1, lineAlpha: 0.45 }, // near range: near-black silhouette
];
// Row spacing on screen is driven entirely by SYNTH_GRID_PERSPECTIVE_K (the
// per-row depth falloff), NOT by SYNTH_CELL_SIZE — only column spacing reads
// that constant. So K is scaled by the same ratio SYNTH_CELL_SIZE was bumped
// by (55/35) here, to actually grow row-to-row spacing in step with column
// spacing — otherwise cells get wider without ever getting taller. ROWS is
// scaled up to compensate: a steeper K reaches "effectively zero" depth
// sooner, so more rows are needed for the closest-to-horizon row to actually
// land on the horizon instead of stopping visibly short of it (the old
// 80-row/0.15 pairing left the nearest row ~8% of the floor's height short
// of horizonY — a real gap, not a rendering artifact).
const SYNTH_GRID_ROWS = 170; // horizontal scan lines "in flight" on the floor at once — the actual line COUNT, independent of SYNTH_CELL_SIZE (which only spaces columns)
const SYNTH_GRID_DRIFT_SPEED = 0.0077; // rows/frame the floor scrolls toward the viewer, before the animation-speed multiplier — lowered alongside the K bump below so the floor's perceived scroll speed stays the same as before
// How sharply the fan bunches up toward the horizon. Flattening this past a
// point stops looking like perspective at all (things stay wide even far
// away, reading as a narrow/tilted field of view rather than normal depth)
// — so this is back to a normal value, and "more coverage" comes from
// SYNTH_CELL_SIZE/columnCount (more lines) instead of further distorting
// the curve itself.
const SYNTH_GRID_PERSPECTIVE_K = 0.235;
const SYNTH_CELL_SIZE = 55; // px per grid cell at the closest row (z=0), in the same world units columns and rows both project from
const SYNTH_COLUMN_SEGMENTS = 10; // pieces each column is drawn in, so its width/alpha can taper like the floor rungs
const SYNTH_SUN_RING_COUNT = 2; // faint halo rings drawn outside the sun's disc
const SYNTH_SUN_RING_GAP = 0.16; // fraction of the sun's radius between the disc and each successive ring
// A band straddling the horizon that gets re-drawn onto itself with a canvas
// blur filter after everything else is painted, so the mountains' flat base
// and the floor grid's nearest (faintest) rungs physically melt into each
// other instead of meeting at a hard seam at exactly horizonY.
const SYNTH_HORIZON_BLUR_BAND = 46; // px above/below the horizon line included in the blur
const SYNTH_HORIZON_BLUR_RADIUS = 9; // blur radius (px) applied to that band

// One jagged ridge line's worth of (x, y) points, from left edge to right
// edge, each peak's height randomized within the layer's own band so
// re-running setup() (e.g. on resize) gives a different skyline each time.
function buildMountainRidge(canvasWidth, horizonY, layer) {
  const segmentWidth = canvasWidth / layer.peaks;
  const maxHeight = horizonY * layer.heightRatio;
  const points = [];
  for (let i = 0; i <= layer.peaks; i++) {
    points.push({ x: i * segmentWidth, y: horizonY - maxHeight * (0.35 + Math.random() * 0.65) });
  }
  return points;
}

// Traces just the ridge itself as a rolling curve rather than a jagged
// polyline — each interior point becomes a quadratic control curving toward
// the midpoint of itself and its neighbor, the standard trick for smoothing
// a polyline without losing its general shape. Assumes the current path
// position is already at ridge[0] (see callers).
function traceRidgeCurve(ridge) {
  for (let i = 1; i < ridge.length - 1; i++) {
    const next = ridge[i + 1];
    ctx.quadraticCurveTo(ridge[i].x, ridge[i].y, (ridge[i].x + next.x) / 2, (ridge[i].y + next.y) / 2);
  }
  ctx.lineTo(ridge[ridge.length - 1].x, ridge[ridge.length - 1].y);
}

// The full silhouette outline: ridge curve plus the flat base along the
// horizon, closing the shape so it can be filled or used as a clip region.
function ridgePath(ridge, canvasWidth, horizonY) {
  ctx.moveTo(0, horizonY);
  ctx.lineTo(ridge[0].x, ridge[0].y);
  traceRidgeCurve(ridge);
  ctx.lineTo(canvasWidth, horizonY);
}

// A clean silhouette, same as real synthwave/outrun art: the terrain is a
// flat shape with a subtle gradient (blending in --accent-secondary near the
// peaks, like a sunset rim-light, down to the plain accent-tinted base) and
// a crisp perimeter along the ridge — no grid or texture etched into it. The
// grid is the ground's thing; the skyline stays solid so it reads as one
// clean layer of depth instead of competing with the floor for attention.
function drawMountainRidge(ridge, canvasWidth, horizonY, layer) {
  const [r, g, b] = accentRgb;
  const [r2, g2, b2] = secondaryRgb;
  const peakY = Math.min(...ridge.map((p) => p.y));
  const base = (mix) => [Math.round(r * mix), Math.round(g * mix), Math.round(b * mix)];
  const [br, bg, bb] = base(layer.colorMix);

  const gradient = ctx.createLinearGradient(0, peakY, 0, horizonY);
  gradient.addColorStop(0, `rgba(${Math.round((br + r2) / 2)}, ${Math.round((bg + g2) / 2)}, ${Math.round((bb + b2) / 2)}, ${layer.alpha})`);
  gradient.addColorStop(1, `rgba(${br}, ${bg}, ${bb}, ${layer.alpha})`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ridgePath(ridge, canvasWidth, horizonY);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = `rgba(${r2}, ${g2}, ${b2}, ${Math.min(1, layer.lineAlpha + 0.3)})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ridge[0].x, ridge[0].y);
  traceRidgeCurve(ridge);
  ctx.stroke();
}

// The sun itself, plus the classic retro "cut" bands through its lower
// portion — punched out with destination-out (erasing back to transparent,
// so the page's actual background shows through) rather than drawn in a
// fixed color, so it looks right against any background. Only the top half
// ends up visible anyway, since the caller clips to the sky region above the
// horizon before calling this.
function drawSynthSun(cx, cy, radius) {
  const [r, g, b] = accentRgb;
  ctx.save();
  ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.8)`;
  ctx.shadowBlur = radius * 0.5;
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // A crisp bright rim — the same white-over-accent two-tone treatment the
  // matrix rain's column head and the floor's traveling pulses use — drawn
  // before the cut bands so it gets cut through along with the disc itself,
  // instead of floating uncut on top of the gaps.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  let bandY = cy;
  let bandHeight = radius * 0.03;
  while (bandY < cy + radius) {
    ctx.fillRect(cx - radius, bandY, radius * 2, bandHeight);
    bandY += bandHeight * 2.2;
    bandHeight *= SYNTH_SUN_BAND_GROWTH;
  }
  ctx.restore();

  // Faint halo rings outside the disc — the radiating-ring detail almost
  // every retro sun illustration adds around the core.
  for (let i = 1; i <= SYNTH_SUN_RING_COUNT; i++) {
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(0.35 / i).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (1 + SYNTH_SUN_RING_GAP * i), 0, Math.PI * 2);
    ctx.stroke();
  }
}

const synthwaveEffect = {
  travel: 0,
  mountainRidges: [],
  setup() {
    this.travel = 0;
    const horizonY = canvas.height * SYNTH_HORIZON_RATIO;
    this.mountainRidges = SYNTH_MOUNTAIN_LAYERS.map((layer) => buildMountainRidge(canvas.width, horizonY, layer));
  },
  frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const horizonY = canvas.height * SYNTH_HORIZON_RATIO;
    const cx = canvas.width / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, horizonY);
    ctx.clip();
    drawSynthSun(cx, horizonY, Math.min(canvas.width, canvas.height) * SYNTH_SUN_RADIUS_RATIO);
    SYNTH_MOUNTAIN_LAYERS.forEach((layer, i) => drawMountainRidge(this.mountainRidges[i], canvas.width, horizonY, layer));
    ctx.restore();

    this.travel += SYNTH_GRID_DRIFT_SPEED * speedMultiplier;
    const [r, g, b] = accentRgb;
    const floorHeight = canvas.height - horizonY;
    // Shared by both line families below so a "closer" line reads the same
    // way whether it's a floor rung or a column segment — same alpha/width
    // formula, driven purely by closeness (1 = right at the viewer, 0 = at
    // the horizon).
    const floorAlpha = (closeness) => (0.12 + 0.35 * closeness).toFixed(3);
    const floorWidth = (closeness) => 0.6 + 1.6 * closeness;
    // A single vanishing point at (cx, horizonY), with both axes shrinking
    // by the exact same depth factor as distance z grows — the standard way
    // any 3D scene projects a flat grid, and the only way columns and rows
    // actually agree on where a cell's corners are. worldX is in the same
    // units as SYNTH_CELL_SIZE, so at z=0 a cell is exactly SYNTH_CELL_SIZE
    // px on screen; farther rows shrink both dimensions together, reading as
    // the same square tile in proper perspective, not two mismatched grids.
    const depthAt = (z) => 1 / (1 + z * SYNTH_GRID_PERSPECTIVE_K);
    const project = (worldX, z) => {
      const depth = depthAt(z);
      return { x: cx + worldX * depth, y: horizonY + floorHeight * depth };
    };

    // Extra columns well beyond what's needed to cover the bottom edge (at
    // z=0) alone — without them, only the very closest row keeps full-width
    // coverage and everything above it has already collapsed toward center,
    // leaving the sides of the screen bare for most of the floor's height.
    const columnCount = Math.ceil(canvas.width / (2 * SYNTH_CELL_SIZE)) + 1000;
    for (let i = -columnCount; i <= columnCount; i++) {
      const worldX = i * SYNTH_CELL_SIZE;
      // Drawn as short segments (rather than one stroke) so lineWidth/alpha
      // can taper along its length the same way the floor rungs do — a
      // single stroke can only have one width for its whole length.
      for (let s = 0; s < SYNTH_COLUMN_SEGMENTS; s++) {
        const z0 = (s / SYNTH_COLUMN_SEGMENTS) * SYNTH_GRID_ROWS;
        const z1 = ((s + 1) / SYNTH_COLUMN_SEGMENTS) * SYNTH_GRID_ROWS;
        const p0 = project(worldX, z0);
        const p1 = project(worldX, z1);
        const closeness = 1 - z0 / SYNTH_GRID_ROWS;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${floorAlpha(closeness)})`;
        ctx.lineWidth = floorWidth(closeness);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }

    // Row j's depth cycles from SYNTH_GRID_ROWS (far, near the horizon) down
    // to 0 (closest, about to pass the viewer) as `travel` grows, then wraps
    // back out to far again — the same looping trick the matrix rain's
    // columns use, giving an endless conveyor of rows rather than a fixed,
    // finite grid. Each row spans the full width, same as an infinite
    // ground plane extending past either edge of the screen.
    for (let j = 0; j < SYNTH_GRID_ROWS; j++) {
      const d = mod(j - this.travel, SYNTH_GRID_ROWS);
      const closeness = 1 - d / SYNTH_GRID_ROWS;
      const y = project(0, d).y;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${floorAlpha(closeness)})`;
      ctx.lineWidth = floorWidth(closeness);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Re-draw the horizon band onto itself through a blur filter, last, so
    // it melts together whatever was actually painted there (mountain base
    // + nearest grid rungs) rather than trying to predict and fade each
    // line's alpha to fake the same effect.
    const blurTop = Math.max(0, horizonY - SYNTH_HORIZON_BLUR_BAND);
    const blurBottom = Math.min(canvas.height, horizonY + SYNTH_HORIZON_BLUR_BAND);
    ctx.save();
    ctx.filter = `blur(${SYNTH_HORIZON_BLUR_RADIUS}px)`;
    ctx.drawImage(canvas, 0, blurTop, canvas.width, blurBottom - blurTop, 0, blurTop, canvas.width, blurBottom - blurTop);
    ctx.restore();
  },
};

const SPIRAL_ARMS = 3;
const SPIRAL_POINTS_PER_ARM = 200;
// A *logarithmic* spiral (radius grows exponentially with angle, like a
// nautilus shell or a real spiral galaxy) rather than a linear (Archimedean)
// one, which grows radius at a constant rate per radian and has to stay
// under 1 turn or its radius barely changes over a revolution, collapsing
// stacked arms into concentric rings instead of a recognizable swirl. A log
// spiral doesn't have that failure mode: each revolution multiplies the
// radius by a constant factor rather than adding a constant amount, so
// successive windings stay visually separated no matter how many turns.
const SPIRAL_TURNS = 2.4;
const SPIRAL_ROTATE_SPEED = 0.0022;
const SPIRAL_CORE_RADIUS = 60;
const SPIRAL_TRAIL_STEPS = 4;
const SPIRAL_TRAIL_GAP = 0.035; // radians between each trailing ghost point
// Thinner, dimmer arms interleaved between the major ones, offset by half an
// arm-spacing — real spiral galaxies usually show minor/spur structure
// between the dominant arms, and without it the disk reads as too sparse.
const SPIRAL_MINOR_ARMS = 3;
const SPIRAL_MINOR_POINTS_PER_ARM = 110;
// Stroke weight and peak alpha for the two arm families — thick and bright
// enough to read as a solid swirl rather than a faint wireframe.
const SPIRAL_ARM_LINE_WIDTH = 3.5;
const SPIRAL_ARM_ALPHA = 0.5;
const SPIRAL_MINOR_ARM_LINE_WIDTH = 2.4;
const SPIRAL_MINOR_ARM_ALPHA = 0.4;
// Vertical squash applied to every y-coordinate in the disk: 1 = viewed
// face-on (a flat circle), lower = viewed more edge-on. This alone is what
// makes it read as a tilted 3D disk instead of a flat pinwheel.
const SPIRAL_TILT = 0.42;
// Small one-time-baked-in randomness on top of each point's ideal spiral
// position (a fraction of its own radius, and a few degrees of angle) so
// the arms look like they have dust-lane texture rather than a perfectly
// smooth, laser-plotted curve.
const SPIRAL_RADIUS_JITTER = 0.05;
const SPIRAL_ANGLE_JITTER = 0.05;
const SPIRAL_STAR_COUNT = 140;

// Builds one arm's point list along the shared log-spiral curve (major and
// minor arms differ only in point count, size range, and how faint they
// are), starting `armOffset` radians around from the others.
function buildSpiralArm(armOffset, count, growth, totalAngle, { sizeMin, sizeMax, fadeMul }) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const theta = t * totalAngle;
    const idealRadius = SPIRAL_CORE_RADIUS * Math.exp(growth * theta);
    points.push({
      radius: idealRadius * (1 + (Math.random() * 2 - 1) * SPIRAL_RADIUS_JITTER),
      baseAngle: theta + armOffset + (Math.random() * 2 - 1) * SPIRAL_ANGLE_JITTER,
      fade: (1 - t * 0.75) * fadeMul, // outer points dim out instead of hard-stopping
      size: sizeMin + Math.random() * (sizeMax - sizeMin),
      twinklePhase: Math.random() * Math.PI * 2,
    });
  }
  return points;
}

// Draws one arm's connecting stroke, squashed by SPIRAL_TILT like every
// other disk element — shared by the major- and minor-arm passes in frame().
function strokeSpiralArm(points, cx, cy, rotation) {
  ctx.beginPath();
  points.forEach((p, i) => {
    const angle = p.baseAngle + rotation;
    const x = cx + p.radius * Math.cos(angle);
    const y = cy + p.radius * Math.sin(angle) * SPIRAL_TILT;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// A radial gradient running pure primary accent at its center out to pure
// secondary accent near its rim (then fading to transparent) — used as-is
// for every arm stroke and the core glow, so both colors show up clearly on
// their own rather than being combined into a single computed composite
// color. Where you are in the disk determines which one you see, not a
// per-arm or per-point blend.
function spiralRadialGradient(cx, cy, innerRadius, outerRadius, peakAlpha) {
  const gradient = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, outerRadius);
  gradient.addColorStop(0, `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${peakAlpha})`);
  gradient.addColorStop(0.55, `rgba(${secondaryRgb[0]}, ${secondaryRgb[1]}, ${secondaryRgb[2]}, ${(peakAlpha * 0.85).toFixed(3)})`);
  gradient.addColorStop(1, `rgba(${secondaryRgb[0]}, ${secondaryRgb[1]}, ${secondaryRgb[2]}, 0)`);
  return gradient;
}

const spiralEffect = {
  arms: [],
  minorArms: [],
  stars: [],
  maxRadius: 0,
  rotation: 0,
  setup() {
    this.maxRadius = Math.hypot(canvas.width, canvas.height) / 2;
    const totalAngle = SPIRAL_TURNS * Math.PI * 2;
    // Growth rate such that radius = SPIRAL_CORE_RADIUS at angle 0 and
    // exactly maxRadius at the end of the last turn.
    const growth = Math.log(this.maxRadius / SPIRAL_CORE_RADIUS) / totalAngle;

    this.arms = [];
    for (let arm = 0; arm < SPIRAL_ARMS; arm++) {
      const armOffset = (arm * Math.PI * 2) / SPIRAL_ARMS;
      this.arms.push(buildSpiralArm(armOffset, SPIRAL_POINTS_PER_ARM, growth, totalAngle, { sizeMin: 1.1, sizeMax: 2.6, fadeMul: 1 }));
    }

    this.minorArms = [];
    for (let arm = 0; arm < SPIRAL_MINOR_ARMS; arm++) {
      const armOffset = ((arm + 0.5) * Math.PI * 2) / SPIRAL_MINOR_ARMS;
      this.minorArms.push(buildSpiralArm(armOffset, SPIRAL_MINOR_POINTS_PER_ARM, growth, totalAngle, { sizeMin: 0.6, sizeMax: 1.3, fadeMul: 0.45 }));
    }

    // A static field of distant background stars, independent of the
    // spiral's geometry and drawn first each frame, so the galaxy reads as
    // floating in front of something instead of alone against a flat void.
    this.stars = Array.from({ length: SPIRAL_STAR_COUNT }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: 0.4 + Math.random() * 0.9,
      baseAlpha: 0.15 + Math.random() * 0.35,
      twinklePhase: Math.random() * Math.PI * 2,
    }));

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
    this.rotation += SPIRAL_ROTATE_SPEED * speedMultiplier;

    for (const star of this.stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(this.rotation * 18 + star.twinklePhase);
      ctx.fillStyle = `rgba(255, 255, 255, ${(star.baseAlpha * twinkle).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stroke along each arm so it reads as a continuous swirl underneath the
    // dots, not a scatter of disconnected points. Both arm families share
    // the same primary-in/secondary-out gradient (see spiralRadialGradient);
    // only their width and peak alpha differ.
    const armGradient = spiralRadialGradient(cx, cy, SPIRAL_CORE_RADIUS * 0.5, this.maxRadius, SPIRAL_ARM_ALPHA);
    ctx.strokeStyle = armGradient;
    ctx.lineWidth = SPIRAL_ARM_LINE_WIDTH;
    for (const points of this.arms) strokeSpiralArm(points, cx, cy, this.rotation);

    const minorArmGradient = spiralRadialGradient(cx, cy, SPIRAL_CORE_RADIUS * 0.5, this.maxRadius, SPIRAL_MINOR_ARM_ALPHA);
    ctx.strokeStyle = minorArmGradient;
    ctx.lineWidth = SPIRAL_MINOR_ARM_LINE_WIDTH;
    for (const points of this.minorArms) strokeSpiralArm(points, cx, cy, this.rotation);

    // Soft glow at the core, like a galaxy nucleus — squashed into an
    // ellipse via a scaled transform so it matches the tilted disk. Same
    // primary-in/secondary-out gradient as the arms, just sized to the
    // core's own small radius: a glowing primary center with a secondary
    // rim, per the "ring" look.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, SPIRAL_TILT);
    ctx.fillStyle = spiralRadialGradient(0, 0, 0, SPIRAL_CORE_RADIUS, 0.55);
    ctx.beginPath();
    ctx.arc(0, 0, SPIRAL_CORE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Dots from every arm (major and minor) are gathered and depth-sorted
    // by which side of the tilt axis they're currently on (back vs. front),
    // so front-side points draw on top of back-side ones instead of in
    // arbitrary arm order — this is what actually sells the tilt as depth
    // rather than just a squashed ellipse. Front-side points are also drawn
    // a bit bigger and brighter, the same depth cue in miniature.
    const renderPoints = [];
    for (const points of this.arms) for (const p of points) renderPoints.push(p);
    for (const points of this.minorArms) for (const p of points) renderPoints.push(p);
    for (const p of renderPoints) {
      p._angle = p.baseAngle + this.rotation;
      p._depth = Math.sin(p._angle);
    }
    renderPoints.sort((a, b) => a._depth - b._depth);

    for (const p of renderPoints) {
      const angle = p._angle;
      const depthScale = 0.55 + 0.45 * ((p._depth + 1) / 2); // back-side points read smaller/dimmer
      const twinkle = 0.5 + 0.5 * Math.sin(angle * 3 + p.radius * 0.01 + p.twinklePhase);
      const baseAlpha = FX_ALPHA * p.fade * twinkle * depthScale;

      for (let step = SPIRAL_TRAIL_STEPS; step >= 0; step--) {
        const a = angle - step * SPIRAL_TRAIL_GAP;
        const x = cx + p.radius * Math.cos(a);
        const y = cy + p.radius * Math.sin(a) * SPIRAL_TILT;
        const alpha = baseAlpha * decayedAlpha(step) / FX_ALPHA;
        if (alpha < MIN_ALPHA) continue;
        // Flat secondary accent — no blending with primary — so the dots
        // read as a distinct star field laid over the primary/secondary
        // gradient of the arms and core beneath them.
        ctx.fillStyle = `rgba(${secondaryRgb[0]}, ${secondaryRgb[1]}, ${secondaryRgb[2]}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, p.size * depthScale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },
};

// A calm field of soft-edged circles that drift slowly across the canvas
// and breathe in and out (radius + alpha both riding the same sine), half
// in --accent and half in --accent-secondary. Each orb is a radial gradient
// fading to fully transparent at its own edge — that's what gives it a
// soft, out-of-focus look without paying for an actual canvas blur filter
// per orb, per frame.
const ORB_COUNT = 6; // fewer, since each one now covers much more of the screen
const ORB_MIN_RADIUS_RATIO = 0.22; // relative to min(width, height)
const ORB_MAX_RADIUS_RATIO = 0.48;
const ORB_DRIFT_SPEED = 0.15; // px/frame at speedMultiplier 1
const ORB_PULSE_SPEED = 0.015; // radians/frame added to phase at speedMultiplier 1
const ORB_PEAK_ALPHA = 0.28; // kept fairly low despite the bigger size, so it still reads as a soft glow, not a solid disc

const orbsEffect = {
  orbs: [],
  setup() {
    const minDim = Math.min(canvas.width, canvas.height);
    this.orbs = Array.from({ length: ORB_COUNT }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      radius: minDim * (ORB_MIN_RADIUS_RATIO + Math.random() * (ORB_MAX_RADIUS_RATIO - ORB_MIN_RADIUS_RATIO)),
      angle: Math.random() * Math.PI * 2, // drift direction, fixed for the orb's lifetime
      phase: Math.random() * Math.PI * 2,
      secondary: Math.random() < 0.5,
    }));
  },
  frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const orb of this.orbs) {
      orb.phase += ORB_PULSE_SPEED * speedMultiplier;
      orb.x += Math.cos(orb.angle) * ORB_DRIFT_SPEED * speedMultiplier;
      orb.y += Math.sin(orb.angle) * ORB_DRIFT_SPEED * speedMultiplier;

      // Wrap around each edge (with a margin of its own radius) instead of
      // bouncing, so orbs never visibly "hit a wall": they just quietly
      // reappear on the opposite side, same trick the matrix rain's columns
      // use for their vertical loop.
      if (orb.x < -orb.radius) orb.x = canvas.width + orb.radius;
      if (orb.x > canvas.width + orb.radius) orb.x = -orb.radius;
      if (orb.y < -orb.radius) orb.y = canvas.height + orb.radius;
      if (orb.y > canvas.height + orb.radius) orb.y = -orb.radius;

      const pulse = 0.8 + 0.2 * Math.sin(orb.phase);
      const r = orb.radius * pulse;
      const [red, green, blue] = orb.secondary ? secondaryRgb : accentRgb;
      const alpha = ORB_PEAK_ALPHA * pulse;

      const gradient = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, r);
      gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`);
      gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  },
};

const CANVAS_EFFECTS = { matrix: matrixEffect, grid: synthwaveEffect, spiral: spiralEffect, orbs: orbsEffect };

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
    // Re-read on every settings change (not just on start) so an accent,
    // theme, or animation-speed swap while an effect is already running
    // updates it live.
    readColors();
    speedMultiplier = getSettings().animationSpeed || 1;
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
