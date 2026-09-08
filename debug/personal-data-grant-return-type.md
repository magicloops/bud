# Debug: missing-grant timestamp type

`pnpm build` from `service/` failed while compiling the new agent query fixture:
```
src/personal-data/agent-queries.test.ts(22,70): error TS2345
Type 'null' is not assignable to type 'Date'.
```

`DataGrants.get` returns null for an absent grant, but inferred array indexing treated the selected row as always present and narrowed the public return type incorrectly. Declare the response contract explicitly with `updated_at: Date | null`, matching the existing wire behavior. Then rerun the build and focused tests.
