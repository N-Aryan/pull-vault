"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type Card = {
  card_id: string;
  tcg_id: string;
  name: string;
  set_name: string;
  rarity: string;
  image_url: string;
  price_cents_at_pull: number;
};

export default function RevealPage({ params }: { params: { id: string } }) {
  const [contents, setContents] = useState<Card[] | null>(null);
  const [revealedIdx, setRevealedIdx] = useState(0);
  const [done, setDone] = useState(false);
  const [pricePaid, setPricePaid] = useState(0);

  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/packs/${params.id}/reveal`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) { alert(j.error); return; }
      // Sort: commons first, biggest pulls last → builds tension on reveal.
      const order = ["common", "uncommon", "rare", "holo", "ultra", "secret"];
      const sorted = [...(j.contents as Card[])].sort(
        (a, b) => order.indexOf(a.rarity) - order.indexOf(b.rarity),
      );
      setContents(sorted);

      // Fetch the pack to get the price paid for the P/L summary.
      const my = await fetch("/api/packs/mine").then((r) => r.json());
      const me = my.find((p: any) => p.id === params.id);
      setPricePaid(me?.price_paid ?? 0);
    })();
  }, [params.id]);

  if (!contents) return <div>Opening pack…</div>;

  const total = contents.reduce((a, c) => a + c.price_cents_at_pull, 0);
  const pl = total - pricePaid;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Pack Reveal</h1>
      {!done ? (
        <div className="text-center">
          <div className="text-zinc-400 mb-4">Tap to reveal — {revealedIdx} / {contents.length}</div>
          <div className="flex justify-center">
            {revealedIdx < contents.length ? (
              <button
                onClick={() => {
                  if (revealedIdx + 1 >= contents.length) setDone(true);
                  setRevealedIdx((i) => i + 1);
                }}
                className="bg-accent text-black px-8 py-4 rounded-lg text-xl font-bold"
              >
                {revealedIdx === 0 ? "Open Pack" : `Reveal Card ${revealedIdx + 1}`}
              </button>
            ) : (
              <button onClick={() => setDone(true)} className="bg-accent text-black px-8 py-4 rounded-lg text-xl font-bold">
                See Summary
              </button>
            )}
          </div>
          {revealedIdx > 0 && (
            <div className="mt-6">
              <CardView c={contents[revealedIdx - 1]} />
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {contents.map((c, i) => <CardView key={i} c={c} small />)}
          </div>
          <div className="mt-6 rounded-lg border border-border bg-panel p-4">
            <div className="flex justify-between">
              <span>Pack price</span>
              <span>${(pricePaid / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span>Pulled value</span>
              <span>${(total / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold mt-2 pt-2 border-t border-border">
              <span>P/L</span>
              <span className={pl >= 0 ? "text-success" : "text-danger"}>
                {pl >= 0 ? "+" : ""}${(pl / 100).toFixed(2)}
              </span>
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <Link href="/collection" className="bg-accent text-black px-4 py-2 rounded font-semibold">
              View Collection
            </Link>
            <Link href="/packs" className="border border-border px-4 py-2 rounded">More Packs</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function CardView({ c, small }: { c: Card; small?: boolean }) {
  return (
    <div className={`rounded-lg border border-border bg-panel ${small ? "p-2" : "p-4"} card-shadow`}>
      <img src={c.image_url} alt={c.name} className={small ? "w-full rounded" : "w-48 mx-auto rounded"} />
      <div className={small ? "text-xs mt-1" : "mt-3"}>
        <div className={`font-semibold ${small ? "truncate" : ""}`}>{c.name}</div>
        <div className="text-xs text-zinc-500">{c.set_name}</div>
        <div className={`text-xs uppercase rarity-${c.rarity}`}>{c.rarity}</div>
        <div className="font-mono mt-1">${(c.price_cents_at_pull / 100).toFixed(2)}</div>
      </div>
    </div>
  );
}
