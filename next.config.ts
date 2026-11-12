import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite ships its own WASM build; load it from node_modules instead of bundling it.
  serverExternalPackages: ["@electric-sql/pglite"],
  async redirects() {
    return [
      { source: "/wallet", destination: "/wallet/send", permanent: false },
      { source: "/trading", destination: "/trading/XLM-USDC", permanent: false },
      // Old /app/* links from before every screen got its own top-level route.
      { source: "/app", destination: "/assistant", permanent: true },
      { source: "/app/trade", destination: "/trading", permanent: true },
      { source: "/app/:path*", destination: "/:path*", permanent: true },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
