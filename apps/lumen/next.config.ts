import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma and the Anthropic SDK run server-side only.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  images: { unoptimized: true },
};

export default nextConfig;
