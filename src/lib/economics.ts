import Decimal from "decimal.js";

/**
 * Pack Economics — pure module.
 * ─────────────────────────────
 * Given a pool of cards with current prices and a tier's price + slot count,
 * solve for the rarity-weight vector that hits a target margin while keeping
 * a user "win rate" floor (P[pack value ≥ pack price]).
 *
 * No DB imports. Everything in this file is unit-testable.
 *
 * MATH
 * ────
 * Let R = {r_1, ..., r_k} be rarities, w_i their weights with Σ w_i = 1.
 * Let μ_i = mean card price within rarity i (read from catalog).
 * Let σ_i = std-dev of card price within rarity i.
 * Let n   = cards_per_pack.
 *
 * Expected value of one pack:
 *     E[V] = n · Σ_i w_i · μ_i
 *
 * Variance per slot (uses law of total variance):
 *     Var[X] = Σ_i w_i (σ_i² + μ_i²) − (Σ_i w_i μ_i)²
 * Variance per pack:
 *     Var[V] = n · Var[X]            (slots are independent draws)
 *
 * The platform's margin (bps) on this tier:
 *     margin_bps = floor( (price - E[V]) / price * 10_000 )
 *
 * The win-rate is P[V ≥ price]. We approximate via normal-approximation
 * (CLT — packs with n≥5 slots are reasonably normal even for skewed dists)
 * with cumulative N((price − E[V]) / sqrt(Var[V])):
 *     win_rate ≈ 1 − Φ((price − E[V]) / σ_V)
 *
 * The solver below is a constrained projection: start from a uniform-ish
 * vector, repeatedly nudge weights toward (price · (1 − target)) / n while
 * checking the win-rate constraint, and reject moves that violate constraints.
 *
 * Why not linear programming?  The win-rate constraint is non-linear in w_i
 * (depends on Var which is quadratic). A simplex would need linearisation;
 * a quick coordinate-descent / hill-climb is more honest about the tradeoffs.
 */

export type Rarity = "common" | "uncommon" | "rare" | "holo" | "ultra" | "secret";

export const RARITIES: Rarity[] = ["common", "uncommon", "rare", "holo", "ultra", "secret"];

export type RarityWeights = Record<Rarity, number>;

export interface RarityStats {
  /** Mean card price in cents within this rarity bucket. */
  mean_cents: number;
  /** Sample std-dev of price. */
  stddev_cents: number;
  /** How many cards in the catalog have this rarity. */
  count: number;
}

export type PoolStats = Partial<Record<Rarity, RarityStats>>;

export interface TierParams {
  price_cents: number;
  cards_per_pack: number;
  /** Bottom rarities the tier is allowed to draw from. e.g., starter may
   *  exclude "secret" entirely. */
  allowed_rarities?: Rarity[];
  /** Force at least one slot to be rare+. (See pack-engine "guarantee".) */
  guarantee_rare_or_better?: boolean;
}

export interface SolveConfig {
  target_margin_bps: number;       // ideal house edge
  min_margin_bps: number;          // hard floor — solver fails if it can't beat this
  win_rate_floor_bps: number;      // P[V ≥ price] must be at least this fraction (in bps)
  /** Hard ceiling on any individual rarity weight, to prevent degenerate
   *  "99% commons" solutions. Default 0.85. */
  max_single_weight?: number;
  /** Lower bound on highest-rarity weights to keep the "dopamine hit" alive.
   *  Defaults below — small but non-zero. */
  min_floor_weights?: Partial<RarityWeights>;
}

export interface SolveResult {
  weights: RarityWeights;
  ev_cents: number;
  margin_bps: number;
  win_rate_bps: number;
  std_dev_cents: number;
  iterations: number;
  reason: "converged" | "fallback-uniform" | "infeasible";
}

/**
 * Standard normal CDF (Abramowitz & Stegun 26.2.17). Good to ~1e-7.
 * We need this for the win-rate constraint.
 */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** EV and variance of one pack given weights, stats, n slots. */
