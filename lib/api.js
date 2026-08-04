import { getSupabase } from "./supabaseClient";

// Calls our own serverless proxy (which holds the Anthropic key) — never Anthropic directly.
// Second arg: options object { system, maxTokens }. A bare number is still accepted as
// maxTokens for the legacy call sites.
export async function askClaude(messages, opts = {}) {
  const { system = null, maxTokens = 1024 } = typeof opts === "number" ? { maxTokens: opts } : opts;
  const supabase = getSupabase();
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch("/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages, max_tokens: maxTokens, ...(system ? { system } : {}) }),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* non-JSON body */
  }
  if (data && data.error) {
    const msg = typeof data.error === "string" ? data.error : data.error.message;
    throw new Error(`${msg || "API error"} [http ${res.status}]`);
  }
  if (!res.ok) throw new Error(`API error [http ${res.status}]`);
  if (!data || !Array.isArray(data.content)) {
    throw new Error(`Unexpected response [http ${res.status}]`);
  }
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
