import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    resolveAlias: {
      "accounts": "./lib/empty.js",
    },
  },
};

export default nextConfig;
