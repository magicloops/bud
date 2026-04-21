import { createRootRoute, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { RouteErrorScreen } from '@/components/route-error-screen'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthSessionProvider } from '@/contexts/auth-session-provider'
import { LayoutProvider } from '@/contexts/layout-provider'
import { BudStatusProvider } from '@/contexts/bud-status-provider'
import { fetchCurrentUser } from '@/lib/auth-api'
import { config } from '@/lib/config'

export const Route = createRootRoute({
  loader: async () => ({
    currentUser: await fetchCurrentUser(),
  }),
  component: RootComponent,
  errorComponent: RootErrorComponent,
})

function RootComponent() {
  const { currentUser } = Route.useLoaderData()

  return (
    <ThemeProvider>
      <AuthSessionProvider initialCurrentUser={currentUser}>
        <LayoutProvider>
          <BudStatusProvider>
            <Outlet />
            {config.routerDevtools && (
              <TanStackRouterDevtools position="bottom-right" initialIsOpen={false} />
            )}
          </BudStatusProvider>
        </LayoutProvider>
      </AuthSessionProvider>
    </ThemeProvider>
  )
}

function RootErrorComponent({ error }: { error: unknown }) {
  return (
    <ThemeProvider>
      <RouteErrorScreen error={error} />
    </ThemeProvider>
  )
}
