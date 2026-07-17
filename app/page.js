"use client";

import { useState, useEffect } from "react";
import { getSupabase } from "../lib/supabaseClient";
import Auth from "../components/Auth";
import CutCoachApp from "../components/CutCoachApp";

export default function Home() {
  const [session, setSession] = useState(undefined); // undefined = checking

  useEffect(() => {
    const supabase = getSupabase();
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-500 font-mono text-sm animate-pulse">loading…</div>
      </div>
    );
  }
  if (!session) return <Auth />;
  return <CutCoachApp key={session.user.id} userId={session.user.id} />;
}
