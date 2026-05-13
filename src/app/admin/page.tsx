"use client";
import { useEffect, useState } from "react";

type Tab = "economics" | "simulate" | "fraud" | "fairness" | "health";

const fmt = (c: number) => `$${(Number(c) / 100).toFixed(2)}`;
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("economics");
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Platform Admin</h1>
        <nav className="flex gap-1 text-sm">
          {(["economics", "simulate", "fraud", "fairness", "health"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1 rounded ${tab === t ? "bg-accent text-black font-semibold" : "border border-border"}`}>
              {t}
            </button>
          ))}
        </nav>
      </div>
      {tab === "economics" && <Economics />}
      {tab === "simulate" && <Simulator />}
      {tab === "fraud" && <Fraud />}
      {tab === "fairness" && <Fairness />}
      {tab === "health" && <Health />}
    </div>
  );
}

function Economics() {
  const [data, setData] = useState<any>(null);
  const [rebal, setRebal] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch("/api/admin/economics").then(r => r.json()).then(setData); }, []);
  async function preview() {
    setBusy(true);
    const r = await fetch("/api/admin/economics/rebalance", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: true }),
    });
    setRebal(await r.json()); setBusy(false);
  }
  async function apply() {
    if (!confirm("Apply new weights to all tiers?")) return;
    setBusy(true);
    const r = await fetch("/api/admin/economics/rebalance", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dry_run: false }),
    });
    setRebal(await r.json()); setBusy(false);
    fetch("/api/admin/economics").then(r => r.json()).then(setData);
  }
  if (!data) return <div>Loading…</div>;
  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Revenue (lifetime)</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total" value={fmt(data.revenue.total_cents)} highlight />
          {data.revenue.breakdown.map((r: any) => (
            <Stat key={r.source} label={r.source.replace("_", " ")} value={fmt(r.total_cents)} sub={`${r.events} events`} />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold">Per-tier EV vs target</div>
          <div className="flex gap-2">
            <button onClick={preview} disabled={busy} className="text-xs border border-border rounded px-2 py-1">Preview rebalance</button>
            <button onClick={apply} disabled={busy || !rebal} className="text-xs bg-accent text-black rounded px-2 py-1 font-semibold">Apply</button>
          </div>
        </div>
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
                <td className={`text-center ${t.ev?.margin_cents >= 0 ? "text-success" : "text-danger"}`}>{t.ev ? fmt(t.ev.margin_cents) : "—"}</td>
                <td className="text-center">{t.ev ? `${t.ev.margin_pct}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {rebal && (
        <section className="rounded-lg border border-accent bg-panel p-4">
          <div className="text-sm font-semibold mb-2">
            Rebalance {rebal.dry_run ? "preview" : "applied"} — target {pct(rebal.target_cfg.target_margin_bps)}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {rebal.results.map((r: any) => (
              <div key={r.tier_slug} className="border border-border rounded p-3">
                <div className="font-semibold">{r.tier_slug}</div>
                <div className="text-xs text-zinc-500">solver: {r.after.reason} in {r.after.iterations} iter</div>
                <div className="text-xs">margin: <span className={r.after.margin_bps >= 0 ? "text-success" : "text-danger"}>{pct(r.after.margin_bps)}</span> · win-rate: {pct(r.after.win_rate_bps)}</div>
                <div className="text-xs mt-2 font-mono">{Object.entries(r.after.weights).map(([k, v]: any) => (
                  <div key={k} className="flex justify-between">
                    <span>{k}</span>
                    <span>{(Number(v) * 100).toFixed(2)}%
                      <span className="text-zinc-500"> ← {((r.before[k] ?? 0) * 100).toFixed(2)}%</span>
                    </span>
                  </div>
                ))}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Simulator() {
  const [slug, setSlug] = useState("premium");
  const [count, setCount] = useState(10_000);
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const r = await fetch("/api/admin/economics/simulate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier_slug: slug, count }),
    });
    setOut(await r.json()); setBusy(false);
  }
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-panel p-4 flex gap-2 items-end">
        <label className="text-sm">Tier
          <select value={slug} onChange={e => setSlug(e.target.value)} className="ml-2 bg-bg border border-border rounded px-2 py-1">
            <option value="starter">starter</option>
            <option value="premium">premium</option>
            <option value="elite">elite</option>
            <option value="legendary">legendary</option>
          </select>
        </label>
        <label className="text-sm">Openings
          <input type="number" value={count} min={100} max={100_000}
            onChange={e => setCount(parseInt(e.target.value, 10))}
            className="ml-2 bg-bg border border-border rounded px-2 py-1 w-24" />
        </label>
        <button onClick={run} disabled={busy} className="bg-accent text-black px-3 py-1 rounded font-semibold text-sm">
          {busy ? "Running…" : "Simulate"}
        </button>
      </div>
      {out && (
        <div className="rounded-lg border border-border bg-panel p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="Pack price" value={fmt(out.tier.price_cents)} />
            <Stat label="Analytical EV" value={fmt(out.analytical.ev_cents)} />
            <Stat label="Observed mean" value={fmt(out.simulation.observed_mean_cents)} />
            <Stat label="Median" value={fmt(out.simulation.median_cents)} />
            <Stat label="Margin (observed)" value={pct(out.simulation.margin_bps)} />
            <Stat label="Win rate" value={pct(out.simulation.win_rate_bps)} />
            <Stat label="Std dev" value={fmt(out.simulation.std_dev_cents)} />
            <Stat label="Rev / 1k packs" value={fmt(out.simulation.projected_revenue_cents_per_1000_packs)} />
          </div>
          <div>
            <div className="text-xs text-zinc-500 mb-1">Pack value distribution</div>
            <div className="flex items-end gap-px h-32 bg-bg border border-border rounded p-2">
              {out.simulation.histogram.map((b: any, i: number) => {
                const max = Math.max(...out.simulation.histogram.map((x: any) => x.count));
                const h = max === 0 ? 0 : (b.count / max) * 100;
                return <div key={i} title={`${fmt(b.bucket_lo)}–${fmt(b.bucket_hi)}: ${b.count}`}
                  className="flex-1 bg-accent" style={{ height: `${h}%` }} />;
              })}
            </div>
            <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
              <span>0</span>
              <span>{fmt(out.simulation.histogram[out.simulation.histogram.length - 1].bucket_hi)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Fraud() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetch("/api/admin/fraud").then(r => r.json()).then(setData); }, []);
  if (!data) return <div>Loading…</div>;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Rate-limit events (24h)</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500"><tr><th className="text-left">Endpoint</th><th>Outcome</th><th>Count</th></tr></thead>
          <tbody>
            {data.rate_limit_24h.map((r: any, i: number) => (
              <tr key={i} className="border-t border-border">
                <td className="py-1">{r.endpoint}</td>
                <td className="text-center">{r.outcome}</td>
                <td className="text-center">{r.n}</td>
              </tr>
            ))}
            {data.rate_limit_24h.length === 0 && <tr><td colSpan={3} className="text-zinc-500 text-center py-3">None</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Flagged accounts</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500"><tr><th className="text-left">Email</th><th>Bot score</th><th>Reason</th></tr></thead>
          <tbody>
            {data.flagged_accounts.map((u: any) => (
              <tr key={u.id} className="border-t border-border">
                <td className="py-1 font-mono text-xs">{u.email}</td>
                <td className="text-center text-danger font-bold">{(u.bot_score * 100).toFixed(0)}%</td>
                <td className="text-xs">{u.flagged_reason}</td>
              </tr>
            ))}
            {data.flagged_accounts.length === 0 && <tr><td colSpan={3} className="text-zinc-500 text-center py-3">None</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Wash-trade flags</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500"><tr><th>Kind</th><th>Severity</th><th>Reason</th><th>User A</th><th>User B</th><th>When</th></tr></thead>
          <tbody>
            {data.wash_trade_flags.map((f: any) => (
              <tr key={f.id} className="border-t border-border text-xs">
                <td className="text-center">{f.related_kind}</td>
                <td className="text-center">{"★".repeat(f.severity)}</td>
                <td>{f.reason}</td>
                <td className="font-mono">{f.user_a?.slice(0, 8)}</td>
                <td className="font-mono">{f.user_b?.slice(0, 8)}</td>
                <td>{new Date(f.flagged_at).toLocaleString()}</td>
              </tr>
            ))}
            {data.wash_trade_flags.length === 0 && <tr><td colSpan={6} className="text-zinc-500 text-center py-3">None</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Fairness() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetch("/api/admin/fairness").then(r => r.json()).then(setData); }, []);
  if (!data) return <div>Loading…</div>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Chi-squared goodness-of-fit test of observed pull rarity vs advertised weights.
        High p-value (&gt;0.05) means the actual distribution is consistent with what we advertised.
      </p>
      {data.per_tier.map((t: any) => (
        <section key={t.tier.id} className="rounded-lg border border-border bg-panel p-4">
          <div className="flex justify-between items-center">
            <div className="font-semibold">{t.tier.name}</div>
            <div className="text-xs text-zinc-500">{t.n_packs} packs · {t.n_pulls ?? 0} pulls</div>
          </div>
          {t.test ? (
            <>
              <div className="mt-2 text-sm">
                χ² = {t.test.chi2.toFixed(3)} · df = {t.test.df} ·{" "}
                <span className={t.test.p_value < 0.05 ? "text-danger" : "text-success"}>
                  p = {t.test.p_value.toFixed(4)}
                </span>{" "}
                {t.test.p_value < 0.01 ? "(strong deviation)" : t.test.p_value < 0.05 ? "(suspicious)" : "(consistent)"}
              </div>
              <table className="w-full text-xs mt-2">
                <thead className="text-zinc-500"><tr><th className="text-left">Rarity</th><th>Observed</th><th>Expected</th><th>χ contribution</th></tr></thead>
                <tbody>
                  {t.test.per_rarity.map((r: any) => (
                    <tr key={r.rarity} className="border-t border-border">
                      <td className="py-1">{r.rarity}</td>
                      <td className="text-center">{r.obs}</td>
                      <td className="text-center">{r.exp}</td>
                      <td className="text-center">{r.chi.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : <div className="text-xs text-zinc-500 mt-2">Not enough revealed packs to test.</div>}
        </section>
      ))}
    </div>
  );
}

function Health() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetch("/api/admin/health").then(r => r.json()).then(setData); }, []);
  if (!data) return <div>Loading…</div>;
  return (
    <div className="space-y-4">
      {data.alerts.length > 0 && (
        <section className="rounded-lg border border-danger bg-panel p-4">
          <div className="text-sm font-semibold text-danger">Alerts ({data.alerts.length})</div>
          <ul className="text-sm mt-2 space-y-1">
            {data.alerts.map((a: any, i: number) => (
              <li key={i}>
                <span className={a.severity === "critical" ? "text-danger" : "text-accent"}>[{a.severity}]</span>{" "}
                <strong>{a.tier}</strong> — {a.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Margin per tier (last 24h)</div>
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500"><tr><th className="text-left">Tier</th><th>Packs</th><th>Revenue</th><th>Payout</th><th>Margin</th><th>vs target ({pct(data.target_margin_bps)})</th></tr></thead>
          <tbody>
            {data.margins.map((m: any) => {
              const dev = m.realised_margin_bps == null ? null : m.realised_margin_bps - data.target_margin_bps;
              return (
                <tr key={m.id} className="border-t border-border">
                  <td className="py-1">{m.name}</td>
                  <td className="text-center">{m.packs}</td>
                  <td className="text-center">{fmt(m.revenue)}</td>
                  <td className="text-center">{fmt(m.payout)}</td>
                  <td className="text-center">{m.realised_margin_bps == null ? "—" : pct(m.realised_margin_bps)}</td>
                  <td className={`text-center ${dev == null ? "" : Math.abs(dev) > 500 ? "text-danger" : "text-success"}`}>
                    {dev == null ? "—" : `${dev > 0 ? "+" : ""}${(dev / 100).toFixed(2)}pp`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Auction health (7d)</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label="Live now" value={String(data.auctions.live_count)} />
          <Stat label="Ended (7d)" value={String(data.auctions.ended_7d)} />
          <Stat label="Avg bidders" value={(data.auctions.avg_bidders ?? 0).toFixed(2)} />
          <Stat label="Sealed bids" value={String(data.auctions.sealed_bids)} />
          <Stat label="Rejected bids" value={String(data.auctions.rejected_bids)} />
          <Stat label="Open flags" value={String(data.auctions.open_flags)} />
        </div>
      </section>
      <section className="rounded-lg border border-border bg-panel p-4">
        <div className="text-sm font-semibold mb-2">Users</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Stat label="Total" value={String(data.users.total_users)} />
          <Stat label="New (7d)" value={String(data.users.new_users_7d)} />
          <Stat label="DAU (packs)" value={String(data.users.dau_packs)} />
          <Stat label="DAU (bidders)" value={String(data.users.dau_bidders)} />
          <Stat label="Flagged" value={String(data.users.flagged_count)} />
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
