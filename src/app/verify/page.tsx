"use client";
import { useEffect, useState } from "react";
import { verifyPack, type VerificationResult } from "@/lib/provably-fair-browser";

/**
 * Provably-fair verification page.
 *
 * Anyone can paste any pack id. We fetch the proof from /api/packs/:id/verify,
 * then run verifyPack() ENTIRELY in the browser. The page never asks the
 * server "is this correct?" — it computes the answer itself.
 *
 * This is the difference between "the platform says it's fair" and "we can
 * prove it's fair without trusting the platform".
 */
export default function VerifyPage() {
  const [packId, setPackId] = useState("");
  const [proof, setProof] = useState<any>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Auto-prefill from ?id= so the "Verify this pack" link from reveal works.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setPackId(id);
  }, []);

  async function run() {
    setErr(null); setResult(null); setProof(null); setLoading(true);
    try {
      const r = await fetch(`/api/packs/${encodeURIComponent(packId)}/verify`);
      if (!r.ok) { setErr((await r.json()).error || "fetch failed"); return; }
      const data = await r.json();
      setProof(data);

      const v = await verifyPack(
        data.commit,
        data.contents,
        data.cards_per_pack,
        data.current_pool.ids_by_rarity,
      );
      setResult(v);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Provably Fair Verification</h1>
        <p className="text-zinc-400 text-sm mt-2">
          Paste any pack ID and we'll independently recompute the cards from the
          server seed in your browser. The server can't fake this — the seed
          hash is committed at purchase time, before any cards are rolled.
        </p>
      </header>

      <div className="flex gap-2">
        <input value={packId} onChange={(e) => setPackId(e.target.value)}
          placeholder="paste pack id (UUID)" className="flex-1 bg-bg border border-border rounded px-3 py-2 font-mono text-sm" />
        <button onClick={run} disabled={loading || !packId}
          className="bg-accent text-black px-4 py-2 rounded font-semibold">
          {loading ? "Verifying…" : "Verify"}
        </button>
      </div>
      {err && <div className="text-danger text-sm">{err}</div>}

      {proof && (
        <div className="rounded-lg border border-border bg-panel p-4 space-y-3">
          <h2 className="font-semibold">Cryptographic proof</h2>
          <Row k="Pack ID" v={proof.pack_id} />
          <Row k="Tier" v={proof.tier_slug} />
          <Row k="Purchased" v={proof.purchased_at} />
          <Row k="Revealed" v={proof.revealed_at ?? "(not yet)"} />
          <Row k="Commit (SHA256 of server seed)" v={proof.commit.server_seed_hash ?? "—"} mono />
          <Row k="Server seed (revealed)" v={proof.commit.server_seed ?? "🔒 not revealed yet"} mono />
          <Row k="Client seed" v={proof.commit.client_seed ?? "—"} mono />
          <Row k="Nonce" v={String(proof.commit.nonce ?? "—")} />
          <Row k="Card pool hash" v={proof.commit.card_pool_hash ?? "—"} mono />
          <Row k="Weights snapshot" v={JSON.stringify(proof.commit.weights_snapshot)} mono />
        </div>
      )}

      {result && (
        <div className={`rounded-lg border p-4 ${result.rolls_match && result.commit_valid && result.pool_hash_valid ? "border-success" : "border-danger"} bg-panel`}>
          <h2 className="font-semibold mb-2">Verification result</h2>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Status label="Commit valid" ok={result.commit_valid} />
            <Status label="Pool hash valid" ok={result.pool_hash_valid} />
            <Status label="Rolls match" ok={result.rolls_match} />
          </div>
          <div className="text-sm text-zinc-300 mt-3">{result.reason}</div>
          <details className="mt-3">
            <summary className="text-xs text-zinc-500 cursor-pointer">Per-slot details</summary>
            <table className="w-full mt-2 text-xs font-mono">
              <tbody>
                {result.per_slot.map((s) => (
                  <tr key={s.slot} className={s.ok ? "" : "text-danger"}>
                    <td className="p-1">slot {s.slot}</td>
                    <td className="p-1">expected: {s.expected_card_id?.slice(0, 8)}…</td>
                    <td className="p-1">got: {s.got_card_id?.slice(0, 8)}…</td>
                    <td className="p-1">{s.ok ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-zinc-500">{k}</span>
      <span className={mono ? "font-mono text-xs break-all max-w-[60%] text-right" : ""}>{v}</span>
    </div>
  );
}

function Status({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className={`rounded border p-2 ${ok ? "border-success bg-success/10" : "border-danger bg-danger/10"}`}>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={`font-semibold ${ok ? "text-success" : "text-danger"}`}>{ok ? "PASS" : "FAIL"}</div>
    </div>
  );
}
