import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript source.
  transpilePackages: ["@reel/core", "@reel/db", "@reel/video"],
  turbopack: { root: path.resolve(process.cwd(), "../..") },
  // Type checking runs through the repo's `npm run typecheck` (TypeScript 7), not during `next build`.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
