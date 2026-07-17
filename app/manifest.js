// Served at /manifest.webmanifest. Next injects <link rel="manifest"> automatically
// and prerenders this to a static file at build time.
export default function manifest() {
  return {
    name: "CutCoach",
    short_name: "CutCoach",
    description: "Training and nutrition ledger with an AI coach",
    id: "/",
    start_url: "/",
    scope: "/",
    // Load-bearing: iOS only delivers web push to a home-screen app in
    // standalone or fullscreen. Anything else silently degrades to a bookmark.
    display: "standalone",
    orientation: "portrait",
    background_color: "#020617",
    theme_color: "#020617",
    categories: ["health", "fitness"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Separate entry, never `purpose: "any maskable"` on one icon — Chrome would
      // crop the rounded art into a circle.
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
