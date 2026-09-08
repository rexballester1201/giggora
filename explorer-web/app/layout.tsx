import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { SearchBar } from "@/components/SearchBar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NetworkStatus } from "@/components/NetworkStatus";

export const metadata: Metadata = {
  title: "Giggora Explorer",
  description:
    "Block explorer for Giggora — an independent, EVM-compatible Layer-1 blockchain.",
};

/**
 * The faucet is a SEPARATE service on its own origin, so it is a plain anchor
 * rather than a next/link — Link would try to client-navigate to a route this
 * app does not have.
 *
 * NEXT_PUBLIC_* is inlined at BUILD time (see CLAUDE.md §4 item 19), so this
 * must be a build arg for the container image; changing it needs a rebuild, not
 * a restart. Unset, it points at the local faucet.
 */
const FAUCET_URL = process.env.NEXT_PUBLIC_FAUCET_URL ?? "http://localhost:4200";

const NAV = [
  { href: "/blocks", label: "Blocks" },
  { href: "/transactions", label: "Transactions" },
  { href: "/tokens", label: "Tokens" },
  { href: "/contracts", label: "Contracts" },
  { href: "/validators", label: "Validators" },
  { href: "/charts", label: "Charts" },
  { href: "/connect-wallet", label: "Connect wallet" },
  { href: FAUCET_URL, label: "Faucet", external: true },
];

/** One nav entry, internal or external. */
function NavLink({
  item,
  className,
}: {
  item: { href: string; label: string; external?: boolean };
  className?: string;
}) {
  const style = { color: item.external ? "var(--brand)" : "var(--text-dim)" };
  if (item.external) {
    return (
      <a href={item.href} className={className} style={style} rel="noopener">
        {item.label}
      </a>
    );
  }
  return (
    <Link href={item.href} className={className} style={style}>
      {item.label}
    </Link>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applied before first paint so the page never flashes the wrong theme.
          Inline by necessity — a deferred script would run after paint.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('giggora-theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(!t&&m))document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen">
        <header
          className="sticky top-0 z-20 backdrop-blur"
          style={{ background: "color-mix(in srgb, var(--surface) 88%, transparent)", borderBottom: "1px solid var(--border)" }}
        >
          <div className="mx-auto max-w-7xl px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <Link href="/" className="flex items-center gap-2 shrink-0" style={{ color: "var(--text)" }}>
                <span
                  className="grid h-8 w-8 place-items-center rounded-lg text-sm font-bold"
                  style={{ background: "var(--brand)", color: "#fff" }}
                  aria-hidden
                >
                  G
                </span>
                <span className="font-semibold">
                  Giggora<span style={{ color: "var(--text-dim)" }}> Explorer</span>
                </span>
              </Link>

              <nav className="hidden items-center gap-4 text-sm lg:flex">
                {NAV.map((n) => (
                  <NavLink key={n.href} item={n} />
                ))}
              </nav>

              <div className="flex items-center gap-3">
                <NetworkStatus />
                <ThemeToggle />
              </div>
            </div>

            {/* Mobile nav: scrolls horizontally rather than wrapping (§36). */}
            <nav className="mt-2 flex gap-4 overflow-x-auto text-sm lg:hidden">
              {NAV.map((n) => (
                <NavLink key={n.href} item={n} className="whitespace-nowrap" />
              ))}
            </nav>
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-4 py-4">
          <div className="mb-6">
            <SearchBar />
          </div>
          <main>{children}</main>
        </div>

        <footer
          className="mx-auto max-w-7xl px-4 py-8 text-xs"
          style={{ color: "var(--text-dim)" }}
        >
          <p>
            Giggora — an independent, EVM-compatible Layer-1 blockchain. All data on this site is
            read from the chain by the Giggora indexer.
          </p>
        </footer>
      </body>
    </html>
  );
}
