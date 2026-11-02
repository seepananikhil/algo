import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
    dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8090' } },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/lightweight-charts')) {
            return 'vendor-charts'
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons'
          }
        },
      },
    },
  },
})
