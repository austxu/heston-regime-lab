/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark "quant terminal" palette.
        base: '#0a0e16', // app background
        panel: '#111726', // card background
        panel2: '#0d1320', // nested/sunken background
        edge: '#1e2940', // borders
        ink: '#e6edf6', // primary text
        muted: '#8a97ad', // secondary text
        accent: '#38bdf8', // sky-400, primary accent
        // Regime semantics (kept in sync with src/lib/theme.ts).
        calm: '#34d399', // emerald
        elevated: '#fbbf24', // amber
        crisis: '#f43f5e', // rose
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
