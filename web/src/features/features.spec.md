# features

Feature-owned browser runtime modules extracted from routes and broad utility layers.

## Purpose

Provides explicit feature ownership seams so route files can compose behavior instead of implementing full runtimes inline.

## Subfolders

### `threads/` → [threads/threads.spec.md](./threads/threads.spec.md)

Thread-scoped browser runtime logic extracted from `/$budId/$threadId`.

## Notes

- This folder now contains both route-owned runtime hooks and the first extracted pure helper/test seams used by the web package's Node-based test harness.
- Feature modules here should own behavior/state and avoid becoming a second catch-all utility layer.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