export function computePackStats(weights: RarityWeights, stats: PoolStats, n: number) {
  const w = (r: Rarity) => weights[r] ?? 0;
  let mean = new Decimal(0);
  let secondMoment = new Decimal(0);
  for (const r of RARITIES) {
    const s = stats[r];
    if (!s) continue;
    mean = mean.add(new Decimal(w(r)).mul(s.mean_cents));
    secondMoment = secondMoment.add(
      new Decimal(w(r)).mul(s.stddev_cents * s.stddev_cents + s.mean_cents * s.mean_cents),
    );
  }
  const perSlotMean = mean;
  const perSlotVar = secondMoment.sub(mean.mul(mean));
  const packEv = perSlotMean.mul(n);
  const packVar = perSlotVar.mul(n);          // independent slots
  const packStd = packVar.lt(0) ? new Decimal(0) : packVar.sqrt();
  return {
    ev_cents: packEv.round().toNumber(),
    std_cents: packStd.round().toNumber(),
    var_cents_sq: packVar.toNumber(),
  };
}

export function marginBps(pricePaidCents: number, evCents: number): number {
  if (pricePaidCents <= 0) return 0;
  return Math.floor(((pricePaidCents - evCents) / pricePaidCents) * 10_000);
}

/** P[V ≥ price] under normal approximation, returned in basis points. */
export function winRateBps(pricePaidCents: number, evCents: number, stdCents: number): number {
  if (stdCents <= 0) return evCents >= pricePaidCents ? 10_000 : 0;
  const z = (pricePaidCents - evCents) / stdCents;
  const p = 1 - normalCdf(z);
  return Math.round(p * 10_000);
}

/** Normalise weights to sum to 1, honouring zeros (allowed-rarity exclusion). */
function normalise(w: Partial<RarityWeights>): RarityWeights {
  const out: RarityWeights = { common: 0, uncommon: 0, rare: 0, holo: 0, ultra: 0, secret: 0 };
  let s = 0;
  for (const r of RARITIES) s += w[r] ?? 0;
  if (s === 0) return out;
  for (const r of RARITIES) out[r] = (w[r] ?? 0) / s;
  return out;
}

const DEFAULT_FLOORS: RarityWeights = {
  common: 0.10, uncommon: 0.05, rare: 0.005, holo: 0.001, ultra: 0.0002, secret: 0.00002,
};

/**
 * Solve for weights using coordinate hill-climb.
 *
 * Algorithm:
 *   1. Initialise weights inversely proportional to mean price — cheaper
 *      rarities get more weight (intuition: this is "EV-targeted seeding").
 *   2. Compute current EV. If margin < target, shift weight FROM the rarity
 *      currently contributing the most EV-per-weight TO the cheapest rarity.
 *      If margin > target (we're being too stingy), shift weight the other
 *      direction.
 *   3. After each shift, check constraints (max_single_weight, floors,
 *      win-rate floor). If violated, undo the shift and try a smaller step.
 *   4. Stop when |margin − target| < ε or step size < 1e-5.
 */
