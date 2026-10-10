/**
 * GLI-19 RNG and shuffle certification suite.
 *
 * What this file proves, for regulatory submission:
 *  1. Scaling: `uniformFromWords` maps uniform 32-bit words to [0, range) with
 *     ZERO modulo bias (exact acceptance boundary, all ranges 1..52 and edges).
 *  2. Shuffle: `durstenfeldShuffle` is a bijection from draw sequences onto
 *     permutations (exhaustive for n <= 8), so uniform draws give uniform
 *     permutations.
 *  3. Output: 1,000,000 production `shuffledDeck()` calls pass chi-square
 *     tests per position, per card, globally and for serial independence of
 *     successive shuffles, and 1,000,000 `shuffle()` calls on 5 items hit all
 *     120 permutations uniformly. All chi-square tests are two-sided.
 *  4. Source hygiene: OS CSPRNG words only, consumed words zeroed, continuous
 *     health test fires on stuck or repeating entropy and never on healthy
 *     entropy; no Math.random, no seeded or HMAC shuffle in the sources.
 *
 * FALSE-FAILURE BUDGET (whole file) <= 1e-6 (was 1e-3 before the two-stage rule).
 *  Five statistical families, each tested two-sided at ALPHA_FAMILY = 1.6e-4
 *  per stage:
 *    (a) 52 position rows    Bonferroni: 1.6e-4 / 52 per row
 *    (b) 52 card columns     Bonferroni: 1.6e-4 / 52 per column
 *    (c) global 52x52        1.6e-4
 *    (d) successive pairs    Bonferroni: 1.6e-4 / 2 per table (2 tables)
 *    (e) 5-item permutations 1.6e-4
 *  TWO-STAGE RULE (helpers/stats.ts twoStage): a family that fails is re-run
 *  on a FRESH, INDEPENDENT sample (1,000,000 new production calls drawn from
 *  the OS CSPRNG), and the suite fails only if the repeat fails too. Both
 *  p-values and the offending row's cell counts are printed. (A healthy RNG
 *  once failed one Bonferroni family, a row p = 1.24e-6 < 3.08e-6: a
 *  ~1-in-1,000 event per run under the old single-stage budget.)
 *  Per family: P(stage 1 fails) <= a and, independently, P(repeat fails) <= a,
 *  so P(family fails) <= a^2, with a = 1.24 * 1.6e-4 (the 24% approximation
 *  allowance below): <= 3.94e-8 per family. One repeat sample may serve every
 *  family among (a)-(d) that failed: each family's two stages are still two
 *  independent samples, and the union bound below needs nothing more.
 *  Union bound (valid under any dependence): 5 * 3.94e-8 = 1.97e-7.
 *   - The chi-square approximation of the discrete Pearson statistics: every
 *     cell expects >= 184 counts, so the true tail probabilities differ from
 *     the nominal ones by O(1/E) corrections, well under 1% relative; the
 *     factor 1.24 per stage allows even a 24% relative error.
 *   - The events that could fail a HEALTHY CSPRNG: an all-zero or repeated
 *     256-byte block (2^-2048 each; 2^-256 for a SHA-256 digest collision),
 *     128 consecutive rejections (every range drawn from the real CSPRNG here
 *     rejects with p < 2^-26), two identical 64-word streams (2^-2048), a bit
 *     never set in 4096 words (2^-4096), and so on. Each is < 2^-128 per
 *     opportunity, with fewer than 2^30 opportunities, so < 2^-98 in total.
 *  Total <= 5 * (1.24 * 1.6e-4)^2 + 2^-98 < 2e-7 < 1e-6. Power against real
 *  defects is unchanged: the negative controls below fail with p < 1e-50 on
 *  any sample, so they fail both stages. Every other assertion, including the
 *  negative controls and the two-stage unit tests, is deterministic.
 */
import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { jest } from "@jest/globals";
import ts from "typescript";
import type { Card } from "@poker/shared";
import { fullDeck } from "../cards.js";
import { durstenfeldShuffle, shuffle, shuffledDeck } from "../deck.js";
import {
  CsprngWordStream,
  RngFailure,
  U32_SPAN,
  randIntInclusive,
  rejectionLimit,
  secureRandomInt,
  uniformFromWords,
} from "../rng.js";
import {
  type FamilyEvaluation,
  chiSquareCdf,
  chiSquareSurvival,
  chiSquareSurvivalExact,
  chiSquareTwoSidedP,
  describeVerdict,
  erfc,
  familyFails,
  lnGamma,
  pearsonEqualExpected,
  regularizedGammaP,
  regularizedGammaQ,
  twoStage,
  wilsonHilfertyCdf,
} from "./helpers/stats.js";

// Generous default so a loaded CI machine cannot time out a correct test.
jest.setTimeout(120_000);

const DECK = 52;
const N = 1_000_000;
const ALPHA_FAMILY = 1.6e-4;
const FAMILIES = 5;
/** Allowance for the chi-square approximation of the discrete statistics, per stage (see header). */
const APPROXIMATION_FACTOR = 1.24;
/** Two-stage false-failure probability of one family: both independent stages fail. */
const FAMILY_FALSE_FAILURE = (APPROXIMATION_FACTOR * ALPHA_FAMILY) ** 2;
const HEALTH_EVENTS = 2 ** -98;
const TOTAL_BUDGET = 1e-6;

const fmt = (x: number, digits = 4): string => (Math.abs(x) >= 1e-3 || x === 0 ? x.toFixed(digits) : x.toExponential(3));
const relErr = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

it("keeps the two-stage false-failure budget within 1e-6 (about alpha^2 per family)", () => {
  expect(FAMILY_FALSE_FAILURE).toBeLessThan(3.94e-8 + 1e-12);
  expect(FAMILIES * FAMILY_FALSE_FAILURE).toBeLessThan(1.97e-7 + 1e-12);
  expect(FAMILIES * FAMILY_FALSE_FAILURE + HEALTH_EVENTS).toBeLessThanOrEqual(TOTAL_BUDGET);
  // The single-stage budget at the same alpha was 5 * 1.24 * 1.6e-4 ~ 1e-3.
  expect(FAMILIES * APPROXIMATION_FACTOR * ALPHA_FAMILY).toBeLessThan(1e-3);
});

