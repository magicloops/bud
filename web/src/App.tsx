import './App.css'

const views = [
  {
    title: 'Buds List',
    body: 'Presence, OS/arch, version, and last seen. Backed by Supabase Postgres and `/api/buds`.'
  },
  {
    title: 'Thread View',
    body: 'Chat composer, agent messages, tool call summaries, and a Stop button wired to cancel LLM + Bud.'
  },
  {
    title: 'Run Stream',
    body: 'SSE-driven log panes with auto-scroll, pause, and Last-Event-ID resume.'
  }
]

function App() {
  return (
    <div className="app-shell">
      <header>
        <p className="eyebrow">Bud Web UI · Proof-of-Concept</p>
        <h1>Remote runs you can see and stop</h1>
        <p className="lede">
          This scaffold will evolve into the Bud chat UI described in <code>plan/proof-of-concept.md</code>. Follow{' '}
          <code>plan/phase-0-scaffolding.md</code> while wiring REST + SSE endpoints into live components.
        </p>
        <div className="callout">
          <strong>Next steps</strong>
          <ul>
            <li>Hook SSE client to <code>/api/runs/:run_id/stream</code>.</li>
            <li>Render agent messages and shell output interleaved per run.</li>
            <li>Add Bud selection + enrollment token flow.</li>
          </ul>
        </div>
      </header>

      <section>
        <h2>Incoming surfaces</h2>
        <div className="feature-grid">
          {views.map((view) => (
            <article key={view.title} className="feature-card">
              <h3>{view.title}</h3>
              <p>{view.body}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

export default App