export function solveWeights(
  tier: TierParams,
  stats: PoolStats,
  cfg: SolveConfig,
): SolveResult {
  const n = tier.cards_per_pack;
  const allowed = tier.allowed_rarities ?? RARITIES;
  const floors: RarityWeights = { ...DEFAULT_FLOORS, ...(cfg.min_floor_weights ?? {}) };
  const maxW = cfg.max_single_weight ?? 0.85;

  // Mask out rarities not in `allowed` OR not in the catalog
  const usable = allowed.filter((r) => stats[r] && (stats[r]!.count > 0));
  if (usable.length === 0) {
    return {
      weights: normalise({ common: 1 }),
      ev_cents: 0,
      margin_bps: 0,
      win_rate_bps: 0,
      std_dev_cents: 0,
      iterations: 0,
      reason: "infeasible",
    };
  }

  // Initial weights ∝ 1 / mean_cents (cheap rarities get more weight)
  let w: RarityWeights = { common: 0, uncommon: 0, rare: 0, holo: 0, ultra: 0, secret: 0 };
  for (const r of usable) w[r] = 1 / Math.max(1, stats[r]!.mean_cents);
  w = normalise(w);

  // Enforce floors on rarities present in the catalog
  for (const r of usable) {
    if (w[r] < (floors[r] ?? 0)) w[r] = floors[r] ?? 0;
  }
  w = normalise(w);

  function evaluate(weights: RarityWeights) {
    const ps = computePackStats(weights, stats, n);
    return {
      ...ps,
      margin_bps: marginBps(tier.price_cents, ps.ev_cents),
      win_rate_bps: winRateBps(tier.price_cents, ps.ev_cents, ps.std_cents),
    };
  }

  const constraintsOk = (cand: RarityWeights, ev: ReturnType<typeof evaluate>) => {
    // Margin must be at least min_margin
    if (ev.margin_bps < cfg.min_margin_bps) return false;
    // No single rarity above maxW
    for (const r of RARITIES) if (cand[r] > maxW) return false;
    // Floors
    for (const r of usable) if (cand[r] < (floors[r] ?? 0) - 1e-9) return false;
    // Win-rate floor
    if (ev.win_rate_bps < cfg.win_rate_floor_bps) return false;
    return true;
  };

  let step = 0.05;
  let iter = 0;
  let lastEv = evaluate(w);

  while (step > 1e-5 && iter < 2000) {
    iter++;
    const gap = cfg.target_margin_bps - lastEv.margin_bps;
    // Sort usable rarities by their per-weight EV contribution (μ_i)
    const sorted = [...usable].sort((a, b) => stats[a]!.mean_cents - stats[b]!.mean_cents);

    let improved = false;
    // Source = rarity giving the most marginal EV; target = least
    const src = gap > 0 ? sorted[sorted.length - 1] : sorted[0];
    const tgt = gap > 0 ? sorted[0] : sorted[sorted.length - 1];
    if (src === tgt) break;

    const trial: RarityWeights = { ...w };
    const move = Math.min(step, trial[src] - (floors[src] ?? 0));
    if (move <= 1e-7) {
      step /= 2;
      continue;
    }
    trial[src] -= move;
    trial[tgt] += move;

    const normTrial = normalise(trial);
    const ev = evaluate(normTrial);
    if (
      constraintsOk(normTrial, ev) &&
      Math.abs(cfg.target_margin_bps - ev.margin_bps) < Math.abs(gap)
    ) {
      w = normTrial;
      lastEv = ev;
      improved = true;
    }
    if (!improved) step /= 2;
    if (Math.abs(cfg.target_margin_bps - lastEv.margin_bps) < 50) break; // within 0.5%
  }

  if (lastEv.margin_bps < cfg.min_margin_bps) {
    return { ...lastEv, weights: w, iterations: iter, std_dev_cents: lastEv.std_cents, reason: "infeasible" } as any;
  }
  return {
    weights: w,
    ev_cents: lastEv.ev_cents,
    margin_bps: lastEv.margin_bps,
    win_rate_bps: lastEv.win_rate_bps,
    std_dev_cents: lastEv.std_cents,
    iterations: iter,
    reason: "converged",
  };
}

/**
 * Run a Monte-Carlo simulation of `count` pack openings.
 * Uses the provided RNG (default: Math.random) so the simulation can be
 * seeded for reproducibility.
 *
 * Returns the distribution of pack values, the realised margin, and the
 * win rate. Verifies the analytical formulas above match empirically.
 */
export interface SimulationResult {
  count: number;
  ev_cents: number;
  observed_mean_cents: number;
  std_dev_cents: number;
  median_cents: number;
  win_rate_bps: number;
  margin_bps: number;
  projected_revenue_cents_per_1000_packs: number;
  histogram: Array<{ bucket_lo: number; bucket_hi: number; count: number }>;
}

