import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
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
