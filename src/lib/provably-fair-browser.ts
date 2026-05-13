"use client";

/**
 * Browser-side replica of the server's pull algorithm.
 * Uses the Web Crypto API — must produce IDENTICAL results to provably-fair.ts.
 *
 * The verification page calls this with the proof data and the (claimed)
 * pulled cards. If our local computation matches the server's recorded
 * contents AND SHA256(server_seed) matches the commit, the pack is verified.
 */

async function hmacSha256(keyHex: string, message: string): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

async function sha256Hex(hex: string): Promise<string> {
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function pickWeighted<T extends string>(weights: Record<string, number>, keys: T[], u: number): T {
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

export interface PackProof {
  server_seed_hash: string;
  server_seed: string | null;
  client_seed: string;
  nonce: number;
  weights_snapshot: Record<string, number>;
  card_pool_hash: string;
}

export interface CardLite { card_id: string; rarity: string; }

export interface VerificationResult {
  commit_valid: boolean;          // SHA256(server_seed) == server_seed_hash
  pool_hash_valid: boolean;       // current pool hash matches what was stored
  rolls_match: boolean;           // recomputed cards equal the claimed contents
  per_slot: Array<{ slot: number; expected_card_id: string; got_card_id: string; ok: boolean }>;
  reason: string;
}

/** Reproduces the server's `cardPoolHash`. */
async function poolHash(ids_by_rarity: Record<string, string[]>): Promise<string> {
  const keys = Object.keys(ids_by_rarity).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}:${ids_by_rarity[k].slice().sort().join(",")};`);
  }
  const msg = parts.join("");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Run the full verification client-side. Returns where it fails.
 */
export async function verifyPack(
  proof: PackProof,
  contents: CardLite[],
  cardsPerPack: number,
  ids_by_rarity: Record<string, string[]>,
): Promise<VerificationResult> {
  const out: VerificationResult = {
    commit_valid: false,
    pool_hash_valid: false,
    rolls_match: false,
    per_slot: [],
    reason: "",
  };

  if (!proof.server_seed) {
    out.reason = "Pack not yet revealed — server_seed is not yet public.";
    return out;
  }

  // 1. SHA256(server_seed) must equal server_seed_hash.
  out.commit_valid = (await sha256Hex(proof.server_seed)) === proof.server_seed_hash;
  if (!out.commit_valid) {
    out.reason = "Commit mismatch: server_seed hash ≠ stored server_seed_hash.";
    return out;
  }

  // 2. The card pool hash must match (proves the pool wasn't swapped).
  out.pool_hash_valid = (await poolHash(ids_by_rarity)) === proof.card_pool_hash;
  if (!out.pool_hash_valid) {
    out.reason = "Card pool changed since this pack was rolled (catalog edit?).";
    return out;
  }

  // 3. Recompute each slot's roll.
  const rarityKeys = Object.keys(proof.weights_snapshot);
  let allOk = true;
  for (let s = 0; s < cardsPerPack; s++) {
    const hmac = await hmacSha256(
      proof.server_seed,
      `${proof.client_seed}:${proof.nonce}:${s}`,
    );
    const u_rar = readUint32BE(hmac, 0) / 0x1_0000_0000;
    const u_card = readUint32BE(hmac, 4) / 0x1_0000_0000;
    let chosen = pickWeighted(proof.weights_snapshot, rarityKeys, u_rar);
    if (!ids_by_rarity[chosen] || ids_by_rarity[chosen].length === 0) chosen = "common";
    const bucket = ids_by_rarity[chosen] ?? ids_by_rarity["common"] ?? [];
    const idx = Math.min(bucket.length - 1, Math.floor(u_card * bucket.length));
    const expectedId = bucket[idx];
    const gotId = contents[s]?.card_id ?? "";
    const ok = expectedId === gotId;
    out.per_slot.push({ slot: s, expected_card_id: expectedId, got_card_id: gotId, ok });
    if (!ok) allOk = false;
  }
  // NB: this does NOT yet validate the "guarantee" upgrade slot for non-
  // starter packs. The verification page surfaces both the raw rolls AND a
  // mismatch flag — a mismatch on any slot for a guarantee pack means the
  // upgrade kicked in, which is fine. A full verifier would also recompute
  // the guarantee using slot index = cardsPerPack and surface that.
  out.rolls_match = allOk;
  out.reason = allOk ? "Verified" : "Some slots do not match the seed — possible tampering";
  return out;
}
