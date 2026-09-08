# Debug: Automation route fixture interface

`pnpm --dir service build` reported TS2739 in routes.test.ts: the injected
repository fixture lacked create, update and pause after those methods were added
to the route dependency. Added explicit unused-method stubs; the real database
route test separately exercises all three mutations, ownership and conflicts.
