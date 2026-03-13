# Design: Prompt Management System

## Context

Currently, all prompts in Bud are hardcoded as TypeScript string constants:

| Prompt | Location | Lines |
|--------|----------|-------|
| `SYSTEM_PROMPT` | `service/src/agent/agent-service.ts:55-118` | ~63 |
| `CANONICAL_TOOLS` descriptions | `service/src/agent/agent-service.ts:133-191` | ~58 |
| Context sync prompt | `service/src/terminal/context-sync-service.ts` | ~15 |

**Problems with current approach:**

1. **Poor editability**: Prompts buried in TypeScript code; hard to read and modify
2. **No separation of concerns**: Prompt content mixed with execution logic
3. **Difficult review**: Changes to prompts show as code changes in PRs
4. **No versioning/history**: Prompt changes are just git commits to `.ts` files
5. **No composition**: Cannot reuse prompt fragments across different contexts
6. **Tool coupling**: Tool descriptions live with execution code, not prompt content

## Goals

- Prompts should be easy to read, edit, and review
- Clear separation between prompt content and application code
- Support for prompt composition (shared fragments)
- Type safety preserved (prompts validated at build/startup)
- Minimal runtime overhead

## Non-Goals (for now)

- Runtime prompt editing without deploys
- A/B testing infrastructure
- Multi-tenant prompt customization
- Prompt analytics/evaluation frameworks

---

## Option 1: Simple Markdown Files

**Approach**: Each prompt lives in a dedicated `.md` file, loaded at startup.

```
service/
└── prompts/
    ├── agent-system.md         # Main agent system prompt
    ├── tools/
    │   ├── terminal-run.md     # Tool description for terminal.run
    │   ├── terminal-capture.md
    │   └── terminal-interrupt.md
    └── context-sync.md         # Context sync summarization prompt
```

**Implementation**:

```typescript
// service/src/prompts/loader.ts
import { readFileSync } from 'fs';
import { join } from 'path';

const PROMPTS_DIR = join(__dirname, '../../prompts');

export const prompts = {
  agentSystem: readFileSync(join(PROMPTS_DIR, 'agent-system.md'), 'utf-8'),
  tools: {
    terminalRun: readFileSync(join(PROMPTS_DIR, 'tools/terminal-run.md'), 'utf-8'),
    // ...
  },
} as const;
```

**Pros**:
- Dead simple to implement
- Prompts are readable, diffable, reviewable as markdown
- No new dependencies
- Works with existing tooling (editors, linters, spellcheck)

**Cons**:
- No metadata support (model requirements, version info)
- No composition/templating
- Runtime file reads (though cached at startup)
- No validation that prompts are complete/correct

---

## Option 2: Markdown with YAML Front Matter

**Approach**: Markdown files with structured metadata in YAML front matter.

```
service/
└── prompts/
    ├── agent-system.prompt.md
    ├── tools/
    │   ├── terminal-run.prompt.md
    │   └── ...
    └── context-sync.prompt.md
```

**File format**:

```markdown
---
id: agent-system
version: 1.2.0
description: Main system prompt for Bud Agent
requires:
  - tool_use
  - json_mode
models:
  preferred: [claude-opus-4-5, gpt-5.2]
  minimum_context: 32000
tags: [agent, terminal, core]
---

You are Bud Agent, coordinating terminal access to a user's machine...
```

**Implementation**:

```typescript
// service/src/prompts/loader.ts
import matter from 'gray-matter';

interface PromptMeta {
  id: string;
  version: string;
  description: string;
  requires?: string[];
  models?: { preferred?: string[]; minimum_context?: number };
  tags?: string[];
}

interface LoadedPrompt {
  meta: PromptMeta;
  content: string;
}

export function loadPrompt(path: string): LoadedPrompt {
  const raw = readFileSync(path, 'utf-8');
  const { data, content } = matter(raw);
  return { meta: data as PromptMeta, content: content.trim() };
}
```

**Pros**:
- All benefits of Option 1
- Structured metadata for tooling/validation
- Version tracking built-in
- Can validate model requirements at startup
- Tags enable organization and search

**Cons**:
- Adds `gray-matter` dependency
- Slightly more complex loader
- Metadata schema needs definition and validation

---

## Option 3: Composable Prompt Fragments

**Approach**: Break prompts into reusable fragments that compose into full prompts.

```
service/
└── prompts/
    ├── fragments/
    │   ├── identity.md           # "You are Bud Agent..."
    │   ├── json-output.md        # JSON formatting requirements
    │   ├── readiness-hints.md    # How to interpret readiness
    │   ├── repl-awareness.md     # REPL context behavior
    │   └── tool-calling.md       # Tool calling guidelines
    ├── tools/
    │   ├── terminal-run.md
    │   └── ...
    ├── agent-system.prompt.yaml  # Composition manifest
    └── context-sync.prompt.yaml
```

**Composition manifest** (`agent-system.prompt.yaml`):

