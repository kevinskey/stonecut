import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs: the Mac App Store build loads dist/index.html over
  // file://, where an absolute "/assets/…" resolves to the filesystem root
  // instead of the app bundle and the window comes up empty.
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      // T-Shirt Brothers art library — the API allows CORS but the Spaces
      // CDN does not, so both ride the dev proxy and the app fetches
      // same-origin.
      '/tsb-api': {
        target: 'https://tshirtbrothers.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tsb-api/, '/api'),
      },
      '/tsb-cdn': {
        target: 'https://tshirtbrothers.atl1.cdn.digitaloceanspaces.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tsb-cdn/, ''),
      },
    },
  },
})
