export default {
  plugins: {
    // FIX: Use the specific PostCSS package requested by the Vercel build environment
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
}