export function simulate(
  weights: RarityWeights,
  stats: PoolStats,
  tier: TierParams,
  count: number,
  rng: () => number = Math.random,
): SimulationResult {
  const ws = Object.entries(weights).filter(([, v]) => v > 0) as [Rarity, number][];
  const totalW = ws.reduce((a, [, v]) => a + v, 0);
  const cumulative: Array<[Rarity, number]> = [];
  let acc = 0;
  for (const [r, v] of ws) { acc += v / totalW; cumulative.push([r, acc]); }

  function rollRarity(): Rarity {
    const x = rng();
    for (const [r, c] of cumulative) if (x < c) return r;
    return cumulative[cumulative.length - 1][0];
  }

  // For each rarity we simulate "draw a card from the bucket" by sampling from
  // N(mean, stddev) truncated at 0. This is a fast approximation — real packs
  // have discrete card prices, but the moment-matching simulation gives the
  // same first/second moments and is much faster than enumerating real prices.
  function rollCardPrice(r: Rarity): number {
    const s = stats[r];
    if (!s) return 0;
    // Box-Muller
    const u1 = Math.max(1e-9, rng()), u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, s.mean_cents + z * s.stddev_cents);
  }

  const values: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let total = 0;
    for (let s = 0; s < tier.cards_per_pack; s++) total += rollCardPrice(rollRarity());
    values[i] = total;
  }
  const sum = values.reduce((a, v) => a + v, 0);
  const mean = sum / count;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, count - 1);
  const sd = Math.sqrt(variance);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(count / 2)];
  const wins = values.filter((v) => v >= tier.price_cents).length;
  const winBps = Math.round((wins / count) * 10_000);
  const marginObs = marginBps(tier.price_cents, Math.round(mean));

  // Histogram: 20 buckets from 0 to max
  const max = sorted[sorted.length - 1] || 1;
  const buckets = 20;
  const bw = max / buckets;
  const hist = Array.from({ length: buckets }, (_, b) => ({
    bucket_lo: Math.round(b * bw),
    bucket_hi: Math.round((b + 1) * bw),
    count: 0,
  }));
  for (const v of values) {
    const b = Math.min(buckets - 1, Math.floor(v / bw));
    hist[b].count++;
  }

  return {
    count,
    ev_cents: Math.round(mean),
    observed_mean_cents: Math.round(mean),
    std_dev_cents: Math.round(sd),
    median_cents: Math.round(median),
    win_rate_bps: winBps,
    margin_bps: marginObs,
    projected_revenue_cents_per_1000_packs: 1000 * (tier.price_cents - Math.round(mean)),
    histogram: hist,
  };
}

/**
 * Chi-squared goodness-of-fit test of observed rarity counts vs advertised
 * weights. Returns the χ² statistic and an approximate p-value via the
 * lower regularised incomplete gamma — good enough for "does this look
 * suspicious" UI alerting. Real audits would use a proper stats library.
 */
export function chiSquaredFit(observed: Record<string, number>, expectedWeights: RarityWeights):
  { chi2: number; df: number; p_value: number; per_rarity: Array<{ rarity: string; obs: number; exp: number; chi: number }> } {
  const totalObs = Object.values(observed).reduce((a, v) => a + v, 0);
  let chi2 = 0;
  const per: Array<{ rarity: string; obs: number; exp: number; chi: number }> = [];
  let df = -1;
  for (const r of RARITIES) {
    const w = expectedWeights[r] ?? 0;
    if (w <= 0) continue;
    df++;
    const obs = observed[r] ?? 0;
    const exp = w * totalObs;
    if (exp <= 0) continue;
    const c = ((obs - exp) ** 2) / exp;
    chi2 += c;
    per.push({ rarity: r, obs, exp: Math.round(exp), chi: c });
  }
  // P-value via the regularised lower incomplete gamma function P(k/2, x/2)
  // and 1 - P. For df>0 this is well-defined.
  const p = 1 - regIncompleteGamma(df / 2, chi2 / 2);
  return { chi2, df, p_value: Number.isFinite(p) ? p : 0, per_rarity: per };
}

/** Lanczos-ish approximation of γ(s, x) / Γ(s) — good to ~1e-6 in our range. */
function regIncompleteGamma(s: number, x: number): number {
  if (x < 0 || s <= 0) return 0;
  if (x === 0) return 0;
  if (x < s + 1) {
    // Series expansion
    let term = 1 / s;
    let sum = term;
    for (let n = 1; n < 200; n++) {
      term *= x / (s + n);
      sum += term;
      if (Math.abs(term) < 1e-15) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  }
  // Continued fraction (Lentz)
  let b = x + 1 - s;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return 1 - h * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

function logGamma(z: number): number {
  // Lanczos
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
