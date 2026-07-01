import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Better 82-0 Multiplayer",
  description: "Friends-only multiplayer Cap Mode for Better 82-0.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
