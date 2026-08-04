import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
