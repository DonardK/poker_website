/**
 * Numerical helpers for the RNG certification suite (rng.test.ts).
 *
 * p-values come from the regularized incomplete gamma function:
 *   chi2 survival  Q(df/2, x/2),   chi2 CDF  P(df/2, x/2).
 * Accuracy matters at df up to ~3000 with x near df. There, x^a and Gamma(a)
 * both overflow a double, so the prefactor x^a e^-x / Gamma(a) is formed as
 * exp(a ln x - x - lnGamma(a)). For a = 1300 the relative rounding error is
 * about eps * a ln x, i.e. ~1e-12, far below any threshold used here.
 *
 * `chiSquareSurvivalExact` and `erfc` are an INDEPENDENT oracle: they share no
 * code with lnGamma or the series / continued-fraction evaluators, so the test
 * suite cross-checks one against the other (and both against mpmath values).
 */

/** Lanczos approximation, g = 7, n = 9 (relative error ~1e-15 for z >= 0.5). */
const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;
const HALF_LN_2PI = 0.5 * Math.log(2 * Math.PI);
const CONVERGENCE_EPS = 1e-15;
const MAX_ITERATIONS = 100_000;
const FP_MIN = 1e-300;

/** ln Gamma(z) for finite z > 0. */
export function lnGamma(z: number): number {
  if (!Number.isFinite(z) || z <= 0) throw new RangeError(`lnGamma requires a finite z > 0, got ${z}`);
  // Reflection keeps the Lanczos sum in its accurate range z >= 0.5.
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  const x = z - 1;
  let sum: number = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i]! / (x + i);
  const t = x + LANCZOS_G + 0.5;
  return HALF_LN_2PI + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

function assertGammaArgs(a: number, x: number): void {
  if (!Number.isFinite(a) || a <= 0) throw new RangeError(`shape a must be finite and > 0, got ${a}`);
  if (Number.isNaN(x) || x < 0) throw new RangeError(`x must be >= 0, got ${x}`);
}

/** ln( x^a e^-x / Gamma(a) ), computed without forming x^a or Gamma(a). */
function logPrefactor(a: number, x: number): number {
  return a * Math.log(x) - x - lnGamma(a);
}

/** P(a, x) by its power series; converges quickly for x < a + 1. */
function lowerSeries(a: number, x: number): number {
  let denominator = a;
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n <= MAX_ITERATIONS; n++) {
    denominator += 1;
    term *= x / denominator;
    sum += term;
    if (term < sum * CONVERGENCE_EPS) return sum * Math.exp(logPrefactor(a, x));
  }
  throw new Error(`incomplete gamma series did not converge (a=${a}, x=${x})`);
}

/** Q(a, x) by its continued fraction (modified Lentz); converges quickly for x >= a + 1. */
function upperContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FP_MIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FP_MIN) d = FP_MIN;
    c = b + an / c;
    if (Math.abs(c) < FP_MIN) c = FP_MIN;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < CONVERGENCE_EPS) return Math.exp(logPrefactor(a, x)) * h;
  }
  throw new Error(`incomplete gamma continued fraction did not converge (a=${a}, x=${x})`);
}

/** Regularized lower incomplete gamma P(a, x). */
export function regularizedGammaP(a: number, x: number): number {
  assertGammaArgs(a, x);
  if (x === 0) return 0;
  if (x === Infinity) return 1;
  return x < a + 1 ? lowerSeries(a, x) : 1 - upperContinuedFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x). */
export function regularizedGammaQ(a: number, x: number): number {
  assertGammaArgs(a, x);
  if (x === 0) return 1;
  if (x === Infinity) return 0;
  return x < a + 1 ? 1 - lowerSeries(a, x) : upperContinuedFraction(a, x);
}

function assertDf(df: number): void {
  if (!Number.isFinite(df) || df <= 0) throw new RangeError(`degrees of freedom must be finite and > 0, got ${df}`);
}

