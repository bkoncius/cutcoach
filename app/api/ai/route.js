import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    // 1) Authenticate the caller with their Supabase JWT.
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return Response.json({ error: { message: "Missing auth token" } }, { status: 401 });
    }
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
    }

    // 2) Forward to Anthropic with the server-held key.
    const body = await req.json();
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: { message: "messages required" } }, { status: 400 });
    }
    const maxTokens = Math.min(Number(body?.max_tokens) || 1024, 2048);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: maxTokens,
        messages,
      }),
    });

    const out = await r.json();
    return Response.json(out, { status: r.status });
  } catch (e) {
    return Response.json(
      { error: { message: e?.message || "Proxy error" } },
      { status: 500 }
    );
  }
}
