// Curves (DYNAMIC_LAYER.md §3, v1): one pure function from a 0..1 source value to a target range. No imports.
// Spec form: undefined | 'lin' | 'exp' | 'log' | 's' | 'pow'  or  { name, k, p, c, w, invert, deadzone: { c, d } }.
// A bare string (or undefined) takes EXACTLY today's mapRange float path, so preset `default` is byte-identical.
export const CURVES = ['lin', 'exp', 'log', 's', 'pow'];
export const CURVE_MODIFIERS = ['invert', 'deadzone'];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (x) => { const u = clamp01(x); return u * u * (3 - 2 * u); };

export const curveName = (spec) => (spec == null ? 'lin' : typeof spec === 'string' ? spec : spec.name ?? 'lin');

// shape f(t) for the non-exp curves (exp is applied on the range, not on t)
function shape(name, t, spec) {
  if (name === 'log') { const k = spec?.k ?? 9; return Math.log(1 + k * t) / Math.log(1 + k); }
  if (name === 's') {
    const c = spec?.c ?? 0.5, w = spec?.w ?? 1, lo = smooth((0 - c) / w + 0.5), hi = smooth((1 - c) / w + 0.5);
    return hi > lo ? (smooth((t - c) / w + 0.5) - lo) / (hi - lo) : t;
  }
  if (name === 'pow') return Math.pow(t, spec?.p ?? 2);
  return t; // lin
}

export function mapCurve(spec, range, v) {
  const [lo, hi] = range;
  let t = clamp01(v);
  if (spec == null || typeof spec === 'string') {
    // today's mapRange, copied literally (float order matters)
    if (spec === 'exp') return lo * Math.pow(hi / lo, t);
    if (spec == null || spec === 'lin') return lo + (hi - lo) * t;
    return lo + (hi - lo) * shape(spec, t);
  }
  const dz = spec.deadzone;
  if (dz) {
    const a = dz.c - dz.d, b = dz.c + dz.d;
    t = t <= a ? (a > 0 ? (t / a) * dz.c : 0) : t >= b ? (b < 1 ? dz.c + ((t - b) / (1 - b)) * (1 - dz.c) : 1) : dz.c;
  }
  if (spec.invert) t = 1 - t;
  const name = spec.name ?? 'lin';
  if (name === 'exp') return lo * Math.pow(hi / lo, t);
  return lo + (hi - lo) * shape(name, t, spec);
}

// validation (a refusal reason, or null)
export function curveError(spec, range) {
  const name = curveName(spec);
  if (!CURVES.includes(name)) return `unknown curve '${name}' (known: ${CURVES.join(', ')})`;
  if (spec && typeof spec === 'object') {
    for (const k of Object.keys(spec)) if (!['name', 'k', 'p', 'c', 'w', 'invert', 'deadzone'].includes(k)) return `unknown curve option '${k}'`;
    if (spec.deadzone && !(Number.isFinite(spec.deadzone.c) && Number.isFinite(spec.deadzone.d) && spec.deadzone.d >= 0)) return 'deadzone needs finite {c, d>=0}';
    if (name === 'pow' && spec.p != null && !(spec.p > 0)) return 'pow needs p > 0';
    if (name === 'log' && spec.k != null && !(spec.k > 0)) return 'log needs k > 0';
  }
  if (name === 'exp' && range && !(range[0] * range[1] > 0)) return 'exp needs both range ends non-zero and the same sign';
  return null;
}

// How the agency probe compares source and param (conductor.js): exp in log space; invert flips the expected sign.
export const curveProbe = (spec) => ({ log: curveName(spec) === 'exp', sign: spec && typeof spec === 'object' && spec.invert ? -1 : 1 });

// inverse (target value -> 0..1 position), for console bars. Monotone curves only (all of v1).
export function curvePos(spec, range, y) {
  const [lo, hi] = range;
  if (curveName(spec) === 'exp') return Math.log(Math.max(y, 1e-6) / lo) / Math.log(hi / lo);
  return (y - lo) / (hi - lo);
}