/** Upper tail P(X >= x) for X ~ chi2(df). */
export function chiSquareSurvival(x: number, df: number): number {
  assertDf(df);
  if (Number.isNaN(x)) throw new RangeError("x is NaN");
  return x <= 0 ? 1 : regularizedGammaQ(df / 2, x / 2);
}

/** Lower tail P(X <= x) for X ~ chi2(df). */
export function chiSquareCdf(x: number, df: number): number {
  assertDf(df);
  if (Number.isNaN(x)) throw new RangeError("x is NaN");
  return x <= 0 ? 0 : regularizedGammaP(df / 2, x / 2);
}

/**
 * Two-sided p-value 2 * min(lower, upper), capped at 1. Rejecting when it is
 * <= alpha puts alpha/2 in each tail. The lower tail catches output that is
 * too regular to be random.
 */
export function chiSquareTwoSidedP(x: number, df: number): number {
  return Math.min(1, 2 * Math.min(chiSquareCdf(x, df), chiSquareSurvival(x, df)));
}

/** Pearson statistic sum (O - E)^2 / E over cells that share one expected count. */
export function pearsonEqualExpected(observed: ArrayLike<number>, expected: number): number {
  if (!(expected > 0)) throw new RangeError("expected count must be > 0");
  let statistic = 0;
  for (let i = 0; i < observed.length; i++) {
    const deviation = observed[i]! - expected;
    statistic += (deviation * deviation) / expected;
  }
  return statistic;
}

// ---------------------------------------------------------------------------
// Independent oracle (no shared code with the gamma evaluators above)
// ---------------------------------------------------------------------------

/**
 * Complementary error function. For |z| < 2 it uses the all-positive series
 * erf(z) = (2/sqrt(pi)) e^{-z^2} sum_n 2^n z^{2n+1} / (1*3*...*(2n+1)) (A&S 7.1.6).
 * For z >= 2 it uses the continued fraction
 * erfc(z) = e^{-z^2}/sqrt(pi) * 1/(z + (1/2)/(z + 1/(z + (3/2)/(z + ...)))) (A&S 7.1.14).
 */
export function erfc(z: number): number {
  if (Number.isNaN(z)) throw new RangeError("erfc(NaN)");
  if (z < 0) return 2 - erfc(-z);
  if (z < 2) {
    let term = z;
    let sum = z;
    for (let n = 1; n <= MAX_ITERATIONS; n++) {
      term *= (2 * z * z) / (2 * n + 1);
      sum += term;
      if (term <= sum * Number.EPSILON) return 1 - (2 / Math.sqrt(Math.PI)) * Math.exp(-z * z) * sum;
    }
    throw new Error("erf series did not converge");
  }
  if (z === Infinity) return 0;
  let f = z;
  let c = z;
  let d = 0;
  for (let k = 1; k <= MAX_ITERATIONS; k++) {
    const a = k / 2;
    d = z + a * d;
    if (Math.abs(d) < FP_MIN) d = FP_MIN;
    d = 1 / d;
    c = z + a / c;
    if (Math.abs(c) < FP_MIN) c = FP_MIN;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < CONVERGENCE_EPS) return Math.exp(-z * z) / (Math.sqrt(Math.PI) * f);
  }
  throw new Error("erfc continued fraction did not converge");
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** Wilson-Hilferty (1931) cube-root normal approximation to the chi2(df) CDF. */
export function wilsonHilfertyCdf(x: number, df: number): number {
  const v = 2 / (9 * df);
  return normalCdf((Math.cbrt(x / df) - (1 - v)) / Math.sqrt(v));
}

/**
 * Exact chi2 survival for INTEGER df via finite sums (x > 0):
 *   even df = 2m:   Q(m, y)     = sum_{i<m} e^{-y} y^i / i!                      (Poisson tail)
 *   odd df = 2m+1:  Q(m+1/2, y) = erfc(sqrt y) + sum_{i<m} e^{-y} y^{i+1/2} / Gamma(i+3/2)
 * with y = x/2. ln(i!) and ln Gamma(i+3/2) = ln sqrt(pi) + sum_{k<=i+1} ln(k-1/2) are
 * accumulated directly, so this oracle never calls lnGamma. O(df) time.
 */
