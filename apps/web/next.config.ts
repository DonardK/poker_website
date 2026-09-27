import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  transpilePackages: ["@poker/shared"],
  reactStrictMode: true,
  distDir: process.env.POKER_TEST_DIST_DIR ?? (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next"),
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
});

export default nextConfig;
