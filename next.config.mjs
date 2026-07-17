/** @type {import('next').NextConfig} */
const nextConfig = {
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
