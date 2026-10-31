import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { rolldownOptions: { output: { codeSplitting: { groups: [{ name(id: string) {
    if (id.includes('fflate')) return 'zip-engine'
    if (id.includes('opentype.js')) return 'font-engine'
    if (id.includes('polygon-clipping')) return 'polygon-engine'
    if (id.includes('node_modules')) return 'vendor'
    return null
  } }] } } } },
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
