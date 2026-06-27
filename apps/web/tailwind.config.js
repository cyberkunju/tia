/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      colors: {
        // TASC brand — bright tropical green (matches the actual Search Vacancies CTA on tasc.ae).
        // Saturated, almost-neon — differentiates from ChatGPT's softer mint.
        brand: {
          50:  "#e4fdef",
          100: "#bef7d5",
          200: "#86eeb0",
          300: "#3ddf85",
          400: "#0fd06a",
          500: "#06b85d",
          600: "#069c4f",
          700: "#057c40",
          800: "#066132",
          900: "#08502a",
        },
        // TASC deep teal — header chrome, hero backgrounds, sidebar.
        // The dark band at the top of tasc.ae.
        teal: {
          50:  "#e6f3f8",
          100: "#bedee9",
          200: "#92c5d8",
          300: "#5fa7c0",
          400: "#318ba8",
          500: "#147093",
          600: "#0b5b7a",
          700: "#0b4762",
          800: "#0a3a52",
          900: "#08293a",
          950: "#051923",
        },
        // TASC accent yellow — high-visibility CTA bar ("Download Now").
        gold: {
          50:  "#fffbe6",
          100: "#fff3b0",
          200: "#ffe673",
          300: "#fcd72b",
          400: "#e9c014",
          500: "#c8a30c",
          600: "#9e7e07",
          700: "#7a6107",
        },
        // Neutral spine — a single, consistent slate ramp for every surface/line/text.
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
        focus: "0 0 0 3px rgb(19 185 106 / 0.22)",
      },
      borderRadius: {
        md: "0.4rem",
        lg: "0.55rem",
        xl: "0.75rem",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-in-right": { from: { transform: "translateX(100%)" }, to: { transform: "translateX(0)" } },
      },
      animation: {
        shimmer: "shimmer 1.4s infinite",
        "fade-in": "fade-in 0.18s ease-out",
        "slide-in-right": "slide-in-right 0.22s ease-out",
      },
    },
  },
  plugins: [],
};
