import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blog Studio Chat Concepts",
  description: "Interactive Blog Studio chat interaction concepts.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
