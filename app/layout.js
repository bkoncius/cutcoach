import "./globals.css";

export const metadata = {
  title: "CutCoach",
  description: "Training and nutrition ledger with an AI coach",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#020617",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
