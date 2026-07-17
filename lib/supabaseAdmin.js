// Service-role Supabase client. Bypasses RLS — never import this from a client component.
//
// `server-only` is the guard: importing this from anything that ends up in the browser
// bundle fails the BUILD rather than silently shipping a key that can read and write
// every user's data. The env var must never be prefixed NEXT_PUBLIC_.
import "server-only";
import { createClient } from "@supabase/supabase-js";

let admin = null;

export function getSupabaseAdmin() {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  admin = createClient(url, key, {
    // Opposite of the browser client: there is no session to persist or refresh in a
    // serverless function, and leaving these on leaks state across warm invocations.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
