import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import './index.css'
import { buildDescribe } from '@/lib/build-info'

// Build identity in every session's console — lets any bug report answer
// "which web build?" without UI screenshots.
console.info(`bud web build ${buildDescribe()}`)

// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Create a new router instance
const router = createRouter({ routeTree })

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
