/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        // TASC accent (orange-red) - used deliberately, never as a wash.
        brand: {
          50: "#fef4ef",
          100: "#fde4d7",
          200: "#fac6ae",
          300: "#f5a07c",
          400: "#ed7547",
          500: "#d9531e",
          600: "#bf4117",
          700: "#9b3414",
          800: "#7c2c15",
          900: "#662614",
        },
        // Neutral spine - a single, consistent slate ramp for every surface/line/text.
        ink: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e7ecf2",
          300: "#d4dbe5",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
          950: "#020617",
        },
      },
      fontFamily: {
        sans: ["Inter var", "Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(15 23 42 / 0.04)",
        sm: "0 1px 2px 0 rgb(15 23 42 / 0.05), 0 1px 1px -1px rgb(15 23 42 / 0.04)",
        md: "0 6px 16px -6px rgb(15 23 42 / 0.10), 0 2px 6px -2px rgb(15 23 42 / 0.06)",
        lg: "0 16px 40px -12px rgb(15 23 42 / 0.18)",
        focus: "0 0 0 3px rgb(217 83 30 / 0.18)",
      },
      borderRadius: {
        md: "0.4rem",
        lg: "0.55rem",
        xl: "0.75rem",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
      },
      animation: {
        shimmer: "shimmer 1.4s infinite",
        "fade-in": "fade-in 0.18s ease-out",
      },
    },
  },
  plugins: [],
};
