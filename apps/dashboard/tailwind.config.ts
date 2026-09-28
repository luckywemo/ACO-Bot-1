import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0e14",
        panel: "#12161f",
        edge: "#1f2733",
        accent: "#2081e2",
      },
    },
  },
  plugins: [],
} satisfies Config;
