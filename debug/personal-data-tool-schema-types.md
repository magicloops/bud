# Debug: personal-data tool schema inference

`pnpm build` from `service/` reported `TS2322` at `personal-data-tools.ts` lines 15, 17, 19 and 21: shared property fragments inferred `type: string`, incompatible with JSON Schema's literal type vocabulary. Preserve the `page` and `time` fragment literals with `as const`, then rerun compilation and tool integration checks. This is a TypeScript inference correction, not a wire change.
