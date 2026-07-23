/** @type {import('next').NextConfig} */
const nextConfig = {
  // Per-deploy id, exposed to the client so it can notice when a newer deploy is live.
  // VERCEL_GIT_COMMIT_SHA is set at build but isn't NEXT_PUBLIC_-prefixed, so it can't
  // reach the browser without this mapping. Local fallback is the build timestamp —
  // evaluated once per build, so it's stable within a build and changes across builds.
  env: {
    NEXT_PUBLIC_BUILD_ID:
      process.env.NEXT_PUBLIC_BUILD_ID ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      String(Date.now()),
  },
  async headers() {
    return [
      {
        // Not cosmetic: if the CDN caches sw.js, the service worker never updates
        // again and nothing tells you it stopped.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
