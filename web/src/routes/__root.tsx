import { createRootRoute, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { ThemeProvider } from '@/components/theme-provider'
import { LayoutProvider } from '@/contexts/layout-context'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <ThemeProvider>
      <LayoutProvider>
        <Outlet />
        {import.meta.env.VITE_ROUTER_DEVTOOLS === 'true' && (
          <TanStackRouterDevtools position="bottom-right" initialIsOpen={false} />
        )}
      </LayoutProvider>
    </ThemeProvider>
  )
}
