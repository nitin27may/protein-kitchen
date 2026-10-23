import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Protein Kitchen",
    short_name: "Kitchen",
    description: "Weekly vegetarian meal plans with computed protein, groceries and cook mode.",
    start_url: "/",
    display: "standalone",
    background_color: "#0e171c",
    theme_color: "#0f6b7a",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
