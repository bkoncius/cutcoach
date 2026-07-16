import { getSupabase } from "./supabaseClient";

// Calls our own serverless proxy (which holds the Anthropic key) — never Anthropic directly.
export async function askClaude(messages, maxTokens = 1024) {
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
    body: JSON.stringify({ messages, max_tokens: maxTokens }),
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
