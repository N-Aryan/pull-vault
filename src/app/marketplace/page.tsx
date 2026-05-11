"use client";
import { useEffect, useState } from "react";

export default function MarketplacePage() {
  const [listings, setListings] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/marketplace/listings");
    setListings(await r.json());
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);

  async function buy(id: string) {
    setBusy(id); setMsg(null);
    const r = await fetch(`/api/marketplace/listings/${id}/buy`, { method: "POST" });
    setBusy(null);
    const j = await r.json();
    if (!r.ok) { setMsg(`✗ ${j.error}`); refresh(); return; }
    setMsg("✓ Purchased");
    refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Marketplace</h1>
      {msg && <div className="text-sm">{msg}</div>}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {listings.map((l) => (
          <div key={l.id} className="rounded-lg border border-border bg-panel p-2 card-shadow">
            <img src={l.image_url} alt={l.name} className="w-full rounded" />
            <div className="text-xs mt-1">
              <div className="font-semibold truncate">{l.name}</div>
              <div className="text-zinc-500">{l.set_name}</div>
              <div className={`uppercase rarity-${l.rarity}`}>{l.rarity}</div>
              <div className="font-mono mt-1">List: ${(l.price_cents / 100).toFixed(2)}</div>
              <div className="text-[10px] text-zinc-500">Market: ${(l.current_price_cents / 100).toFixed(2)}</div>
            </div>
            <button onClick={() => buy(l.id)} disabled={busy === l.id}
              className="mt-1 w-full bg-accent text-black rounded py-1 text-xs font-semibold">
              {busy === l.id ? "…" : "Buy"}
            </button>
          </div>
        ))}
        {listings.length === 0 && <div className="text-sm text-zinc-500">No active listings.</div>}
      </div>
    </div>
  );
}
