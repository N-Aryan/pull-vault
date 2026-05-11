"use client";
import { useEffect, useState } from "react";

export default function AdminPage() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetch("/api/admin/economics").then(r => r.json()).then(setData); }, []);
  if (!data) return <div>Loading…</div>;
  const fmt = (c: number) => `$${(Number(c) / 100).toFixed(2)}`;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Platform Economics</h1>

      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Revenue</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total revenue" value={fmt(data.revenue.total_cents)} highlight />
          {data.revenue.breakdown.map((r: any) => (
            <Stat key={r.source} label={r.source.replace("_", " ")}
              value={fmt(r.total_cents)} sub={`${r.events} events`} />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Pack tier expected value</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500 uppercase">
            <tr><th className="text-left">Tier</th><th>Price</th><th>EV</th><th>Margin</th><th>Margin %</th></tr>
          </thead>
          <tbody>
            {data.tiers.map((t: any) => (
              <tr key={t.tier.id} className="border-t border-border">
                <td className="py-2">{t.tier.name}</td>
                <td className="text-center">{fmt(t.tier.price_cents)}</td>
                <td className="text-center">{t.ev ? fmt(t.ev.ev_cents) : "—"}</td>
                <td className={`text-center ${t.ev?.margin_cents >= 0 ? "text-success" : "text-danger"}`}>
                  {t.ev ? fmt(t.ev.margin_cents) : "—"}
                </td>
                <td className="text-center">{t.ev ? `${t.ev.margin_pct}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-zinc-500 mt-3">
          EV is computed live from the average price of cards in each rarity bucket. A negative margin
          means the house is paying out more than it takes in — investigate before shipping.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Activity</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Users" value={String(data.users.total_users)} />
          <Stat label="Packs sold" value={String(data.activity.packs_sold)} />
          <Stat label="Trades" value={String(data.activity.trades_completed)} />
          <Stat label="Auctions" value={String(data.activity.auctions_ended)} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">User balances</div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Total available" value={fmt(data.users.total_balance_cents)} />
          <Stat label="Total held in bids" value={fmt(data.users.total_held_cents)} />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`font-bold ${highlight ? "text-2xl text-accent" : "text-lg"}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}
