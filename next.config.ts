import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The version this build is, baked into the pages and the server alike: an
  // open page compares its own with what /api/version answers to pick up a
  // new deployment (components/UpdateNotice.tsx). Empty outside Vercel — a
  // local build never asks.
  env: {
    APP_VERSION: process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "",
  },
  // What each server function carries. Prisma ships a query engine for every
  // database and runtime (MySQL, SQL Server, SQLite, CockroachDB, edge, wasm)
  // and the file tracer copies all of them into every one of the ~35 page
  // functions — ~60 MB each, a gigabyte per deployment on Vercel. The app runs
  // the Node library engine against Postgres: runtime/library.js and the
  // native .so.node are all it loads. The project's docs and reference files
  // ride along only because the uploads routes read from process.cwd().
  outputFileTracingExcludes: {
    "*": [
      "node_modules/@prisma/client/runtime/*.wasm-base64.*",
      "node_modules/@prisma/client/runtime/*.map",
      "node_modules/@prisma/client/runtime/{binary,client,edge,edge-esm,react-native,index-browser,wasm-compiler-edge,wasm-engine-edge}.*",
      "node_modules/.prisma/client/query_engine_bg.*",
      "node_modules/.prisma/client/{wasm,edge,index-browser}.js",
      "node_modules/.prisma/client/wasm-*-loader.mjs",
      "reference/**",
      "*.md",
      "tsconfig.tsbuildinfo",
      "package-lock.json",
    ],
  },
  experimental: {
    serverActions: {
      // chat attachments (and note photos) go through server actions as
      // multipart FormData — the 1 MB default would reject them
      bodySizeLimit: "12mb",
    },
    // client router cache: hopping between tabs and coming back within a
    // minute reuses the page you had (with its data) instead of a full
    // refetch — the next visit after that refreshes as usual
    staleTimes: {
      dynamic: 60,
      static: 300,
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
