/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal, self-contained server bundle (.next/standalone) with only the
  // production dependencies actually traced from the build output — the officially
  // documented way to containerize a Next.js app (docs/26_DECISIONS.md ADR-037's Dockerfile
  // relies on this). No effect on `next dev`/`next start` outside a container.
  output: "standalone",
};

export default nextConfig;
