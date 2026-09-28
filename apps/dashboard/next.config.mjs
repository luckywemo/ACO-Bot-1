/** @type {import('next').NextConfig} */
// Server-side only: where /api/* is proxied to. 127.0.0.1, not localhost —
// the API binds IPv4-only and Windows resolves localhost to ::1 first.
const API = process.env.ACO_API_URL ?? "http://127.0.0.1:4000";

const nextConfig = {
  // Browser fetches stay same-origin (/api/*) — no CORS, no port or
  // localhost-resolution issues on the client.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/api/:path*` }];
  },
};

export default nextConfig;