export function chiSquareSurvivalExact(x: number, df: number): number {
  if (!Number.isInteger(df) || df < 1) throw new RangeError("oracle requires an integer df >= 1");
  if (!(x > 0) || !Number.isFinite(x)) throw new RangeError("oracle requires finite x > 0");
  const y = x / 2;
  const lnY = Math.log(y);
  const m = Math.floor(df / 2);
  let sum = 0;
  if (df % 2 === 0) {
    let lnFactorial = 0;
    for (let i = 0; i < m; i++) {
      if (i > 0) lnFactorial += Math.log(i);
      sum += Math.exp(-y + i * lnY - lnFactorial);
    }
    return sum;
  }
  sum = erfc(Math.sqrt(y));
  let lnGammaHalf = 0.5 * Math.log(Math.PI); // ln Gamma(1/2)
  for (let i = 0; i < m; i++) {
    lnGammaHalf += Math.log(i + 0.5); // now ln Gamma(i + 3/2)
    sum += Math.exp(-y + (i + 0.5) * lnY - lnGammaHalf);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Two-stage decision for a statistical family (rng.test.ts)
// ---------------------------------------------------------------------------

/**
 * One evaluation of a statistical family on one sample: the smallest p-value
 * of its tests, the per-test threshold it is compared with (the family fails
 * when p <= alpha), and a human-readable report (statistics, the offending
 * row's cell counts) to print with the verdict.
 */
export interface FamilyEvaluation {
  p: number;
  alpha: number;
  report: string;
}

export interface TwoStageVerdict {
  /** False only when the first sample AND the independent repeat both failed. */
  pass: boolean;
  /** Whether the repeat ran (only after a first-stage failure). */
  repeated: boolean;
  first: FamilyEvaluation;
  second: FamilyEvaluation | null;
}

/** A family evaluation fails when its smallest p-value is at or below its threshold (NaN fails). */
export function familyFails(evaluation: FamilyEvaluation): boolean {
  return !(evaluation.p > evaluation.alpha);
}

/**
 * Two-stage test: a family that fails on the first sample is re-run on a
 * FRESH, INDEPENDENT sample (`repeat` must draw new output from the RNG under
 * test, never reuse the first sample), and the family fails only if the repeat
 * fails too. `repeat` is not called when the first stage passes.
 *
 * False alarms: a healthy RNG fails stage one with probability <= a (the
 * family's level) and, independently, the repeat with probability <= a, so the
 * family's false-failure probability is <= a^2. Power against a real defect is
 * barely touched: a defect that fails stage one with probability q fails both
 * with probability q^2, and the defects that matter (bias, Sattolo, repeated
 * output) give q = 1 to within 1e-50 at these sample sizes.
 */
export function twoStage(first: FamilyEvaluation, repeat: () => FamilyEvaluation): TwoStageVerdict {
  if (!familyFails(first)) return { pass: true, repeated: false, first, second: null };
  const second = repeat();
  return { pass: !familyFails(second), repeated: true, first, second };
}

/** The verdict as printed by the suite: both p-values (when the repeat ran) and their reports. */
export function describeVerdict(name: string, verdict: TwoStageVerdict): string {
  const p = (x: number): string => (Math.abs(x) >= 1e-3 || x === 0 ? x.toFixed(4) : x.toExponential(3));
  const head = (label: string, e: FamilyEvaluation): string =>
    `${label}: min p ${p(e.p)} vs alpha ${e.alpha.toExponential(3)} -> ${familyFails(e) ? "FAIL" : "pass"}`;
  if (!verdict.repeated) return `${name} ${head("stage 1", verdict.first)}\n      ${verdict.first.report}`;
  return `${name} two-stage ${verdict.pass ? "PASS (stage-1 false alarm, repeat clean)" : "FAIL (failed on two independent samples)"}\n` +
    `      ${head("stage 1", verdict.first)}\n      ${verdict.first.report}\n` +
    `      ${head("stage 2 (fresh sample)", verdict.second!)}\n      ${verdict.second!.report}`;
}
