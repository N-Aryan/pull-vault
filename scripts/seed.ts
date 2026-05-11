import "./load-env";
import { pool } from "../src/lib/db";
import { fetchCards, normaliseRarity, extractPriceCents } from "../src/lib/pokemon-api";

async function seedTiers() {
  // ────────────────────────────────────────────────────────────────
  // Pack tier design — see ARCHITECTURE.md for the full justification.
  //
  // Why these prices: a casual/intermediate/serious/whale spread. $5 is low
  // enough for impulse buys; $500 makes the dopamine hit of a $250 secret
  // rare pull feel real but not life-changing.
  //
  // Why these card counts: industry-standard 5/8/10/12 progression.
  // More cards in higher tiers → more chances at the rare slot.
  //
  // Why these weights: target ~85% EV per pack (15% house edge).
  // House needs an edge or the platform loses money. 15% is in line with
  // CardKingdom mystery boxes, well below the 30%+ found in mobile gacha,
  // and noticeably better than the ~20% margin retail booster boxes have
  // built in (street price vs MSRP). Documented in ARCHITECTURE.md.
  // ────────────────────────────────────────────────────────────────
  const tiers = [
    {
      slug: "starter",
      name: "Starter",
      description: "Casual entry pack. Mostly commons with a chance at something rare.",
      price_cents: 500,        // $5
      cards_per_pack: 5,
      rarity_weights: { common: 0.70, uncommon: 0.22, rare: 0.07, holo: 0.008, ultra: 0.002, secret: 0.0001 },
    },
    {
      slug: "premium",
      name: "Premium",
      description: "Stronger odds. Guaranteed rare-or-better in every pack.",
      price_cents: 2000,       // $20
      cards_per_pack: 8,
      rarity_weights: { common: 0.50, uncommon: 0.30, rare: 0.15, holo: 0.04, ultra: 0.0095, secret: 0.0005 },
    },
    {
      slug: "elite",
      name: "Elite",
      description: "Serious pulls. Realistic shot at ultra-rares.",
      price_cents: 10000,      // $100
      cards_per_pack: 10,
      rarity_weights: { common: 0.30, uncommon: 0.30, rare: 0.25, holo: 0.10, ultra: 0.045, secret: 0.005 },
    },
    {
      slug: "legendary",
      name: "Legendary",
      description: "Whale tier. Every pack delivers a holo or better; secrets are realistic.",
      price_cents: 50000,      // $500
      cards_per_pack: 12,
      rarity_weights: { common: 0.10, uncommon: 0.20, rare: 0.30, holo: 0.25, ultra: 0.13, secret: 0.02 },
    },
  ];

  for (const t of tiers) {
    await pool.query(
      `INSERT INTO pack_tiers (slug, name, description, price_cents, cards_per_pack, rarity_weights)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             price_cents = EXCLUDED.price_cents,
             cards_per_pack = EXCLUDED.cards_per_pack,
             rarity_weights = EXCLUDED.rarity_weights`,
      [t.slug, t.name, t.description, t.price_cents, t.cards_per_pack, JSON.stringify(t.rarity_weights)],
    );
  }
  console.log(`[seed] tiers: ${tiers.length}`);
}

