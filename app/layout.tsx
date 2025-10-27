import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aave V3 Liquidation Tracker",
  description:
    "Real-time monitoring and analytics for Aave V3 liquidations with asset level insights and historical metrics.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
