# features

Feature-owned browser runtime modules extracted from routes and broad utility layers.

## Purpose

Provides explicit feature ownership seams so route files can compose behavior instead of implementing full runtimes inline.

## Subfolders

### `browser/` → [browser/browser.spec.md](./browser/browser.spec.md)

Bud-owned remote browser viewer, imperative bounded canvas/media lifecycle,
private human controls and thread session discovery. Separate from app proxies.

### `threads/` → [threads/threads.spec.md](./threads/threads.spec.md)

Thread-scoped browser runtime logic extracted from `/$budId/$threadId`,
including transcript reconciliation, agent/terminal streaming, terminal session
ownership, the file viewer open/fetch state machine, and proxied web-view state.

## Notes

- This folder now contains both route-owned runtime hooks and the first extracted pure helper/test seams used by the web package's Node-based test harness.
- Feature modules here should own behavior/state and avoid becoming a second catch-all utility layer.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
