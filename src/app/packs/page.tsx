"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getSocket } from "@/lib/socket-client";

type Drop = {
  id: string;
  total_inventory: number;
  sold_count: number;
  drop_time: string;
  status: string;
  tier_id: string;
  slug: string;
  name: string;
  description: string;
  price_cents: number;
  cards_per_pack: number;
};

export default function PacksPage() {
  const [drops, setDrops] = useState<Drop[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  async function refresh() {
    const r = await fetch("/api/packs/drops");
    setDrops(await r.json());
  }
  useEffect(() => { refresh(); }, []);

  // Real-time inventory updates via WebSocket. Each drop card has its own
  // Redis channel; we join all of them and route incoming messages by drop_id.
  useEffect(() => {
    const s = getSocket();
    drops.forEach((d) => s.emit("join", `drop:${d.id}`));
    function onDrop(payload: any) {
      if (payload.type === "sold" && payload.drop_id) {
        setDrops((cur) =>
          cur.map((d) =>
            d.id === payload.drop_id
              ? { ...d, sold_count: payload.sold_count, status: payload.status }
              : d,
          ),
        );
      } else if (payload.type === "live") {
        // Worker flipped a scheduled drop to live — refetch so the button enables.
        refresh();
      }
    }
    s.on("drop", onDrop);
    return () => { s.off("drop", onDrop); };
  }, [drops.length]);

  // Countdown re-render every second
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  async function buy(drop: Drop) {
    setBusy(drop.id); setMsg(null);
    const r = await fetch("/api/packs/buy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drop_id: drop.id }),
    });
    setBusy(null);
    const j = await r.json();
    if (!r.ok) {
      setMsg(`✗ ${j.error}`);
      refresh();
      return;
    }
    setMsg("✓ Pack acquired — opening…");
    window.location.href = `/packs/${j.user_pack_id}/reveal`;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Pack Drops</h1>
      {msg && <div className="text-sm">{msg}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {drops.map((d) => {
          const remaining = d.total_inventory - d.sold_count;
          const dropMs = new Date(d.drop_time).getTime() - Date.now();
          const live = d.status === "live" || dropMs <= 0;
          const soldOut = d.status === "sold_out" || remaining <= 0;
          return (
            <div key={d.id} className="rounded-lg border border-border bg-panel p-5">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-lg font-bold">{d.name}</div>
                  <div className="text-xs text-zinc-500 uppercase">{d.slug}</div>
                </div>
                <div className="text-2xl font-bold">${(d.price_cents / 100).toFixed(2)}</div>
              </div>
              <p className="text-sm text-zinc-400 mt-2">{d.description}</p>
              <div className="text-xs text-zinc-500 mt-2">{d.cards_per_pack} cards per pack</div>
              <div className="mt-4">
                <div className="flex justify-between text-xs text-zinc-500">
                  <span>Inventory</span>
                  <span>{d.sold_count} / {d.total_inventory}</span>
                </div>
                <div className="h-2 bg-bg border border-border rounded mt-1 overflow-hidden">
                  <div className="h-full bg-accent transition-all"
                    style={{ width: `${(d.sold_count / d.total_inventory) * 100}%` }} />
                </div>
              </div>
              <div className="mt-4">
                {soldOut ? (
                  <button disabled className="w-full bg-zinc-700 rounded py-2 font-semibold">Sold Out</button>
                ) : live ? (
                  <button onClick={() => buy(d)} disabled={busy === d.id}
                    className="w-full bg-accent text-black rounded py-2 font-semibold">
                    {busy === d.id ? "Buying…" : `Buy ($${(d.price_cents / 100).toFixed(2)})`}
                  </button>
                ) : (
                  <div className="text-center bg-bg border border-border rounded py-2 text-sm">
                    Drops in <Countdown ts={dropMs} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500">
        Tip: open this page in two browser tabs and click Buy at the same time. The DB will let exactly one through.
      </p>
    </div>
  );
}

function Countdown({ ts }: { ts: number }) {
  const s = Math.max(0, Math.floor(ts / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (
    <span className="font-mono">
      {h > 0 ? `${h}h ` : ""}{m}m {sec}s
    </span>
  );
}
