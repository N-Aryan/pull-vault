import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";
import { currentUserId } from "@/lib/auth";
import { pool } from "@/lib/db";
import { formatUSD } from "@/lib/money";

export const metadata = { title: "PullVault", description: "Pokemon TCG pack ripping + auctions" };

async function NavBalance() {
  const uid = await currentUserId();
  if (!uid) return <Link href="/login" className="text-accent">Sign in</Link>;
  const { rows } = await pool.query(
    `SELECT email, balance_available, balance_held FROM users WHERE id = $1`, [uid]);
  if (rows.length === 0) return null;
  const u = rows[0];
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-zinc-400">{u.email}</span>
      <span className="font-semibold">{formatUSD(Number(u.balance_available))}</span>
      {Number(u.balance_held) > 0 && (
        <span className="text-amber-400">held {formatUSD(Number(u.balance_held))}</span>
      )}
      <form action="/api/auth/logout" method="post"><button type="submit" className="text-xs text-zinc-500 hover:text-white">logout</button></form>
    </div>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-border bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-6">
              <Link href="/" className="font-bold text-lg">PullVault</Link>
              <nav className="flex gap-4 text-sm">
                <Link href="/packs">Packs</Link>
                <Link href="/collection">Collection</Link>
                <Link href="/marketplace">Marketplace</Link>
                <Link href="/auctions">Auctions</Link>
                <Link href="/verify">Verify</Link>
                <Link href="/admin">Admin</Link>
              </nav>
            </div>
            <NavBalance />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
