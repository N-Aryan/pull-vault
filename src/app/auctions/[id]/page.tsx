"use client";
import { useEffect, useRef, useState } from "react";
import { getSocket } from "@/lib/socket-client";

export default function AuctionRoom({ params }: { params: { id: string } }) {
  const [a, setA] = useState<any>(null);
  const [bid, setBid] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [watchers, setWatchers] = useState(1);
  const [, force] = useState(0);
  const tickRef = useRef<any>(null);

  async function refresh() {
    const r = await fetch(`/api/auctions/${params.id}`);
    if (r.ok) setA(await r.json());
  }
  useEffect(() => { refresh(); }, [params.id]);

  useEffect(() => {
    const s = getSocket();
    s.emit("join", `auction:${params.id}`);
    function on(p: any) {
      if (p.type === "bid") {
        setMsg(p.extended ? "Bid placed — auction extended" : "Bid placed");
        refresh();
      } else if (p.type === "settled") {
        setMsg(p.outcome === "sold" ? "Auction ended" : "Auction ended (no bids)");
        refresh();
      }
    }
    function onWatchers(p: { room: string; count: number }) {
      if (p.room === `auction:${params.id}`) setWatchers(p.count);
    }
    s.on("auction", on);
    s.on("watchers", onWatchers);
    tickRef.current = setInterval(() => force((x) => x + 1), 1000);
    return () => {
      s.off("auction", on);
      s.off("watchers", onWatchers);
      clearInterval(tickRef.current);
      s.emit("leave", `auction:${params.id}`);
    };
  }, [params.id]);

  if (!a) return <div>Loading auction…</div>;

  const cur = a.current_bid_cents ? Number(a.current_bid_cents) : Number(a.start_price_cents);
  const minNext = a.current_bid_cents
    ? Math.max(Math.ceil(cur * 1.05), cur + Number(a.min_increment_cents || 100))
    : Number(a.start_price_cents);
  const remainingMs = Math.max(0, new Date(a.end_time).getTime() - Date.now());
  const ended = a.status !== "live" || remainingMs === 0;

  async function placeBid() {
    setMsg(null);
    const amt = parseInt(bid, 10);
    if (!amt || amt < minNext) { setMsg(`Bid must be at least ${minNext} cents`); return; }
    const r = await fetch(`/api/auctions/${params.id}/bid`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: amt }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(`✗ ${j.error}`); refresh(); return; }
    setBid("");
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="rounded-lg border border-border bg-panel p-4">
        <img src={a.image_url} alt={a.name} className="w-64 mx-auto rounded" />
        <div className="mt-3 text-center">
          <div className="font-semibold">{a.name}</div>
          <div className="text-xs text-zinc-500">{a.set_name}</div>
          <div className={`text-xs uppercase rarity-${a.rarity}`}>{a.rarity}</div>
          <div className="text-xs text-zinc-400 mt-1">Market reference: ${(Number(a.market_price_cents) / 100).toFixed(2)}</div>
        </div>
      </div>
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="text-xs text-zinc-500">Current bid</div>
          <div className="text-3xl font-bold">${(cur / 100).toFixed(2)}</div>
          <div className="text-xs text-zinc-500 mt-1">{a.current_bidder_id ? `by ${a.current_bidder_id.slice(0, 8)}…` : "no bids yet"}</div>
          <div className={`mt-3 font-mono text-2xl ${remainingMs < 30_000 ? "text-danger" : ""}`}>
            {fmtTime(remainingMs)}
          </div>
          <div className="text-[11px] text-zinc-500">Anti-snipe: bids in the last {a.snipe_window_seconds}s extend the timer by {a.snipe_extend_seconds}s</div>
          <div className="text-[11px] text-zinc-500 mt-1">{watchers} {watchers === 1 ? "watcher" : "watchers"} in this room</div>
          {ended ? (
            <div className="mt-4 text-center text-zinc-500">Auction ended</div>
          ) : (
            <div className="mt-4 flex gap-2">
              <input value={bid} onChange={(e) => setBid(e.target.value)}
                placeholder={`min ${minNext}`} type="number" min={minNext}
                className="flex-1 bg-bg border border-border rounded px-3 py-2" />
              <button onClick={placeBid} className="bg-accent text-black px-4 py-2 rounded font-semibold">Place Bid</button>
            </div>
          )}
          {msg && <div className="mt-2 text-sm">{msg}</div>}
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="text-sm font-semibold mb-2">Bid history</div>
          <div className="space-y-1 max-h-64 overflow-auto">
            {(a.bids || []).map((b: any) => (
              <div key={b.id} className="flex justify-between text-xs">
                <span className="text-zinc-400">{b.bidder_id.slice(0, 8)}…</span>
                <span className="font-mono">${(Number(b.amount_cents) / 100).toFixed(2)}</span>
                <span className="text-zinc-500">{new Date(b.placed_at).toLocaleTimeString()}</span>
                <span className={`text-[10px] uppercase ${b.status === "won" ? "text-success" : b.status === "outbid" ? "text-zinc-500" : ""}`}>{b.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtTime(ms: number) {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