async function seedDrops() {
  // Create one drop per tier — first goes live immediately, the rest stagger.
  const tiers = await pool.query(`SELECT id, slug FROM pack_tiers ORDER BY price_cents ASC`);
  let offsetMin = -1; // first drop is already live (in the past)
  for (const t of tiers.rows) {
    // Inventory sized for demo: enough to play with, low enough to actually sell out.
    const inv = t.slug === "starter" ? 200 : t.slug === "premium" ? 100 : t.slug === "elite" ? 30 : 10;
    const dropTime = new Date(Date.now() + offsetMin * 60_000);
    await pool.query(
      `INSERT INTO pack_drops (tier_id, total_inventory, drop_time, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [t.id, inv, dropTime, offsetMin <= 0 ? "live" : "scheduled"],
    );
    offsetMin += 5;
  }
  console.log("[seed] drops created");
}

async function seedCards() {
  // Pull a couple hundred Pokemon cards across rarities so packs can roll.
  // We use a single API call with pagination. Free tier has no auth and is
  // permissive enough for ~500 cards in one go.
  const existing = await pool.query(`SELECT COUNT(*)::int AS n FROM cards`);
  if (existing.rows[0].n > 200) {
    console.log(`[seed] cards already seeded (${existing.rows[0].n} present)`);
    return;
  }
  console.log("[seed] fetching cards from Pokemon TCG API…");
  const all: any[] = [];
  for (let page = 1; page <= 4; page++) {
    try {
      const cards = await fetchCards({ pageSize: 100, page });
      all.push(...cards);
    } catch (e) {
      console.error("[seed] fetch failed page", page, e);
      break;
    }
  }
  if (all.length === 0) {
    console.log("[seed] WARNING: API returned no cards. Falling back to synthetic catalog.");
    await seedSynthetic();
    return;
  }

  let inserted = 0;
  for (const c of all) {
    const rarity = normaliseRarity(c.rarity);
    const price = extractPriceCents(c, rarity);
    try {
      await pool.query(
        `INSERT INTO cards (tcg_id, name, set_name, rarity, image_url, current_price_cents)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tcg_id) DO UPDATE
           SET current_price_cents = EXCLUDED.current_price_cents,
               last_price_update = NOW()`,
        [c.id, c.name, c.set?.name || "Unknown", rarity, c.images?.small || c.images?.large || "", price],
      );
      inserted++;
    } catch (e) {
      console.error("[seed] card insert failed", c.id, e);
    }
  }
  console.log(`[seed] ${inserted} cards seeded`);
  // Ensure each rarity bucket has at least 5 cards. If the API didn't return
  // enough secrets/ultras, we synthesise some so packs always roll cleanly.
  await ensureRarityCoverage();
}

/** Synthesise a small catalog when the API is unreachable. */
async function seedSynthetic() {
  const sets = ["Base Set", "Jungle", "Fossil", "Rocket", "Gym"];
  const names = ["Charizard", "Blastoise", "Venusaur", "Pikachu", "Mew", "Gyarados", "Dragonite", "Articuno", "Zapdos", "Moltres"];
  const rarities: { r: string; n: number; price: number }[] = [
    { r: "common", n: 80, price: 25 },
    { r: "uncommon", n: 40, price: 100 },
    { r: "rare", n: 20, price: 500 },
    { r: "holo", n: 10, price: 2000 },
    { r: "ultra", n: 5, price: 8000 },
    { r: "secret", n: 3, price: 30000 },
  ];
  let i = 0;
  for (const r of rarities) {
    for (let k = 0; k < r.n; k++) {
      const name = `${names[k % names.length]} ${r.r === "common" ? "" : "EX"}`.trim();
      const set = sets[k % sets.length];
      const price = Math.round(r.price * (0.7 + Math.random() * 0.6));
      await pool.query(
        `INSERT INTO cards (tcg_id, name, set_name, rarity, image_url, current_price_cents)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tcg_id) DO NOTHING`,
        [`syn-${i++}`, name, set, r.r, "https://images.pokemontcg.io/base1/4_hires.png", price],
      );
    }
  }
  console.log("[seed] synthetic catalog seeded");
}

async function ensureRarityCoverage() {
  const counts = await pool.query(
    `SELECT rarity, COUNT(*)::int AS n FROM cards GROUP BY rarity`,
  );
  const cur: Record<string, number> = {};
  for (const r of counts.rows) cur[r.rarity] = r.n;
  const required = { common: 30, uncommon: 20, rare: 10, holo: 5, ultra: 3, secret: 2 };
  let needed = 0;
  for (const [r, n] of Object.entries(required)) if ((cur[r] ?? 0) < n) needed += n - (cur[r] ?? 0);
  if (needed > 0) {
    console.log(`[seed] augmenting ${needed} cards across thin rarity buckets`);
    await seedSynthetic();
  }
}

async function main() {
  await seedTiers();
  await seedCards();
  await seedDrops();
  await pool.end();
  console.log("[seed] done");
}

main().catch((e) => { console.error(e); process.exit(1); });
