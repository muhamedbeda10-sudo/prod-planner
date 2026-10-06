import type { MetadataRoute } from "next";

// What makes the app installable on a phone, tablet or desktop: its name and
// icon on the home screen, and opening in its own window without the
// browser's bars. The theme matches the dark industrial default.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ATC — Steel Fabrication ERP",
    short_name: "ATC ERP",
    description: "Arabian Transformers Co. — steel fabrication ERP system",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#1c2220",
    theme_color: "#1c2220",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
