import { requireUser } from "../../../lib/serverAuth";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    // 1) Authenticate the caller with their Supabase JWT.
    const { error: authError } = await requireUser(req);
    if (authError) return authError;

    // 2) Forward to Anthropic with the server-held key.
    const body = await req.json();
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: { message: "messages required" } }, { status: 400 });
    }
    const maxTokens = Math.min(Number(body?.max_tokens) || 1024, 2048);
    // Optional system prompt. Length-capped to bound input tokens; no tools
    // passthrough on purpose — the deterministic engine decides all numbers, the
    // model only ever explains them.
    const system = typeof body?.system === "string" ? body.system.slice(0, 16000) : undefined;

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
        ...(system ? { system } : {}),
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
