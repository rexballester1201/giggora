/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The repo has a lockfile at the root and one here; name the root explicitly
  // so Next does not guess and warn on every build.
  outputFileTracingRoot: import.meta.dirname,
  // The explorer is read-only and renders only indexed chain data, so a strict
  // CSP is easy to hold. No inline scripts, no third-party origins.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default nextConfig;
