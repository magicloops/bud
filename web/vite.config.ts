import { execSync } from 'node:child_process'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

function gitDescribe(): string {
  // Mirrors the daemon's BUD_BUILD_DESCRIBE: tag + commits-since + short SHA
  // (+ -dirty), e.g. "v0.1.13-2-g2a57857". Best-effort — builds outside a
  // git checkout fall back to "unknown".
  try {
    return execSync('git describe --tags --long --always --dirty', {
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000'

  return {
    define: {
      __BUD_WEB_BUILD__: JSON.stringify(gitDescribe()),
    },
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
          changeOrigin: true,
          xfwd: true
        },
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          xfwd: true
        },
        '/term': {
          target: proxyTarget,
          changeOrigin: true,
          xfwd: true,
          ws: true
        }
      }
    }
  }
})
