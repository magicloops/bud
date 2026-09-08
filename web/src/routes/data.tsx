import { createFileRoute } from '@tanstack/react-router'
import { DataScreen } from '@/components/data-screen'
export const Route = createFileRoute('/data')({
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    request: typeof search.request === 'string' && /^dar_[0-9A-HJKMNP-TV-Z]{26}$/.test(search.request) ? search.request : undefined,
  }),
  component: () => { const { request } = Route.useSearch(); return <DataScreen requestId={request} /> },
})
