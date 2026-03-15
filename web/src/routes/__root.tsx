import { createRootRoute, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthSessionProvider } from '@/contexts/auth-session-context'
import { LayoutProvider } from '@/contexts/layout-context'
import { BudStatusProvider } from '@/contexts/bud-status-context'
import { fetchCurrentUser } from '@/lib/api'
import { config } from '@/lib/config'

export const Route = createRootRoute({
  loader: async () => ({
    currentUser: await fetchCurrentUser(),
  }),
  component: RootComponent,
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
