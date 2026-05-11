"use client";
import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket-client";

type Card = {
  user_card_id: string;
  card_id: string;
  tcg_id: string;
  name: string;
  set_name: string;
  rarity: string;
  image_url: string;
  current_price_cents: number;
  acquired_price_cents: number;
  pl_cents: number;
  status: string;
  source: string;
};

export default function CollectionPage() {
  const [data, setData] = useState<{ cards: Card[]; totals: any } | null>(null);
  const [sort, setSort] = useState("recent");
  const [statusFilter, setStatusFilter] = useState<string>("");

  async function refresh() {
    const params = new URLSearchParams({ sort });
    if (statusFilter) params.set("status", statusFilter);
    const r = await fetch(`/api/cards/mine?${params}`);
    setData(await r.json());
  }
  useEffect(() => { refresh(); }, [sort, statusFilter]);

  // Listen for price ticks → refresh portfolio
  useEffect(() => {
    const s = getSocket();
    s.emit("join", "prices");
    const onPrice = () => refresh();
    s.on("prices", onPrice);
    return () => { s.off("prices", onPrice); };
  }, [sort, statusFilter]);

  if (!data) return <div>Loading…</div>;

  const { cards, totals } = data;
  const totalValue = Number(totals.total_value_cents);
  const totalCost = Number(totals.total_cost_cents);
  const portfolioPL = totalValue - totalCost;

  async function listForSale(uc: Card) {
    const v = prompt(`List "${uc.name}" for how many cents? (current market: ${uc.current_price_cents})`,
      String(uc.current_price_cents));
    if (!v) return;
    const r = await fetch("/api/marketplace/listings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_card_id: uc.user_card_id, price_cents: parseInt(v, 10) }),
    });
    if (!r.ok) { const j = await r.json(); alert(j.error); }
    refresh();
  }
  async function startAuction(uc: Card) {
    const start = prompt(`Start price (cents)?`, String(uc.current_price_cents));
    const dur = prompt(`Duration in seconds? (60 = 1m, 3600 = 1h, 86400 = 24h)`, "60");
    if (!start || !dur) return;
    const r = await fetch("/api/auctions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_card_id: uc.user_card_id,
        start_price_cents: parseInt(start, 10),
        duration_seconds: parseInt(dur, 10),
      }),
    });
    const j = await r.json();
    if (!r.ok) { alert(j.error); return; }
    window.location.href = `/auctions/${j.id}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Collection</h1>
        <div className="flex gap-2 text-sm">
          <select value={sort} onChange={(e) => setSort(e.target.value)} className="bg-panel border border-border rounded px-2 py-1">
            <option value="recent">Recent</option>
            <option value="value_desc">Value ↓</option>
            <option value="value_asc">Value ↑</option>
            <option value="rarity">Rarity</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-panel border border-border rounded px-2 py-1">
            <option value="">All</option>
            <option value="owned">Owned</option>
            <option value="listed">Listed</option>
            <option value="auctioned">Auctioned</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 rounded-lg border border-border bg-panel p-4">
        <Stat label="Cards" value={String(totals.total_cards)} />
        <Stat label="Portfolio value" value={`$${(totalValue / 100).toFixed(2)}`} />
        <Stat label="Total P/L" value={`${portfolioPL >= 0 ? "+" : ""}$${(portfolioPL / 100).toFixed(2)}`}
          color={portfolioPL >= 0 ? "text-success" : "text-danger"} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {cards.map((c) => (
          <div key={c.user_card_id} className="rounded-lg border border-border bg-panel p-2 card-shadow">
            <img src={c.image_url} alt={c.name} className="w-full rounded" />
            <div className="text-xs mt-1">
              <div className="font-semibold truncate">{c.name}</div>
              <div className="text-zinc-500">{c.set_name}</div>
              <div className={`uppercase rarity-${c.rarity}`}>{c.rarity}</div>
              <div className="font-mono">${(c.current_price_cents / 100).toFixed(2)}</div>
              <div className={`text-[10px] ${c.pl_cents >= 0 ? "text-success" : "text-danger"}`}>
                {c.pl_cents >= 0 ? "+" : ""}${(c.pl_cents / 100).toFixed(2)}
              </div>
              <div className="text-[10px] text-zinc-500 uppercase">{c.status}</div>
            </div>
            {c.status === "owned" && (
              <div className="mt-1 flex gap-1">
                <button className="flex-1 text-[10px] bg-bg border border-border rounded py-1"
                  onClick={() => listForSale(c)}>List</button>
                <button className="flex-1 text-[10px] bg-bg border border-border rounded py-1"
                  onClick={() => startAuction(c)}>Auction</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-xl font-bold ${color ?? ""}`}>{value}</div>
    </div>
  );
}
