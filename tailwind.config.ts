import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0d12",
        panel: "#11141b",
        border: "#1f2430",
        accent: "#f5a524",
        success: "#22c55e",
        danger: "#ef4444",
      },
    },
  },
  plugins: [],
} satisfies Config;
