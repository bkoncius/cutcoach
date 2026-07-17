import "./globals.css";
import ServiceWorkerRegistrar from "../components/ServiceWorkerRegistrar";

export const metadata = {
  title: "CutCoach",
  description: "Training and nutrition ledger with an AI coach",
  applicationName: "CutCoach",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "CutCoach", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#020617",
  // Required for env(safe-area-inset-*) to report anything but 0 once installed.
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
