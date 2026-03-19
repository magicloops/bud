import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000'

  return {
    plugins: [
      // TanStack Router must be before react plugin
      TanStackRouterVite({
        target: 'react',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss()
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    },
    server: {
      proxy: {
        '/.well-known': {
          target: proxyTarget,
          changeOrigin: true
        },
        '/api': {
          target: proxyTarget,
          changeOrigin: true
        },
        '/term': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true
        }
      }
    }
  }
})
