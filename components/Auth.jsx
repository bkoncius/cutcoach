"use client";

import { useState } from "react";
import { getSupabase } from "../lib/supabaseClient";

export default function Auth() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const submit = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setMsg("");
    try {
      const supabase = getSupabase();
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        setMsg("Account created. If email confirmation is enabled, check your inbox — then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
      }
    } catch (e) {
      setMsg(e?.message || "Something went wrong.");
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-xs font-semibold uppercase tracking-widest text-amber-400">
          CutCoach · Ledger
        </div>
        <h1 className="text-2xl font-bold tracking-tight mt-2">
          {mode === "signin" ? "Sign in" : "Create your account"}
        </h1>
        <div className="mt-6 space-y-3">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email"
            type="email"
            autoComplete="email"
            className="w-full bg-slate-900 rounded-xl px-4 py-3 text-sm border border-slate-800 outline-none focus:border-amber-400"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            className="w-full bg-slate-900 rounded-xl px-4 py-3 text-sm border border-slate-800 outline-none focus:border-amber-400"
          />
          <button
            onClick={submit}
            disabled={busy}
            className="w-full py-3 rounded-xl bg-amber-400 text-slate-950 font-bold disabled:opacity-40"
          >
            {busy ? "…" : mode === "signin" ? "Sign in" : "Sign up"}
          </button>
          {msg && <div className="text-xs text-slate-400 leading-relaxed">{msg}</div>}
          <button
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setMsg("");
            }}
            className="w-full text-xs text-slate-500 underline"
          >
            {mode === "signin" ? "No account yet? Sign up" : "Have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
