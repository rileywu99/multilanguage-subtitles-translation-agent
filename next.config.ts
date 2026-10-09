import type { NextConfig } from "next";

// NEXT_PUBLIC_DEMO=1 builds the static GitHub Pages demo: no server, so the
// API route is left out (pageExtensions keeps only .tsx, which drops
// route.ts) and the page replays a prepared sample run instead.
const demo = process.env.NEXT_PUBLIC_DEMO === "1";

const nextConfig: NextConfig = demo
  ? {
      output: "export",
      basePath: "/multilanguage-subtitles-translation-agent",
      pageExtensions: ["tsx"],
      images: { unoptimized: true },
    }
  : {};

export default nextConfig;
