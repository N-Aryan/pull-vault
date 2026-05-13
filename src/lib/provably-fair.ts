import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Provably-Fair Pack Openings — commit-reveal with HMAC-SHA256.
 * ─────────────────────────────────────────────────────────────
 *
 * Protocol (modelled on the standard used by Stake / Roobet / industry
 * gambling sites — they make this scheme audit-able):
 *
 *   Purchase time (server generates):
 *     server_seed         ← randomBytes(32)            [SECRET, server-side only]
 *     server_seed_hash    ← SHA256(server_seed)        [COMMITTED — sent to user]
 *     client_seed         ← user-supplied or random    [PUBLIC]
 *     nonce               ← user's monotonic counter   [PUBLIC]
 *     weights_snapshot    ← rarity weights at this instant
 *     card_pool_hash      ← SHA256(sorted card IDs in pool, per rarity)
 *
 *     For each slot s = 0..n-1:
 *       roll_hash_s = HMAC_SHA256(server_seed, `${client_seed}:${nonce}:${s}`)
 *       Take first 8 bytes → uint64 → x ∈ [0, 1)
 *       Use x to pick the rarity from weights_snapshot (cumulative).
 *       Take next 8 bytes → uint64 → y ∈ [0, 1)
 *       Use y to pick the card from that rarity's pool (by index).
 *
 *   Reveal time:
 *     server_seed becomes visible.
 *     User can recompute every slot in the browser and confirm it matches
 *     their pulled contents.
 *
 *   Audit:
 *     Anyone can verify that server_seed_hash = SHA256(server_seed).
 *     Anyone can replay the HMAC for any past pack.
 *
 * WHY THIS IS SOUND
 * ─────────────────
 *   - The server commits to server_seed BEFORE seeing what cards roll.
 *   - The hash is irreversible: the server cannot find a different seed
 *     that happens to produce desirable cards AND matches the same commit.
 *   - The nonce prevents replay: the same seed cannot be used twice.
 *   - The client_seed lets the user mix in their own entropy. If they
 *     don't trust our randomBytes, they can supply theirs.
 *
 * WHAT THE SERVER CANNOT DO
 * ─────────────────────────
 *   - Change pack outcome after seeing user reaction (commit is locked).
 *   - Choose seed-after-the-fact (commit pins it).
 *   - Skip nonce or reuse seed (would be visible in the audit log).
 *
 * NOTE ON RNG
 *   We do NOT use Math.random in pack-engine for actual pulls. The HMAC
 *   output IS the RNG. Pulls are deterministic given (server_seed,
 *   client_seed, nonce, slot_index, weights_snapshot, card_pool).
 */

export function generateServerSeed(): { server_seed: string; commit_hash: string } {
  const buf = randomBytes(32);
  const server_seed = buf.toString("hex");
  const commit_hash = createHash("sha256").update(buf).digest("hex");
  return { server_seed, commit_hash };
}

export function hashCommit(serverSeedHex: string): string {
  return createHash("sha256").update(Buffer.from(serverSeedHex, "hex")).digest("hex");
}

export function verifyCommit(serverSeedHex: string, commitHash: string): boolean {
  return hashCommit(serverSeedHex) === commitHash;
}

/**
 * Deterministic [0,1) draw for a given slot.
 * Returns two independent uniforms — one for rarity pick, one for card pick.
 */
export function rollSlot(
  serverSeedHex: string,
  clientSeed: string,
  nonce: number | bigint,
  slotIndex: number,
): { u_rarity: number; u_card: number; hmac_hex: string } {
  const msg = `${clientSeed}:${nonce}:${slotIndex}`;
  const h = createHmac("sha256", Buffer.from(serverSeedHex, "hex")).update(msg).digest();
  // h is 32 bytes. Take 4 bytes for each uniform — 32 bits is plenty of entropy.
  const u1 = h.readUInt32BE(0) / 0x1_0000_0000; // [0,1)
  const u2 = h.readUInt32BE(4) / 0x1_0000_0000;
  return { u_rarity: u1, u_card: u2, hmac_hex: h.toString("hex") };
}

/** Weighted pick using a uniform u. Stable order — caller controls keys. */
export function pickWeighted<T extends string>(
  weights: Record<T, number>,
  keys: T[],
  u: number,
): T {
  let total = 0;
  for (const k of keys) total += weights[k] ?? 0;
  if (total <= 0) return keys[0];
  let x = u * total;
  for (const k of keys) {
    x -= weights[k] ?? 0;
    if (x <= 0) return k;
  }
  return keys[keys.length - 1];
}

/** Hash of the card pool snapshot — proves which cards were even eligible
 *  for selection at purchase time. */
export function cardPoolHash(idsByRarity: Record<string, string[]>): string {
  const h = createHash("sha256");
  const keys = Object.keys(idsByRarity).sort();
  for (const k of keys) {
    h.update(k);
    h.update(":");
    h.update(idsByRarity[k].slice().sort().join(","));
    h.update(";");
  }
  return h.digest("hex");
}
