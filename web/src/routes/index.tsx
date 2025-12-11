import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    // Fetch buds and redirect to first one
    const resp = await fetch('/api/buds')
    if (!resp.ok) {
      return {}
    }
    const buds = await resp.json()
    if (buds.length > 0) {
      throw redirect({ to: '/$budId', params: { budId: buds[0].bud_id } })
    }
    return {}
  },
  component: NoBudsView,
})

function NoBudsView() {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">No Buds Available</h1>
        <p className="text-muted-foreground">Please enroll a Bud first to get started.</p>
      </div>
    </div>
  )
}
