export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The always-fresh version source. NEXT_PUBLIC_BUILD_ID is inlined per deploy, so each
// deployment's function returns its own id; an open client compares it to the id baked
// into its own bundle and prompts a refresh on mismatch. force-dynamic + no-store keep
// Vercel's edge from handing back a stale value. The SW already skips /api/*, so this is
// never served from the client cache either.
export function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID || "dev" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
