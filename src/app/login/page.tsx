"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const r = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const res = await fetch(`/api/auth/${mode === "login" ? "login" : "signup"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: pw }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || "failed");
      return;
    }
    r.push("/packs");
    r.refresh();
  }

  return (
    <div className="max-w-md mx-auto rounded-lg border border-border bg-panel p-6 mt-10">
      <h1 className="text-2xl font-bold mb-4">{mode === "login" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={submit} className="space-y-3">
        <input className="w-full rounded bg-bg border border-border px-3 py-2"
          type="email" placeholder="email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input className="w-full rounded bg-bg border border-border px-3 py-2"
          type="password" placeholder="password (min 8)" value={pw} onChange={e => setPw(e.target.value)} minLength={8} required />
        {err && <div className="text-danger text-sm">{err}</div>}
        <button className="w-full bg-accent text-black font-semibold rounded py-2">
          {mode === "login" ? "Sign in" : "Sign up"}
        </button>
      </form>
      <div className="mt-3 text-sm text-zinc-400">
        {mode === "login" ? (
          <>No account? <button className="text-accent" onClick={() => setMode("signup")}>Sign up</button></>
        ) : (
          <>Have an account? <button className="text-accent" onClick={() => setMode("login")}>Sign in</button></>
        )}
      </div>
    </div>
  );
}
