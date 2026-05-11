import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-border bg-panel p-8">
        <h1 className="text-3xl font-bold">PullVault</h1>
        <p className="mt-2 text-zinc-400">
          Buy mystery packs of real Pokemon cards. Rip them open. Discover their market value.
          Trade or auction with other collectors.
        </p>
        <div className="mt-6 flex gap-3">
          <Link href="/packs" className="bg-accent text-black px-4 py-2 rounded font-semibold">View Drops</Link>
          <Link href="/auctions" className="border border-border px-4 py-2 rounded">Live Auctions</Link>
        </div>
      </section>
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { title: "Pack Drops", body: "Limited inventory. Scheduled drop times. Compete to buy." },
          { title: "Live Auctions", body: "Real-time bidding with anti-snipe. Server-authoritative timer." },
          { title: "Marketplace", body: "List cards at fixed price. Atomic transactions." },
        ].map((c) => (
          <div key={c.title} className="rounded-lg border border-border bg-panel p-4">
            <div className="font-semibold">{c.title}</div>
            <div className="text-sm text-zinc-400 mt-1">{c.body}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
