import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { UserMenu } from "@/components/user-menu";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ACM Trading Simulator",
  description: "A seeded, live market for algorithmic trading competitions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-border bg-panel/60">
          <div className="mx-auto flex min-h-14 max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
            <Link href="/" className="flex items-center gap-2 whitespace-nowrap font-semibold tracking-tight">
              <span className="num rounded bg-accent px-1.5 text-sm text-black">ACM</span>
              <span className="hidden sm:inline">Trading Simulator</span>
            </Link>
            <div className="flex flex-wrap items-center gap-3 whitespace-nowrap">
              <Link href="/about" className="text-sm text-muted hover:text-foreground">
                How it works
              </Link>
              <Link href="/strategies" className="text-sm text-muted hover:text-foreground">
                Strategies
              </Link>
              <Suspense fallback={<div className="h-8 w-24 animate-pulse rounded bg-panel-2" />}>
                <UserMenu />
              </Suspense>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-border">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted">
            <span>A practice market for UChicago ACM&apos;s algorithmic trading competitions.</span>
            <div className="flex gap-4">
              <Link href="/about" className="hover:text-foreground">
                How it works
              </Link>
              <Link href="/strategies" className="hover:text-foreground">
                Strategies
              </Link>
              <Link href="/privacy" className="hover:text-foreground">
                Privacy Policy
              </Link>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
