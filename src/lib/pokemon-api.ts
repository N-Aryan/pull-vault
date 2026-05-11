/**
 * Pokemon TCG API client (https://pokemontcg.io).
 *
 * Why this API: TCGPlayer's developer key has a long approval window. The
 * Pokemon TCG API exposes the same TCGPlayer-derived market prices on every
 * card, no auth needed for the free tier. Good enough for a paper-trading demo.
 *
 * Pricing path: each card record has cardmarket.prices.averageSellPrice and
 * tcgplayer.prices.{normal|holofoil|reverseHolofoil}.market. We pick the first
 * one available, fall back to a rarity-based estimate if all are missing.
 */

export type ApiCard = {
  id: string;
  name: string;
  set: { name: string };
  rarity?: string;
  images: { small: string; large: string };
  cardmarket?: { prices?: { averageSellPrice?: number; trendPrice?: number } };
  tcgplayer?: {
    prices?: Record<string, { market?: number; mid?: number; low?: number; high?: number }>;
  };
};

const BASE = "https://api.pokemontcg.io/v2";

function headers() {
  const h: Record<string, string> = { Accept: "application/json" };
  if (process.env.POKEMON_TCG_API_KEY) h["X-Api-Key"] = process.env.POKEMON_TCG_API_KEY;
  return h;
}

export async function fetchCards(opts: { q?: string; page?: number; pageSize?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  params.set("page", String(opts.page ?? 1));
  params.set("pageSize", String(opts.pageSize ?? 50));
  // `next: { revalidate }` is a Next.js extension to fetch — TS lib doesn't know about it.
  const res = await fetch(`${BASE}/cards?${params}`, {
    headers: headers(),
    next: { revalidate: 3600 },
  } as RequestInit);
  if (!res.ok) throw new Error(`Pokemon TCG API ${res.status}`);
  const json = (await res.json()) as { data: ApiCard[] };
  return json.data;
}

/** Normalise any of the rarity strings the API returns to one of our buckets. */
export function normaliseRarity(r?: string): "common" | "uncommon" | "rare" | "holo" | "ultra" | "secret" {
  if (!r) return "common";
  const s = r.toLowerCase();
  if (s.includes("secret") || s.includes("rainbow") || s.includes("hyper")) return "secret";
  if (s.includes("ultra") || s.includes("vmax") || s.includes("vstar") || s === "rare ex") return "ultra";
  if (s.includes("holo")) return "holo";
  if (s === "rare" || s.includes("rare")) return "rare";
  if (s.includes("uncommon")) return "uncommon";
  return "common";
}

/** Best-effort market price extractor in cents. */
export function extractPriceCents(c: ApiCard, rarity: string): number {
  const tcg = c.tcgplayer?.prices ?? {};
  for (const variant of ["holofoil", "reverseHolofoil", "normal", "1stEditionHolofoil"]) {
    const v = tcg[variant];
    if (v?.market && v.market > 0) return Math.round(v.market * 100);
  }
  const cm = c.cardmarket?.prices;
  if (cm?.averageSellPrice && cm.averageSellPrice > 0) return Math.round(cm.averageSellPrice * 100);
  if (cm?.trendPrice && cm.trendPrice > 0) return Math.round(cm.trendPrice * 100);

  // Fallback: simulated prices keyed off rarity bucket so the demo still works
  // when the API has no pricing for a card.
  const fallback: Record<string, number> = {
    common: 25,        // $0.25
    uncommon: 75,      // $0.75
    rare: 350,         // $3.50
    holo: 1500,        // $15
    ultra: 6000,       // $60
    secret: 25000,     // $250
  };
  const base = fallback[rarity] ?? 25;
  // ±20% jitter so the dashboard isn't suspiciously uniform
  const jitter = 1 + (Math.random() - 0.5) * 0.4;
  return Math.round(base * jitter);
}