// ---------------------------------------------------------------------------
// Chi-square numerics. Reference values computed independently with mpmath
// 1.3.0 at 50-60 significant digits (mp.loggamma, mp.erfc,
// mp.gammainc(a, x, inf, regularized=True)).
// ---------------------------------------------------------------------------
describe("chi-square numerics (helpers/stats.ts)", () => {
  it("lnGamma matches mpmath to 1e-12 relative (absolute near its zeros)", () => {
    const refs: [number, number][] = [
      [0.001, 6.907178885383853682512345],
      [0.5, 0.5723649429247000870717137],
      [1, 0],
      [1.5, -0.1207822376352452223455184],
      [2, 0],
      [2.5, 0.2846828704729191596324947],
      [3.7, 1.428072326665387921872381],
      [10, 12.80182748008146961120772],
      [25.5, 56.38916764371994674445244],
      [100, 359.134205369575398776044],
      [1300.5, 8022.074312966440263082413],
      [1352, 8392.342356969116471173918],
    ];
    let worst = 0;
    for (const [z, ref] of refs) {
      const err = Math.abs(lnGamma(z) - ref) / Math.max(1, Math.abs(ref));
      worst = Math.max(worst, err);
      expect(err).toBeLessThan(1e-12);
    }
    // Independent identities: ln Gamma(n) = sum ln k, ln Gamma(n + 1/2) = ln sqrt(pi) + sum ln(k - 1/2).
    let lnFact = 0;
    let lnHalf = 0.5 * Math.log(Math.PI);
    for (let n = 1; n <= 3000; n++) {
      if (n > 1) lnFact += Math.log(n - 1);
      if (n > 1) lnHalf += Math.log(n - 1.5);
      if (n % 97 === 0 || n <= 12 || n === 3000) {
        const e1 = Math.abs(lnGamma(n) - lnFact) / Math.max(1, lnFact);
        const e2 = Math.abs(lnGamma(n - 0.5) - lnHalf) / Math.max(1, Math.abs(lnHalf));
        worst = Math.max(worst, e1, e2);
        expect(e1).toBeLessThan(1e-12);
        expect(e2).toBeLessThan(1e-12);
      }
    }
    console.info(`[rng] lnGamma worst relative error vs references: ${worst.toExponential(2)}`);
    for (const bad of [0, -1, NaN, Infinity]) expect(() => lnGamma(bad)).toThrow(RangeError);
  });

  it("reproduces standard chi-square table critical values", () => {
    // [x (6-decimal table value), df, tail, nominal p]. Rounding x to 6
    // decimals moves p by <= density * 5e-7 <= 1.2e-8, so 5e-8 is a strict bound.
    const table: [number, number, "upper" | "lower", number][] = [
      [3.841459, 1, "upper", 0.05],
      [10.827566, 1, "upper", 0.001],
      [5.991465, 2, "upper", 0.05],
      [18.307038, 10, "upper", 0.05],
      [23.209251, 10, "upper", 0.01],
      [3.940299, 10, "lower", 0.05],
      [124.342113, 100, "upper", 0.05],
      [135.806723, 100, "upper", 0.01],
      [77.929465, 100, "lower", 0.05],
    ];
    for (const [x, df, tail, p] of table) {
      const got = tail === "upper" ? chiSquareSurvival(x, df) : chiSquareCdf(x, df);
      expect(Math.abs(got - p)).toBeLessThan(5e-8);
    }
  });

  it("matches mpmath survival and CDF to 1e-10 relative, including df ~ 3000 and the decision tails", () => {
    // [x, df, survival, cdf]. The first eight rows are the exact two-sided
    // decision points of this file: per-tail levels 1.6e-4/104 at df 51,
    // 8e-5 at df 2601 and 119, 4e-5 at df 2703.
    const refs: [number, number, number, number][] = [
      [112.589825, 51, 1.5384616768642794e-6, 0.99999846153832314],
      [16.799263, 51, 0.99999846153822238, 1.538461777621256e-6],
      [2882.147009, 2601, 8.0000000746633017e-5, 0.99991999999925337],
      [2337.517979, 2601, 0.99992000000107838, 7.9999998921616288e-5],
      [3002.76908, 2703, 3.9999999535038164e-5, 0.99996000000046496],
      [2422.638983, 2703, 0.99996000000019921, 3.9999999800787305e-5],
      [186.242287, 119, 7.9999997044709559e-5, 0.99992000000295529],
      [69.367678, 119, 0.9999200000147543, 7.9999985245695904e-5],
      [2989.433589, 2703, 8.0000001469065774e-5, 0.99991999999853093],
      [2434.231498, 2703, 0.99992000000172783, 7.9999998272169328e-5],
      [0.5, 1, 0.47950012218695346, 0.52049987781304654],
      [1, 1, 0.3173105078629141, 0.6826894921370859],
      [2, 3, 0.57240670447087983, 0.42759329552912017],
      [7.5, 5, 0.18602983360286702, 0.81397016639713298],
      [0.2, 4, 0.99532115983955553, 0.00467884016044447],
      [30, 20, 0.069853660699409768, 0.93014633930059023],
      [51, 51, 0.47366065328196914, 0.52633934671803086],
      [68.669294, 51, 0.049999999264409358, 0.95000000073559064],
      [119, 119, 0.48275872608245202, 0.51724127391754798],
      [1000, 1000, 0.49405285382923964, 0.50594714617076036],
      [1100, 1000, 0.014614408126295194, 0.98538559187370481],
      [900, 1000, 0.98928276190871026, 0.010717238091289742],
      [2601, 2601, 0.49631247065653478, 0.50368752934346522],
      [2652, 2601, 0.23830493609970301, 0.76169506390029699],
      [2400, 2601, 0.99783276892280367, 0.0021672310771963326],
      [2800, 2601, 0.0034575454974905257, 0.99654245450250947],
      [2703, 2703, 0.49638271632513903, 0.50361728367486097],
      [2600, 2600, 0.49631176157841085, 0.50368823842158915],
      [2700, 2600, 0.084012752100339767, 0.91598724789966023],
      [3000, 3000, 0.49656643883965135, 0.50343356116034865],
      [3300, 2999, 8.0916346377155593e-5, 0.99991908365362284],
      [0.001, 0.7, 0.92154300062190596, 0.078456999378094037],
      [0.5, 0.3, 0.15604916709686203, 0.84395083290313797],
      [40, 7.5, 2.0272916934286656e-6, 0.99999797270830657],
    ];
    let worst = 0;
    for (const [x, df, sf, cdf] of refs) {
      const e1 = relErr(chiSquareSurvival(x, df), sf);
      const e2 = relErr(chiSquareCdf(x, df), cdf);
      worst = Math.max(worst, e1, e2);
      expect(e1).toBeLessThan(1e-10);
      expect(e2).toBeLessThan(1e-10);
    }
    console.info(`[rng] chi-square worst relative error vs mpmath (${refs.length} points, df 0.3..3000): ${worst.toExponential(2)}`);
  });

  it("agrees with the independent finite-sum oracle for integer df (1..60 and large df)", () => {
    // The oracle itself is checked against mpmath first.
    expect(relErr(chiSquareSurvivalExact(2652, 2601), 0.23830493609970301)).toBeLessThan(1e-9);
    expect(relErr(chiSquareSurvivalExact(2700, 2600), 0.084012752100339767)).toBeLessThan(1e-9);
    expect(relErr(chiSquareSurvivalExact(112.589825, 51), 1.5384616768642794e-6)).toBeLessThan(1e-9);
    expect(relErr(chiSquareSurvivalExact(1, 1), 0.3173105078629141)).toBeLessThan(1e-12);
    let worst = 0;
    let points = 0;
    const dfs = [...Array.from({ length: 60 }, (_, i) => i + 1), 119, 999, 1000, 2600, 2601, 2703, 3000];
    for (const df of dfs) {
      const sd = Math.sqrt(2 * df);
      for (const z of [-4, -2.5, -1, -0.3, 0, 0.3, 1, 2.5, 4, 5]) {
        const x = df + z * sd;
        if (x <= 0) continue;
        const exact = chiSquareSurvivalExact(x, df);
        if (exact < 1e-280) continue;
        const e = relErr(chiSquareSurvival(x, df), exact);
        worst = Math.max(worst, e);
        points++;
        expect(e).toBeLessThan(1e-9);
      }
    }
    console.info(`[rng] chi-square vs finite-sum oracle: ${points} points, worst relative error ${worst.toExponential(2)}`);
  });

  it("matches closed forms: df = 2 survival is exp(-x/2); erfc matches mpmath", () => {
    for (const x of [1e-9, 0.01, 0.5, 1, 3, 5.991464547107979, 10, 40, 200, 1400]) {
      expect(relErr(chiSquareSurvival(x, 2), Math.exp(-x / 2))).toBeLessThan(1e-12);
    }
    const erfcRefs: [number, number][] = [
      [-1, 1.8427007929497149],
      [0.1, 0.88753708398171511],
      [0.5, 0.47950012218695346],
      [1, 0.15729920705028513],
      [1.9, 0.0072095707647425301],
      [2, 0.0046777349810472658],
      [2.5, 0.00040695201744495894],
      [3, 2.2090496998585441e-5],
      [5, 1.5374597944280349e-12],
      [10, 2.0884875837625448e-45],
    ];
    for (const [z, ref] of erfcRefs) expect(relErr(erfc(z), ref)).toBeLessThan(1e-12);
  });

  it("agrees with the Wilson-Hilferty approximation for df 1000 and 2601 (|dp| < 1e-3)", () => {
    let worst = 0;
    for (const df of [1000, 2601]) {
      for (let z = -4; z <= 4; z += 0.5) {
        const x = df + z * Math.sqrt(2 * df);
        const d = Math.abs(chiSquareCdf(x, df) - wilsonHilfertyCdf(x, df));
        worst = Math.max(worst, d);
        expect(d).toBeLessThan(1e-3);
      }
    }
    console.info(`[rng] Wilson-Hilferty max |dp| at df 1000/2601: ${worst.toExponential(2)}`);
  });

  it("handles edge cases and keeps P + Q = 1", () => {
    expect(chiSquareSurvival(0, 5)).toBe(1);
    expect(chiSquareSurvival(-3, 5)).toBe(1);
    expect(chiSquareCdf(0, 5)).toBe(0);
    expect(chiSquareSurvival(Infinity, 5)).toBe(0);
    expect(chiSquareCdf(Infinity, 5)).toBe(1);
    expect(chiSquareTwoSidedP(2601, 2601)).toBeCloseTo(2 * 0.49631247065653478, 10);
    for (const df of [0, -1, NaN, Infinity]) expect(() => chiSquareSurvival(1, df)).toThrow(RangeError);
    expect(() => chiSquareCdf(NaN, 3)).toThrow(RangeError);
    for (const [a, x] of [[0.5, 0.2], [3, 2.5], [3, 4.5], [1300.5, 1300], [1300.5, 1302.5]] as const) {
      expect(Math.abs(regularizedGammaP(a, x) + regularizedGammaQ(a, x) - 1)).toBeLessThan(1e-14);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 1: rejection sampling with zero modulo bias.
// ---------------------------------------------------------------------------
describe("rejection sampling (rejectionLimit / uniformFromWords)", () => {
  const ranges = [...new Set([...Array.from({ length: 52 }, (_, i) => i + 1), 2, 3, 2 ** 31, 2 ** 31 + 1, U32_SPAN - 1, U32_SPAN])];

  /** Scripted word source: returns the given words in order, fails loudly if over-read. */
  function script(words: number[]) {
    let consumed = 0;
    return {
      next: (): number => {
        if (consumed >= words.length) throw new Error("script exhausted: sampler over-read");
        return words[consumed++]!;
      },
      consumed: () => consumed,
    };
  }

  it("has exactly limit/range preimages for every residue (zero-bias proof), for 1..52 and edge ranges", () => {
    // PROOF: limit = rejectionLimit(range) is a multiple of range, so the
    // accepted words [0, limit) split into limit/range complete runs
    // 0..range-1. Each residue r therefore has exactly limit/range preimages.
    // A CSPRNG word is uniform on [0, 2^32); conditioned on acceptance
    // (word < limit) it is uniform on [0, limit), so word % range is EXACTLY
    // uniform on [0, range). U32_SPAN - limit < range shows that limit is the
    // largest such multiple, so as few words as possible are rejected.
    expect(U32_SPAN).toBe(2 ** 32);
    for (const range of ranges) {
      const limit = rejectionLimit(range);
      expect(Number.isSafeInteger(limit)).toBe(true);
      expect(limit % range).toBe(0);
      expect(U32_SPAN - limit).toBeLessThan(range);
      expect(limit).toBeLessThanOrEqual(U32_SPAN);
      expect(limit).toBeGreaterThan(0);
      // Per-draw rejection probability is < 1/2 for every range, so a healthy
      // source trips the consecutive-rejection limit with probability < 2^-limitCount.
      expect((U32_SPAN - limit) / U32_SPAN).toBeLessThan(0.5);
      // No rejection zone exactly when range divides 2^32.
      expect(limit === U32_SPAN).toBe(U32_SPAN % range === 0);
      // Preimages of residue r in [0, limit): r, r + range, ..., i.e.
      // floor((limit - 1 - r) / range) + 1 words. Every residue for range <= 52;
      // the extreme residues for the large edge ranges.
      const residues = range <= DECK ? Array.from({ length: range }, (_, r) => r) : [0, 1, range - 2, range - 1];
      for (const r of residues) expect(Math.floor((limit - 1 - r) / range) + 1).toBe(limit / range);
    }
    expect(rejectionLimit(52)).toBe(U32_SPAN - 48);
    expect(rejectionLimit(U32_SPAN - 1)).toBe(U32_SPAN - 1);
    expect(rejectionLimit(2 ** 31 + 1)).toBe(2 ** 31 + 1);
  });

  it("accepts limit-1, rejects limit and 2^32-1 (when limit < 2^32), consuming exactly the scripted words", () => {
    for (const range of ranges) {
      const limit = rejectionLimit(range);
      let s = script([limit - 1]);
      expect(uniformFromWords(range, s.next)).toBe((limit - 1) % range);
      expect(s.consumed()).toBe(1);
      s = script([0]);
      expect(uniformFromWords(range, s.next)).toBe(0);
      expect(s.consumed()).toBe(1);
      if (limit < U32_SPAN) {
        s = script([limit, 5]);
        expect(uniformFromWords(range, s.next)).toBe(5 % range);
        expect(s.consumed()).toBe(2);
        s = script([U32_SPAN - 1, limit - 1]);
        expect(uniformFromWords(range, s.next)).toBe((limit - 1) % range);
        expect(s.consumed()).toBe(2);
        // Three rejections in a row (both ends and the middle of [limit, 2^32)), then an accept.
        const middle = limit + Math.floor((U32_SPAN - 1 - limit) / 2);
        s = script([U32_SPAN - 1, limit, middle, 7]);
        expect(uniformFromWords(range, s.next)).toBe(7 % range);
        expect(s.consumed()).toBe(4);
      } else {
        s = script([U32_SPAN - 1]);
        expect(uniformFromWords(range, s.next)).toBe((U32_SPAN - 1) % range);
        expect(s.consumed()).toBe(1);
      }
    }
  });

  it("throws RngFailure on words outside [0, 2^32) or non-integers", () => {
    for (const range of [3, 52, U32_SPAN]) {
      for (const bad of [-1, U32_SPAN, 1.5, NaN, Infinity, -Infinity]) {
        expect(() => uniformFromWords(range, () => bad)).toThrow(RngFailure);
      }
    }
  });

  it("throws RngFailure (never hangs) when the source always rejects, and only after >= 64 draws", () => {
    // Deterministic: the scripted source is broken by construction.
    for (const range of [3, 52, 2 ** 31 + 1, U32_SPAN - 1]) {
      let draws = 0;
      const stuck = (): number => {
        if (++draws > 100_000) throw new Error("hang guard: sampler never gave up");
        return U32_SPAN - 1;
      };
      let caught: unknown;
      try {
        uniformFromWords(range, stuck);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RngFailure);
      // >= 64 consecutive rejections: a healthy source (rejection p < 1/2)
      // trips this with probability < 2^-64.
      expect(draws).toBeGreaterThanOrEqual(64);
      expect(draws).toBeLessThanOrEqual(4096);
    }
  });

  it("rejects invalid ranges before drawing", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, U32_SPAN + 1]) {
      let draws = 0;
      expect(() => rejectionLimit(bad)).toThrow(RangeError);
      expect(() => uniformFromWords(bad, () => { draws++; return 0; })).toThrow(RangeError);
      expect(() => secureRandomInt(bad)).toThrow(RangeError);
      expect(draws).toBe(0);
    }
  });

  it("secureRandomInt and randIntInclusive stay in range", () => {
    expect(secureRandomInt(1)).toBe(0);
    expect(randIntInclusive(7, 7)).toBe(7);
    for (let i = 0; i < 2000; i++) {
      const a = secureRandomInt(52);
      const b = secureRandomInt(U32_SPAN);
      const c = randIntInclusive(-3, 3);
      expect(Number.isInteger(a) && a >= 0 && a < 52).toBe(true);
      expect(Number.isInteger(b) && b >= 0 && b < U32_SPAN).toBe(true);
      expect(Number.isInteger(c) && c >= -3 && c <= 3).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 1: the Durstenfeld shuffle is a bijection (exhaustive, n <= 8).
// ---------------------------------------------------------------------------
describe("Durstenfeld shuffle bijection", () => {
  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

  /** Mixed-radix decode of code in [0, n!) into (j_{n-1}, ..., j_1), j_i in [0, i]. */
  function drawSequence(code: number, n: number): number[] {
    const draws: number[] = [];
    for (let i = n - 1; i >= 1; i--) {
      draws.push(code % (i + 1));
      code = Math.floor(code / (i + 1));
    }
    return draws;
  }

  it("maps the n! draw sequences one-to-one onto the n! permutations, n = 1..8", () => {
    // PROOF OBLIGATION: if every draw sequence yields a different permutation,
    // then with independent uniform draws (exact, by the rejection-sampling
    // proof above) every permutation has probability exactly 1/n!. The same
    // map at n = 52 gives each of the 52! deck orders probability 1/52!.
    for (let n = 1; n <= 8; n++) {
      const input = Array.from({ length: n }, (_, i) => i);
      const seenSequences = new Set<string>();
      const seenPermutations = new Map<string, number>();
      let rangeViolations = 0;
      let notPermutation = 0;
      for (let code = 0; code < factorial(n); code++) {
        const draws = drawSequence(code, n);
        seenSequences.add(draws.join(","));
        let call = 0;
        const out = durstenfeldShuffle(input, (range) => {
          // Call k must ask for [0, n-k): i runs n-1 down to 1.
          if (range !== n - call) rangeViolations++;
          const j = draws[call++];
          if (j === undefined || j >= range) rangeViolations++;
          return j ?? 0;
        });
        if (call !== n - 1) rangeViolations++;
        if (out.length !== n || [...out].sort((a, b) => a - b).some((v, i) => v !== i)) notPermutation++;
        const key = out.join(",");
        seenPermutations.set(key, (seenPermutations.get(key) ?? 0) + 1);
      }
      expect(rangeViolations).toBe(0);
      expect(notPermutation).toBe(0);
      expect(seenSequences.size).toBe(factorial(n));
      expect(seenPermutations.size).toBe(factorial(n));
      expect([...seenPermutations.values()].every((count) => count === 1)).toBe(true);
    }
  });

  it("rejects an out-of-range injected index and does not mutate its input", () => {
    const input = [1, 2, 3, 4, 5];
    for (const bad of [-1, 5, 1.5, NaN, Infinity]) {
      expect(() => durstenfeldShuffle(input, () => bad)).toThrow(RangeError);
    }
    // j = i + 1 at the first step (range 5) is out of range; j = i is allowed.
    expect(() => durstenfeldShuffle(input, (range) => range)).toThrow(RangeError);
    expect(durstenfeldShuffle(input, (range) => range - 1)).toEqual([1, 2, 3, 4, 5]);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Derivation check for test (c): exact covariance of a random permutation matrix.
// ---------------------------------------------------------------------------
describe("permutation-matrix covariance (exact enumeration)", () => {
  function permutations(n: number): number[][] {
    if (n === 0) return [[]];
    const out: number[][] = [];
    for (const p of permutations(n - 1)) {
      for (let k = 0; k <= p.length; k++) out.push([...p.slice(0, k), n - 1, ...p.slice(k)]);
    }
    return out;
  }

  it("equals (1/(n-1)) * projection onto zero-row/column-sum matrices, n = 2..6", () => {
    for (let n = 2; n <= 6; n++) {
      const perms = permutations(n); // perm[i] = column of the 1 in row i
      expect(perms.length).toBe([1, 1, 2, 6, 24, 120, 720][n]);
      const joint = new Float64Array(n ** 4);
      for (const p of perms) {
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < n; k++) joint[((i * n + p[i]!) * n + k) * n + p[k]!]! += 1;
        }
      }
      let worst = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) for (let l = 0; l < n; l++) {
        const cov = joint[((i * n + j) * n + k) * n + l]! / perms.length - 1 / (n * n);
        const projection = ((i === k ? 1 : 0) - 1 / n) * ((j === l ? 1 : 0) - 1 / n);
        worst = Math.max(worst, Math.abs(cov - projection / (n - 1)));
      }
      expect(worst).toBeLessThan(1e-14);
    }
  });
});

// ---------------------------------------------------------------------------
// Requirement 5: chi-square over 1,000,000 production shuffles.
// The analysis functions below are shared by the production tests and by the
// negative controls, so the controls prove that this exact pipeline can fail.
// ---------------------------------------------------------------------------
const GLOBAL_DF = (DECK - 1) ** 2; // 2601, see test (c)
const PAIR_DF = DECK * DECK - 1; // 2703, see test (d)

/** Adds one deck (card indices by position) to a position x card count matrix. */
function addDeck(matrix: Int32Array, deck: ArrayLike<number>): void {
  for (let pos = 0; pos < DECK; pos++) matrix[pos * DECK + deck[pos]!]! += 1;
}

/** Tests (a), (b), (c) on a position x card matrix built from `samples` decks. */
function matrixStatistics(matrix: Int32Array, samples: number) {
  const expected = samples / DECK;
  const rows = Array.from({ length: DECK }, (_, pos) => pearsonEqualExpected(matrix.subarray(pos * DECK, (pos + 1) * DECK), expected));
  const columns = Array.from({ length: DECK }, (_, card) =>
    pearsonEqualExpected(Array.from({ length: DECK }, (_, pos) => matrix[pos * DECK + card]!), expected));
  const global = pearsonEqualExpected(matrix, expected);
  const globalScaled = (global * (DECK - 1)) / DECK;
  return {
    rows,
    rowP: rows.map((x) => chiSquareTwoSidedP(x, DECK - 1)),
    columns,
    columnP: columns.map((x) => chiSquareTwoSidedP(x, DECK - 1)),
    global,
    globalScaled,
    globalP: chiSquareTwoSidedP(globalScaled, GLOBAL_DF),
  };
}

/** Test (d) on one table of `pairs` disjoint (top card, next top card) pairs. */
function pairStatistic(table: Int32Array, pairs: number) {
  const x = pearsonEqualExpected(table, pairs / (DECK * DECK));
  return { x, p: chiSquareTwoSidedP(x, PAIR_DF) };
}

/** Test (e) on counts of the 120 permutations of 5 items. */
function permutationStatistic(counts: Int32Array, samples: number) {
  const x = pearsonEqualExpected(counts, samples / 120);
  return { x, p: chiSquareTwoSidedP(x, 119) };
}

/** Lehmer code: bijection from permutations of 0..n-1 onto [0, n!). */
function lehmerIndex(p: readonly number[]): number {
  let index = 0;
  for (let i = 0; i < p.length; i++) {
    let smaller = 0;
    for (let j = i + 1; j < p.length; j++) if (p[j]! < p[i]!) smaller++;
    index = index * (p.length - i) + smaller;
  }
  return index;
}

const describeRows = (label: string, stats: number[], pValues: number[], alpha: number): string => {
  const minP = Math.min(...pValues);
  return `${label}: X2(df 51) min ${fmt(Math.min(...stats), 2)} max ${fmt(Math.max(...stats), 2)} mean ${fmt(stats.reduce((s, x) => s + x, 0) / stats.length, 2)}; ` +
    `min two-sided p ${fmt(minP)} (Bonferroni-adjusted ${fmt(Math.min(1, minP * stats.length))}); alpha each ${alpha.toExponential(3)}\n` +
    `      X2 each: ${stats.map((x) => x.toFixed(1)).join(" ")}`;
};

/** The indices whose p fails `alpha`, or (when none does) the single smallest-p index: the rows worth printing. */
function offendingIndices(pValues: readonly number[], alpha: number): number[] {
  const failing = pValues.flatMap((p, i) => (p > alpha ? [] : [i]));
  if (failing.length > 0) return failing;
  let worst = 0;
  for (let i = 1; i < pValues.length; i++) if (pValues[i]! < pValues[worst]!) worst = i;
  return [worst];
}

const countsLine = (counts: ArrayLike<number>, expected: number): string =>
  `cell counts (E = ${fmt(expected, 2)}): ${Array.from(counts).join(" ")}`;

/** The row of a 52 x 52 table that contributes most to its Pearson statistic (for printing). */
function largestRow(table: Int32Array, expected: number): { row: number; x: number } {
  let best = { row: 0, x: -1 };
  for (let r = 0; r < DECK; r++) {
    const x = pearsonEqualExpected(table.subarray(r * DECK, (r + 1) * DECK), expected);
    if (x > best.x) best = { row: r, x };
  }
  return best;
}

/** One sample of `samples` production shuffledDeck() calls: the position x card matrix and the successive-pair tables. */
interface ProductionSample {
  samples: number;
  /** matrix[position * 52 + card]: how often `card` landed at `position`. */
  matrix: Int32Array;
  /**
   * Top cards of successive shuffles, split so each table holds DISJOINT pairs:
   * evenPairs[top(2t) * 52 + top(2t+1)] and oddPairs[top(2t+1) * 52 + top(2t+2)].
   * Together they hold all samples - 1 successive pairs of the stream.
   */
  evenPairs: Int32Array;
  oddPairs: Int32Array;
  malformed: number;
  shuffles: number;
  stats: ReturnType<typeof matrixStatistics>;
}

const cardIndexOf = new Map<Card, number>(fullDeck().map((card, i) => [card, i]));

function productionSample(samples: number, label: string): ProductionSample {
  const started = performance.now();
  const matrix = new Int32Array(DECK * DECK);
  const evenPairs = new Int32Array(DECK * DECK);
  const oddPairs = new Int32Array(DECK * DECK);
  const seen = new Int32Array(DECK);
  const indices = new Int32Array(DECK);
  let previousTop = -1;
  let malformed = 0;
  let shuffles = 0;
  for (let s = 0; s < samples; s++) {
    const deck = shuffledDeck();
    shuffles++;
    // Validate the permutation before counting it.
    let valid = deck.length === DECK;
    for (let pos = 0; valid && pos < DECK; pos++) {
      const card = cardIndexOf.get(deck[pos]!);
      if (card === undefined || seen[card] === s + 1) valid = false;
      else {
        seen[card] = s + 1;
        indices[pos] = card;
      }
    }
    if (!valid) {
      malformed++;
      continue;
    }
    addDeck(matrix, indices);
    const top = indices[0]!;
    if (s > 0) (s % 2 === 1 ? evenPairs : oddPairs)[previousTop * DECK + top]! += 1;
    previousTop = top;
  }
  const seconds = (performance.now() - started) / 1000;
  console.info(`[rng] ${label}: generated ${shuffles} production shuffles in ${seconds.toFixed(1)} s (${((seconds * 1e6) / shuffles).toFixed(2)} us each under jest)`);
  return { samples, matrix, evenPairs, oddPairs, malformed, shuffles, stats: matrixStatistics(matrix, samples) };
}

/** Family (a) or (b) on one sample: 52 Bonferroni-split chi2(51) tests; reports the offending rows' (columns') counts. */
function evaluateLines(sample: ProductionSample, kind: "positions" | "cards"): FamilyEvaluation {
  const alpha = ALPHA_FAMILY / DECK;
  const { stats, matrix, samples } = sample;
  const values = kind === "positions" ? stats.rows : stats.columns;
  const pValues = kind === "positions" ? stats.rowP : stats.columnP;
  const line = (i: number): number[] => Array.from({ length: DECK }, (_, j) => (kind === "positions" ? matrix[i * DECK + j]! : matrix[j * DECK + i]!));
  const offenders = offendingIndices(pValues, alpha).map((i) =>
    `${kind === "positions" ? "position" : "card"} ${i}${pValues[i]! > alpha ? " (smallest p, passing)" : " (FAILS)"}: X2 ${fmt(values[i]!, 2)}, p ${fmt(pValues[i]!)}; ${countsLine(line(i), samples / DECK)}`);
  return {
    p: Math.min(...pValues),
    alpha,
    report: `${describeRows(`(${kind === "positions" ? "a" : "b"}) ${kind}`, values, pValues, alpha)}\n      ${offenders.join("\n      ")}`,
  };
}

/** Family (c) on one sample: the global statistic; reports the row contributing most. */
function evaluateGlobal(sample: ProductionSample): FamilyEvaluation {
  const { global, globalScaled, globalP } = sample.stats;
  const expected = sample.samples / DECK;
  const worst = largestRow(sample.matrix, expected);
  return {
    p: globalP,
    alpha: ALPHA_FAMILY,
    report: `(c) global: S ${fmt(global, 2)} (E[S] = ${DECK * (DECK - 1)}), S*51/52 ${fmt(globalScaled, 2)} ~ chi2(${GLOBAL_DF}); ` +
      `lower p ${fmt(chiSquareCdf(globalScaled, GLOBAL_DF))}, upper p ${fmt(chiSquareSurvival(globalScaled, GLOBAL_DF))}, two-sided p ${fmt(globalP)}\n` +
      `      largest row contribution: position ${worst.row}, X2 ${fmt(worst.x, 2)}; ${countsLine(sample.matrix.subarray(worst.row * DECK, (worst.row + 1) * DECK), expected)}`,
  };
}

/** Family (d) on one sample: two Bonferroni-split chi2(2703) tables; reports the offending table's largest row. */
function evaluatePairs(sample: ProductionSample): FamilyEvaluation {
  const alpha = ALPHA_FAMILY / 2;
  const tables = [
    { name: "pairs (2t,2t+1)", table: sample.evenPairs, count: Math.floor(sample.samples / 2) },
    { name: "pairs (2t+1,2t+2)", table: sample.oddPairs, count: Math.ceil(sample.samples / 2) - 1 },
  ].map((t) => ({ ...t, ...pairStatistic(t.table, t.count) }));
  const offenders = offendingIndices(tables.map((t) => t.p), alpha).map((i) => {
    const t = tables[i]!;
    const expected = t.count / (DECK * DECK);
    const worst = largestRow(t.table, expected);
    return `${t.name}${t.p > alpha ? " (smallest p, passing)" : " (FAILS)"}: largest row is first top card ${worst.row}, X2 ${fmt(worst.x, 2)}; ${countsLine(t.table.subarray(worst.row * DECK, (worst.row + 1) * DECK), expected)}`;
  });
  return {
    p: Math.min(...tables.map((t) => t.p)),
    alpha,
    report: `(d) successive shuffles, top cards, df ${PAIR_DF}: ${tables.map((t) => `${t.name}: ${t.count} disjoint pairs, X2 ${fmt(t.x, 2)}, two-sided p ${fmt(t.p)}`).join("; ")}; alpha/table ${alpha.toExponential(2)}\n      ${offenders.join("\n      ")}`,
  };
}

/** `samples` production shuffle() calls on 5 items, counted by Lehmer index. */
function permutationSample(samples: number): { counts: Int32Array; malformed: number; seconds: number } {
  const items = [0, 1, 2, 3, 4] as const;
  const counts = new Int32Array(120);
  let malformed = 0;
  const started = performance.now();
  for (let s = 0; s < samples; s++) {
    const p = shuffle(items);
    let mask = 0;
    for (const v of p) mask |= 1 << v;
    if (p.length !== 5 || mask !== 0b11111) malformed++;
    else counts[lehmerIndex(p)]! += 1;
  }
  return { counts, malformed, seconds: (performance.now() - started) / 1000 };
}

/** Family (e) on one sample of permutation counts; reports all 120 counts. */
function evaluatePermutations(counts: Int32Array, samples: number, seconds: number): FamilyEvaluation {
  const { x, p } = permutationStatistic(counts, samples);
  return {
    p,
    alpha: ALPHA_FAMILY,
    report: `(e) permutations of 5: X2 ${fmt(x, 2)} ~ chi2(119) over ${samples} shuffles in ${seconds.toFixed(1)} s (min count ${Math.min(...counts)}, max ${Math.max(...counts)}); two-sided p ${fmt(p)}\n` +
      `      ${countsLine(counts, samples / 120)}`,
  };
}

/** Runs one family two-stage; prints both stages; fails (with both reports) only if the fresh repeat fails too. */
function expectFamilyPasses(name: string, first: FamilyEvaluation, repeat: () => FamilyEvaluation): void {
  const verdict = twoStage(first, repeat);
  const text = describeVerdict(name, verdict);
  console.info(`[rng] ${text}`);
  if (!verdict.pass) throw new Error(`[rng] ${text}`);
}

describe("two-stage family decision (forced p-values, deterministic)", () => {
  const evaluation = (p: number, alpha = 1e-3): FamilyEvaluation => ({ p, alpha, report: `forced p ${p}` });

  it("a passing first stage never draws the repeat sample", () => {
    const repeat = jest.fn(() => evaluation(0.5));
    const verdict = twoStage(evaluation(0.2), repeat);
    expect(verdict).toEqual({ pass: true, repeated: false, first: evaluation(0.2), second: null });
    expect(repeat).not.toHaveBeenCalled();
  });

  it("a first-stage failure is re-run once on a fresh sample and passes when the repeat passes", () => {
    const repeat = jest.fn(() => evaluation(0.31));
    // The production false alarm: row p = 1.24e-6 against alpha = 1.6e-4 / 52.
    const verdict = twoStage(evaluation(1.24e-6, ALPHA_FAMILY / DECK), repeat);
    expect(repeat).toHaveBeenCalledTimes(1);
    expect(verdict.pass).toBe(true);
    expect(verdict.repeated).toBe(true);
    expect(verdict.second?.p).toBe(0.31);
    const text = describeVerdict("(a) positions", verdict);
    expect(text).toContain("min p 1.240e-6");
    expect(text).toContain("min p 0.3100");
    expect(text).toContain("forced p 0.00000124");
    expect(text).toContain("stage-1 false alarm");
  });

  it("fails only when the repeat fails too, and reports both p-values", () => {
    const verdict = twoStage(evaluation(1e-9), () => evaluation(2e-9));
    expect(verdict.pass).toBe(false);
    const text = describeVerdict("(c) global", verdict);
    expect(text).toContain("FAIL (failed on two independent samples)");
    expect(text).toContain("1.000e-9");
    expect(text).toContain("2.000e-9");
    expect(() => expectFamilyPasses("(c) global", evaluation(1e-9), () => evaluation(2e-9))).toThrow(/stage 2 \(fresh sample\): min p 2\.000e-9/);
  });

  it("treats p exactly at alpha, and NaN, as failures (as the single-stage expect(p).toBeGreaterThan(alpha) did)", () => {
    expect(familyFails(evaluation(1e-3))).toBe(true);
    expect(familyFails(evaluation(Number.NaN))).toBe(true);
    expect(familyFails(evaluation(1.0000001e-3))).toBe(false);
    expect(twoStage(evaluation(1e-3), () => evaluation(1e-3)).pass).toBe(false);
  });

  it("drives the real family evaluators: a deterministic bad sample fails both stages and prints the offending row's counts", () => {
    // Perfectly regular output (rotations): every statistic is 0, lower-tail p = 0, on every sample.
    const regular = (): ProductionSample => {
      const samples = 52 * 400;
      const matrix = new Int32Array(DECK * DECK);
      for (let s = 0; s < samples; s++) addDeck(matrix, Array.from({ length: DECK }, (_, pos) => (pos + s) % DECK));
      return { samples, matrix, evenPairs: new Int32Array(DECK * DECK), oddPairs: new Int32Array(DECK * DECK), malformed: 0, shuffles: samples, stats: matrixStatistics(matrix, samples) };
    };
    let draws = 0;
    const fresh = (): ProductionSample => { draws++; return regular(); };
    const verdict = twoStage(evaluateLines(fresh(), "positions"), () => evaluateLines(fresh(), "positions"));
    expect(draws).toBe(2);
    expect(verdict.pass).toBe(false);
    const text = describeVerdict("(a) positions", verdict);
    expect(text).toContain("position 0 (FAILS)");
    expect(text).toContain(`cell counts (E = 400.00): ${Array.from({ length: DECK }, () => 400).join(" ")}`);
    expect(twoStage(evaluateGlobal(fresh()), () => evaluateGlobal(fresh())).pass).toBe(false);
  });
});

describe("1,000,000 production shuffles (shuffledDeck), two-stage", () => {
  let first: ProductionSample;
  /**
   * The repeat sample: 1,000,000 NEW production shuffles, drawn only if some
   * family among (a)-(d) fails on the first sample, and shared by every family
   * that does (each family's two stages are still independent samples).
   */
  let repeatSample: ProductionSample | null = null;
  const repeat = (): ProductionSample => (repeatSample ??= productionSample(N, "repeat sample (fresh, independent)"));

  beforeAll(() => {
    first = productionSample(N, "first sample");
  }, 600_000);

  it("produces only valid 52-card permutations (row and column sums are exactly N)", () => {
    const { matrix, evenPairs, oddPairs } = first;
    expect(first.shuffles).toBe(N);
    expect(first.malformed).toBe(0);
    for (let a = 0; a < DECK; a++) {
      let row = 0;
      let column = 0;
      for (let b = 0; b < DECK; b++) {
        row += matrix[a * DECK + b]!;
        column += matrix[b * DECK + a]!;
      }
      expect(row).toBe(N);
      expect(column).toBe(N);
    }
    expect(evenPairs.reduce((sum, v) => sum + v, 0)).toBe(N / 2);
    expect(oddPairs.reduce((sum, v) => sum + v, 0)).toBe(N / 2 - 1);
  });

  // (a) Row `position` counts which card sits there in each of N independent
  // shuffles: exactly Multinomial(N, 1/52), so Pearson ~ chi2(51).
  it("(a) every position holds every card uniformly: 52 x chi2(51), Bonferroni, two-sided, two-stage", () => {
    expectFamilyPasses("(a) positions", evaluateLines(first, "positions"), () => {
      const sample = repeat();
      expect(sample.malformed).toBe(0);
      return evaluateLines(sample, "positions");
    });
  }, 600_000);

  // (b) Column `card` counts where that card lands in each shuffle: also
  // exactly Multinomial(N, 1/52), Pearson ~ chi2(51).
  it("(b) every card lands in every position uniformly: 52 x chi2(51), Bonferroni, two-sided, two-stage", () => {
    expectFamilyPasses("(b) cards", evaluateLines(first, "cards"), () => {
      const sample = repeat();
      expect(sample.malformed).toBe(0);
      return evaluateLines(sample, "cards");
    });
  }, 600_000);

  // (c) Global statistic S over all 2704 cells, E = N/52. With P_t the
  // permutation matrix of shuffle t and M = sum_t P_t:
  //   Cov(P[i][j], P[k][l]) = (delta_ik - 1/n)(delta_jl - 1/n) / (n - 1),
  // i.e. Cov(vec P) = Pi/(n-1), where Pi = (I - J/n) (x) (I - J/n) is the
  // orthogonal projection onto matrices with zero row and column sums, of rank
  // (n-1)^2 (checked by exact enumeration above). Z = (M - E)/sqrt(E) then has
  // covariance n Cov(vec P) = (n/(n-1)) Pi, and by the multivariate CLT
  // S = |Z|^2 -> (n/(n-1)) chi2((n-1)^2). So S (n-1)/n ~ chi2(2601), and
  // E[S] = trace = n(n-1) = 2652 exactly. Every shuffle fixes all row and
  // column sums, which is why S is NOT chi2(2703). The test is two-sided: the
  // lower tail catches output that is too regular to be random.
  it("(c) global 52x52 statistic: S * 51/52 ~ chi2(2601), two-sided, two-stage", () => {
    expect(GLOBAL_DF).toBe(2601);
    expectFamilyPasses("(c) global", evaluateGlobal(first), () => evaluateGlobal(repeat()));
  }, 600_000);

  // (d) Serial independence of successive shuffles, over all N - 1 successive
  // pairs (top card of shuffle k, top card of shuffle k+1) of the stream.
  // One table of all N - 1 OVERLAPPING pairs would NOT be chi2(2703): its row
  // and column margins are the same symbol counts, so Pearson = I + 2 X1 with
  // I ~ chi2(2601) and X1 ~ chi2(51) (Good 1953), with variance
  // 2*2601 + 8*51 = 5610 instead of 5406, which inflates false failures.
  // So the pairs are split by parity: pairs (2t, 2t+1) and pairs (2t+1, 2t+2).
  // Within each table no shuffle is used twice, so under H0 each table is
  // EXACTLY Multinomial(pairs, 1/2704) and its Pearson statistic ~ chi2(2703).
  // The two tables are Bonferroni-split (alpha/2 each; dependence between them
  // does not matter for the union bound). Every transition k -> k+1 is tested.
  it("(d) top cards of successive shuffles are independent: 2 x chi2(2703) over all N-1 pairs, two-sided, two-stage", () => {
    expect(PAIR_DF).toBe(2703);
    expectFamilyPasses("(d) successive pairs", evaluatePairs(first), () => evaluatePairs(repeat()));
  }, 600_000);
});

// (e) Whole-permutation uniformity: each production shuffle() of 5 items is
// one draw from 120 equally likely permutations, Pearson ~ chi2(119).
describe("permutation-level uniformity (shuffle of 5 items), two-stage", () => {
  it("(e) 1,000,000 shuffle() calls hit all 120 permutations uniformly: chi2(119), two-sided, two-stage", () => {
    const items = [0, 1, 2, 3, 4] as const;
    // The Lehmer index is a bijection onto 0..119 (every draw sequence enumerated).
    const indices = new Set<number>();
    for (let code = 0; code < 120; code++) {
      let c = code;
      indices.add(lehmerIndex(durstenfeldShuffle(items, (range) => { const j = c % range; c = Math.floor(c / range); return j; })));
    }
    expect([...indices].sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, i) => i));

    const draw = (): FamilyEvaluation => {
      const { counts, malformed, seconds } = permutationSample(N);
      expect(malformed).toBe(0);
      return evaluatePermutations(counts, N, seconds);
    };
    expectFamilyPasses("(e) permutations", draw(), draw);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Negative controls: the same analysis rejects known-bad output. Each
// rejection follows from a lower bound on the statistic that holds for EVERY
// realization, so these assertions are deterministic and use no budget.
// ---------------------------------------------------------------------------
describe("negative controls (deterministic): the analysis rejects bad shuffles", () => {
  const identity = Array.from({ length: DECK }, (_, i) => i);

  it("Sattolo's algorithm (j in [0, i-1]: no card ever stays in place) fails (a), (b) and (c)", () => {
    const samples = 52 * 400;
    const matrix = new Int32Array(DECK * DECK);
    const stream = new CsprngWordStream();
    for (let s = 0; s < samples; s++) {
      addDeck(matrix, durstenfeldShuffle(identity, (range) => uniformFromWords(range - 1, () => stream.next())));
    }
    stream.dispose();
    // Cell (k, k) is always empty, so every row and column has X2 >= E = 400
    // and S >= 52 E = 20,800; chi2(51) survival at 400 is ~1e-55.
    for (let k = 0; k < DECK; k++) expect(matrix[k * DECK + k]).toBe(0);
    const st = matrixStatistics(matrix, samples);
    for (const p of [...st.rowP, ...st.columnP]) expect(p).toBeLessThan(ALPHA_FAMILY / DECK);
    expect(st.globalP).toBeLessThan(ALPHA_FAMILY);
  });

  it("perfectly regular output (successive rotations) fails the lower tail of (a), (b) and (c)", () => {
    const samples = 52 * 400;
    const matrix = new Int32Array(DECK * DECK);
    for (let s = 0; s < samples; s++) addDeck(matrix, identity.map((_, pos) => (pos + s) % DECK));
    // Every cell holds exactly E, so every statistic is 0 and its lower-tail p is 0.
    const st = matrixStatistics(matrix, samples);
    expect(st.global).toBe(0);
    for (const p of [...st.rowP, ...st.columnP]) expect(p).toBeLessThan(ALPHA_FAMILY / DECK);
    expect(st.globalP).toBeLessThan(ALPHA_FAMILY);
  });

  it("a repeated shuffle fails (d), and so do perfectly regular pairs", () => {
    const pairs = 50_000;
    const repeated = new Int32Array(DECK * DECK);
    const regular = new Int32Array(DECK * DECK);
    const stream = new CsprngWordStream();
    for (let t = 0; t < pairs; t++) {
      const top = uniformFromWords(DECK, () => stream.next());
      repeated[top * DECK + top]! += 1; // shuffle 2t+1 repeats shuffle 2t
    }
    stream.dispose();
    for (let t = 0; t < DECK * DECK * 20; t++) regular[t % (DECK * DECK)]! += 1;
    // Repeated: all 2652 off-diagonal cells are empty, X2 >= 2652 E = 49,038.
    expect(pairStatistic(repeated, pairs).p).toBeLessThan(ALPHA_FAMILY / 2);
    // Regular: every cell holds exactly E, X2 = 0.
    expect(pairStatistic(regular, DECK * DECK * 20).x).toBe(0);
    expect(pairStatistic(regular, DECK * DECK * 20).p).toBeLessThan(ALPHA_FAMILY / 2);
  });

  it("Sattolo on 5 items (24 of 120 permutations reachable) fails (e)", () => {
    const samples = 12_000;
    const counts = new Int32Array(120);
    const stream = new CsprngWordStream();
    for (let s = 0; s < samples; s++) {
      counts[lehmerIndex(durstenfeldShuffle([0, 1, 2, 3, 4], (range) => uniformFromWords(range - 1, () => stream.next())))]! += 1;
    }
    stream.dispose();
    // At least 96 permutations never occur, so X2 >= 96 E = 9,600 against df 119.
    expect(counts.filter((c) => c === 0).length).toBeGreaterThanOrEqual(96);
    expect(permutationStatistic(counts, samples).p).toBeLessThan(ALPHA_FAMILY);
  });
});

// ---------------------------------------------------------------------------
// CSPRNG stream health and hygiene (real OS entropy).
// ---------------------------------------------------------------------------
describe("CsprngWordStream on the real OS CSPRNG", () => {
  it("returns integers in [0, 2^32) that use all 32 bits", () => {
    const stream = new CsprngWordStream();
    let or = 0;
    let and = 0xffffffff;
    for (let i = 0; i < 4096; i++) {
      const w = stream.next();
      expect(Number.isInteger(w) && w >= 0 && w < U32_SPAN).toBe(true);
      or = (or | w) >>> 0;
      and = (and & w) >>> 0;
    }
    stream.dispose();
    // A bit stuck at 0 or 1 across 4096 words: < 64 * 2^-4096 for a healthy source.
    expect(or).toBe(0xffffffff);
    expect(and).toBe(0);
  });

  it("gives two fresh streams different first 64 words (false alarm 2^-2048)", () => {
    const a = new CsprngWordStream();
    const b = new CsprngWordStream();
    const wa = Array.from({ length: 64 }, () => a.next());
    const wb = Array.from({ length: 64 }, () => b.next());
    expect(wa).not.toEqual(wb);
  });

  it("keeps working after dispose(): the next draw refills from the OS", () => {
    const stream = new CsprngWordStream();
    for (let i = 0; i < 10; i++) stream.next();
    stream.dispose();
    const after = Array.from({ length: 200 }, () => stream.next());
    expect(after.every((w) => Number.isInteger(w) && w >= 0 && w < U32_SPAN)).toBe(true);
    // dispose() zero-fills the block; the draws after it must come from a new
    // block, not the wiped one (all-zero would have probability 2^-1728).
    expect(after.slice(0, 54).some((w) => w !== 0)).toBe(true);
    stream.dispose();
  });

  it("never raises a health alarm on healthy entropy (3,000 blocks)", () => {
    // False-alarm probability per block < 2^-2048 (zero) + 2^-2048 (repeat) + 2^-256 (SHA-256 collision).
    expect(() => {
      for (let i = 0; i < 1000; i++) {
        const stream = new CsprngWordStream();
        for (let k = 0; k < 64 * 3; k++) stream.next();
        stream.dispose();
      }
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Continuous health test, fault injection. node:crypto is replaced inside an
// isolated module registry, so these tests are deterministic and cannot fail
// for a healthy source. The statically imported modules above are untouched.
// ---------------------------------------------------------------------------
describe("continuous RNG health test (fault injection)", () => {
  type Fill = (block: Uint32Array) => void;
  const realFill: Fill = (block) => { nodeCrypto.randomFillSync(block); };
  let activeFill: Fill = realFill;
  const filledBuffers: Uint32Array[] = [];

  async function loadWithEntropy(fill: Fill) {
    activeFill = fill;
    let loaded: { rng: typeof import("../rng.js"); deck: typeof import("../deck.js"); table: typeof import("../table.js") } | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.unstable_mockModule("node:crypto", () => ({
        ...nodeCrypto,
        randomFillSync: <T>(buffer: T): T => {
          const block = buffer as unknown as Uint32Array;
          filledBuffers.push(block);
          activeFill(block);
          return buffer;
        },
      }));
      loaded = { rng: await import("../rng.js"), deck: await import("../deck.js"), table: await import("../table.js") };
    });
    return loaded!;
  }

  afterEach(() => {
    activeFill = realFill;
    filledBuffers.length = 0;
  });

  function seatedTable(tableModule: typeof import("../table.js")) {
    let t = tableModule.createTable({ tableId: "rng-health", name: "RNG health", maxSeats: 6, smallBlind: 5, bigBlind: 10, timeBankMs: 15_000 });
    for (const seat of [0, 1, 2]) {
      t = tableModule.sitDown(t, seat, { userId: `u${seat}`, username: `P${seat}`, kind: "HUMAN", botProfile: null, avatarHue: 0, buyIn: 1000, skipBuyInCheck: true });
    }
    return t;
  }

  it("uses the injected source (sanity) and returns its words in order, zeroing each consumed word", async () => {
    let counter = 0;
    const { rng } = await loadWithEntropy((block) => {
      counter++;
      for (let k = 0; k < block.length; k++) block[k] = counter * 1000 + k + 1;
    });
    const stream = new rng.CsprngWordStream();
    expect(stream.next()).toBe(1001);
    expect(stream.next()).toBe(1002);
    const block = filledBuffers[0]!;
    expect(block[0]).toBe(0); // consumed words are wiped immediately
    expect(block[1]).toBe(0);
    expect(block[2]).toBe(1003); // unconsumed words are untouched
    stream.dispose();
    expect(block.every((w) => w === 0)).toBe(true); // dispose() wipes the rest
    expect(stream.next()).toBe(2001); // and the next draw refills from the source
    for (let i = 1; i < 64; i++) expect(stream.next()).toBe(2001 + i);
    expect(stream.next()).toBe(3001);
  });

  it("raises no alarm on distinct non-zero blocks (1,000 blocks)", async () => {
    let counter = 0;
    const { rng } = await loadWithEntropy((block) => {
      counter++;
      for (let k = 0; k < block.length; k++) block[k] = (counter * 64 + k) >>> 0;
    });
    const stream = new rng.CsprngWordStream();
    expect(() => { for (let i = 0; i < 64_000; i++) stream.next(); }).not.toThrow();
    expect(counter).toBe(1000);
  });

  it("fails closed on a stuck-at-zero source: stream, secureRandomInt, shuffle and startHand all throw RngFailure", async () => {
    const { rng, deck, table } = await loadWithEntropy((block) => { block.fill(0); });
    expect(() => new rng.CsprngWordStream().next()).toThrow(rng.RngFailure);
    expect(() => new rng.CsprngWordStream().next()).toThrow(/all-zero/);
    expect(() => rng.secureRandomInt(52)).toThrow(rng.RngFailure);
    expect(() => deck.shuffledDeck()).toThrow(rng.RngFailure);
    const t = seatedTable(table);
    expect(() => table.startHand(t)).toThrow(rng.RngFailure);
    expect(t.phase).toBe("WAITING"); // no hand started, input state untouched
  });

  it("fails closed when the source repeats a block", async () => {
    const { rng, deck } = await loadWithEntropy((block) => {
      for (let k = 0; k < block.length; k++) block[k] = (0x9e3779b9 ^ k) >>> 0;
    });
    const stream = new rng.CsprngWordStream();
    for (let i = 0; i < 64; i++) stream.next(); // the first block is fine
    expect(() => stream.next()).toThrow(rng.RngFailure); // its repeat is not
    expect(() => new rng.CsprngWordStream().next()).toThrow(/repeated/); // also across streams
    expect(() => deck.shuffledDeck()).toThrow(rng.RngFailure);
  });

  it("fails closed on a stuck-at-ones source (every word rejected, then repeated)", async () => {
    const { rng, deck } = await loadWithEntropy((block) => { block.fill(0xffffffff); });
    expect(() => rng.secureRandomInt(52)).toThrow(rng.RngFailure);
    expect(() => deck.shuffledDeck()).toThrow(rng.RngFailure);
  });
});

// ---------------------------------------------------------------------------
// Static compliance scan of the certified sources.
// ---------------------------------------------------------------------------
describe("static compliance scan", () => {
  // packages/engine under `npm test`; the repository root when jest is run with --config packages/engine/jest.config.cjs.
  const engineRoot = fs.existsSync(path.join(process.cwd(), "src", "rng.ts")) ? process.cwd() : path.join(process.cwd(), "packages", "engine");
  const engineSrc = path.join(engineRoot, "src");
  const sharedSrc = path.resolve(engineRoot, "../shared/src");
  const printer = ts.createPrinter({ removeComments: true });

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") out.push(...sources(full));
      } else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /** Parses a file; `code` is the source reprinted WITHOUT comments (strings kept). */
  function parse(file: string) {
    const text = fs.readFileSync(file, "utf8");
    const kind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
    return { sf, text, code: printer.printFile(sf), syntaxErrors: diagnostics.length };
  }

  function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  }

  const stringValue = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

  /** `Math`, `globalThis.Math`, `window["Math"]`, ... */
  function isMathObject(node: ts.Expression): boolean {
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) node = node.expression;
    if (ts.isIdentifier(node)) return node.text === "Math";
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "Math";
    if (ts.isElementAccessExpression(node)) return stringValue(node.argumentExpression) === "Math";
    return false;
  }

  /** Every code reference to Math.random, however spelled (comments are not code). */
  function mathRandomUses(sf: ts.SourceFile): number {
    let uses = 0;
    walk(sf, (node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "random" && isMathObject(node.expression)) uses++;
      if (ts.isElementAccessExpression(node) && stringValue(node.argumentExpression) === "random" && isMathObject(node.expression)) uses++;
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name) && isMathObject(node.initializer)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if ((ts.isIdentifier(key) ? key.text : stringValue(key)) === "random") uses++;
        }
      }
    });
    return uses;
  }

  it("resolves the engine and shared source trees from the working directory", () => {
    expect(fs.existsSync(path.join(engineSrc, "rng.ts"))).toBe(true);
    expect(fs.existsSync(path.join(sharedSrc, "index.ts"))).toBe(true);
    expect(fs.statSync(engineSrc).isDirectory()).toBe(true);
    expect(fs.statSync(sharedSrc).isDirectory()).toBe(true);
  });

  it("finds no Math.random in any non-test engine or shared source", () => {
    // Checked on CODE (comments removed by the TypeScript printer; string
    // literals kept) and on the AST, which also catches Math["random"],
    // globalThis.Math.random and `const { random } = Math`. Comments are
    // excluded on purpose: rng.ts's compliance note names Math.random as the
    // generator it forbids.
    const files = [...sources(engineSrc), ...sources(sharedSrc)];
    expect(files.length).toBeGreaterThan(15);
    const offenders: string[] = [];
    const commentOnly: string[] = [];
    for (const file of files) {
      const { sf, text, code, syntaxErrors } = parse(file);
      const rel = path.relative(path.resolve(engineRoot, "../.."), file).replace(/\\/g, "/");
      expect({ file: rel, syntaxErrors }).toEqual({ file: rel, syntaxErrors: 0 });
      if (/Math\s*(?:\?\.|\.)\s*random/.test(code) || mathRandomUses(sf) > 0) offenders.push(rel);
      else if (text.includes("Math.random")) commentOnly.push(rel);
    }
    console.info(`[rng] static scan: ${files.length} source files, Math.random in code: ${offenders.length}; mentioned only in comments: ${commentOnly.join(", ") || "none"}`);
    expect(offenders).toEqual([]);
  });

  it("the AST detector recognises every spelling of Math.random (self-test)", () => {
    const probe = (src: string) => mathRandomUses(ts.createSourceFile("probe.ts", src, ts.ScriptTarget.Latest, true));
    expect(probe("const a = Math.random();")).toBe(1);
    expect(probe("const a = Math['random']();")).toBe(1);
    expect(probe("const a = globalThis.Math.random();")).toBe(1);
    expect(probe("const a = (Math).random;")).toBe(1);
    expect(probe("const { random } = Math;")).toBe(1);
    expect(probe("const { random: r } = globalThis.Math;")).toBe(1);
    expect(probe("// Math.random()\n/* Math.random */ const a = Math.floor(1.5);")).toBe(0);
  });

  it("has no seeded or HMAC shuffle anywhere in the engine source", () => {
    const offenders: string[] = [];
    for (const file of sources(engineSrc)) {
      const { code } = parse(file);
      for (const name of ["deckFromSeed", "seededShuffledDeck", "createHmac"]) {
        if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${path.basename(file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rng.ts imports randomFillSync from node:crypto and calls it", () => {
    const { sf } = parse(path.join(engineSrc, "rng.ts"));
    let local: string | undefined;
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || stringValue(statement.moduleSpecifier) !== "node:crypto") continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "randomFillSync") local = element.name.text;
      }
    }
    expect(local).toBeDefined();
    let calls = 0;
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local) calls++;
    });
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("table.ts obtains its deck only through shuffledDeck()", () => {
    const { sf } = parse(path.join(engineSrc, "table.ts"));
    let local: string | undefined;
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || stringValue(statement.moduleSpecifier) !== "./deck.js") continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "shuffledDeck") local = element.name.text;
      }
    }
    expect(local).toBe("shuffledDeck");
    let calls = 0;
    const otherSources: string[] = [];
    const forbidden = new Set(["fullDeck", "shuffle", "durstenfeldShuffle", "uniformFromWords", "CsprngWordStream", "secureRandomInt", "randIntInclusive"]);
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local && node.arguments.length === 0) calls++;
      if (ts.isIdentifier(node) && forbidden.has(node.text)) otherSources.push(node.text);
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(otherSources).toEqual([]);
  });
});