```yaml
id: agent-system
version: 1.2.0

compose:
  - fragments/identity.md
  - fragments/tool-calling.md
  - section: "## Readiness Detection"
    include: fragments/readiness-hints.md
  - section: "## REPL Awareness"
    include: fragments/repl-awareness.md
  - fragments/json-output.md

variables:
  max_output_lines: 500
  default_timeout_ms: 30000
```

**Implementation**:

```typescript
interface CompositionManifest {
  id: string;
  version: string;
  compose: Array<string | { section: string; include: string }>;
  variables?: Record<string, unknown>;
}

export function composePrompt(manifestPath: string): string {
  const manifest = yaml.load(readFileSync(manifestPath, 'utf-8')) as CompositionManifest;

  let result = '';
  for (const item of manifest.compose) {
    if (typeof item === 'string') {
      result += readFragment(item) + '\n\n';
    } else {
      result += `${item.section}\n\n${readFragment(item.include)}\n\n`;
    }
  }

  // Variable substitution
  for (const [key, value] of Object.entries(manifest.variables ?? {})) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
  }

  return result.trim();
}
```

**Pros**:
- DRY: Shared fragments across prompts
- Easier to update common patterns globally
- Section headers make structure explicit
- Variables enable configuration without code changes
- Each fragment is small and focused

**Cons**:
- More complex mental model
- Harder to see the "final" prompt
- Fragment ordering matters
- Need tooling to preview composed result
- Overkill if we only have 2-3 prompts

---

## Option 4: Prompt Registry with Build-Time Compilation

**Approach**: Prompts compile to TypeScript at build time, providing type safety and IDE support.

```
service/
├── prompts/
│   └── (same structure as Option 2 or 3)
├── src/
│   └── generated/
│       └── prompts.ts  # Auto-generated, gitignored
└── scripts/
    └── compile-prompts.ts
```

**Build step** (`compile-prompts.ts`):

```typescript
// Reads all .prompt.md files, validates, generates TypeScript

const output = `
// AUTO-GENERATED - DO NOT EDIT
// Generated from prompts/ at ${new Date().toISOString()}

export const PROMPTS = {
  agentSystem: {
    id: "agent-system",
    version: "1.2.0",
    content: \`${escapeTemplate(content)}\`,
  },
  // ...
} as const;

export type PromptId = keyof typeof PROMPTS;
`;

writeFileSync('src/generated/prompts.ts', output);
```

**Usage**:

```typescript
import { PROMPTS } from './generated/prompts';

// Full type safety, IDE autocomplete
const systemPrompt = PROMPTS.agentSystem.content;
```

**Pros**:
- Full type safety and IDE support
- Validation happens at build time, not runtime
- No runtime file I/O
- Prompts still authored in markdown
- Can integrate with existing build pipeline

**Cons**:
- Requires build step (already have one for TypeScript)
- Generated file adds complexity
- Must regenerate on prompt changes during dev
- Slightly more complex setup

---

## Comparison Matrix

| Criterion | Option 1 | Option 2 | Option 3 | Option 4 |
|-----------|----------|----------|----------|----------|
| Implementation effort | Low | Low-Medium | Medium-High | Medium |
| Editability | Good | Good | Good | Good |
| Reviewability | Good | Good | Medium | Good |
| Type safety | None | Schema | Schema | Full |
| Composition | None | None | Full | Possible |
| Metadata support | None | Full | Full | Full |
| Runtime overhead | Minimal | Minimal | Low | None |
| Dependencies | None | gray-matter | gray-matter, yaml | None (build) |
| Complexity | Very low | Low | Medium | Medium |

---

## Recommendation

**Start with Option 2** (Markdown + YAML front matter).

**Rationale**:

1. **Right-sized**: Matches our current needs (3-4 prompts) without overengineering
2. **Clear upgrade path**: Can evolve to Option 3 (fragments) or Option 4 (compiled) later
3. **Immediate wins**: Prompts become readable, reviewable, and separated from code
4. **Metadata foundation**: Front matter enables future tooling (validation, model compatibility checks)
5. **Minimal friction**: `gray-matter` is a small, stable dependency

**Migration path**:

1. Create `service/prompts/` directory
2. Extract `SYSTEM_PROMPT` to `agent-system.prompt.md`
3. Extract tool descriptions to `tools/*.prompt.md`
4. Extract context sync prompt to `context-sync.prompt.md`
5. Add prompt loader with caching
6. Update agent-service.ts to use loaded prompts
7. Add startup validation (prompts exist, valid YAML, etc.)

**Future evolution**:

- If prompts grow complex → adopt Option 3 fragments
- If type safety becomes critical → add Option 4 compilation
- If runtime flexibility needed → add database-backed registry

---

## Open Questions

1. **Should tool schemas live with tool descriptions?** The JSON schemas for tools (parameters, required fields) could live alongside the description markdown, or remain in TypeScript for type safety.

2. **Hot reloading in development?** Should prompts reload on file change during `pnpm dev`?

3. **Version tracking integration?** Should prompt versions appear in agent responses or logs for debugging?

4. **Validation depth?** What should we validate at startup - just file existence, or also content structure (headings, required sections)?

---

*Created: 2024-12-19*
