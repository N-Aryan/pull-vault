"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export default function AuctionsPage() {
  const [auctions, setAuctions] = useState<any[]>([]);
  useEffect(() => {
    const refresh = async () => setAuctions(await fetch("/api/auctions").then(r => r.json()));
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Live Auctions</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {auctions.map((a) => {
          const remaining = Math.max(0, new Date(a.end_time).getTime() - Date.now());
          const cur = a.current_bid_cents ? Number(a.current_bid_cents) : Number(a.start_price_cents);
          return (
            <Link key={a.id} href={`/auctions/${a.id}`}
              className="rounded-lg border border-border bg-panel p-3 card-shadow flex gap-3">
              <img src={a.image_url} alt={a.name} className="w-20 rounded" />
              <div className="flex-1 text-sm">
                <div className="font-semibold truncate">{a.name}</div>
                <div className="text-xs text-zinc-500">{a.set_name}</div>
                <div className={`text-xs uppercase rarity-${a.rarity}`}>{a.rarity}</div>
                <div className="font-mono mt-1">${(cur / 100).toFixed(2)}</div>
                <div className="text-xs text-zinc-500">ends in {Math.floor(remaining / 1000)}s</div>
              </div>
            </Link>
          );
        })}
        {auctions.length === 0 && <div className="text-sm text-zinc-500">No live auctions. Start one from your collection.</div>}
      </div>
    </div>
  );
}
