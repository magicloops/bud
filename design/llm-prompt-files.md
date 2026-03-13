# Design: Composable LLM Prompt Files

> **Status**: Draft
> **Created**: 2024-12-19

## Problem Statement

LLM prompts are currently embedded as string literals scattered throughout codebases:
- Hard to read and maintain (escaped characters, concatenation)
- No syntax highlighting or editor support
- Difficult to version, diff, and review
- No reuse mechanism (copy-paste across projects)
- Template logic mixed with application code
- No standardization across tools and frameworks

We need a file format that makes LLM prompts **first-class artifacts** - easy to author, version, compose, and integrate.

---

## Goals

1. **Markdown superset** - Valid markdown renders correctly; prompt features are additive
2. **Simple templating** - Variables, conditionals, loops using familiar syntax
3. **Composable** - Import, extend, and fragment prompts
4. **Editor-friendly** - Syntax highlighting works out of the box (or with minimal config)
5. **Framework-agnostic** - Works with any LLM SDK (OpenAI, Anthropic, etc.)
6. **Zero build step optional** - Can be loaded as raw string if templating not needed
7. **Type-safe** - SDK can validate required variables at compile time

## Non-Goals

- Replacing existing prompt engineering tools (LangChain, etc.)
- Runtime prompt optimization or A/B testing
- Prompt versioning/registry service (orthogonal concern)
- Multi-modal prompts (images, audio) - text-only for v1

---

## Use Cases

### 1. System Prompts
Instructions defining LLM behavior, persona, constraints.

```
You are a helpful coding assistant. You specialize in {{language}}.
Always respond in {{response_format}}.
```

### 2. User Prompt Templates
Structured user input with dynamic content.

```
Analyze the following code for security vulnerabilities:

```{{language}}
{{code}}
```

Focus on: {{focus_areas}}
```

### 3. Few-Shot Examples
Example input/output pairs for in-context learning.

```
## Examples

{{#each examples}}
**Input**: {{this.input}}
**Output**: {{this.output}}

{{/each}}
```

### 4. Multi-Turn Conversations
Structured message sequences.

```
{{#message role="system"}}
You are a helpful assistant.
{{/message}}

{{#message role="user"}}
{{user_query}}
{{/message}}
```

### 5. Conditional Sections
Include content based on context.

```
{{#if include_cot}}
Think step by step before answering.
{{/if}}

{{#if tool_use}}
You have access to the following tools:
{{> tools}}
{{/if}}
```

### 6. Reusable Fragments
Common sections shared across prompts.

```
{{!-- In _fragments/safety.mdp --}}
## Safety Guidelines
- Never generate harmful content
- Refuse illegal requests
- Protect user privacy

{{!-- In main prompt --}}
{{> _fragments/safety}}
```

### 7. Prompt Chains
Prompts that reference outputs of other prompts.

```
{{!-- step-1-analyze.mdp --}}
Analyze the requirements: {{requirements}}

{{!-- step-2-implement.mdp --}}
Based on the analysis:
{{previous_output}}

Now implement the solution.
```

---

## Proposed Design

### File Extension: `.prompt.md`

**Rationale**:
- Double extension preserves markdown tooling (syntax highlighting, preview)
- `.prompt` suffix signals templating capability
- No new file type registration needed in most editors
- Alternative: `.mdp` (Markdown Prompt) - shorter but needs editor config

### Template Syntax: Handlebars-Compatible

Handlebars syntax chosen because:
- Well-known, widely adopted
- Tools exist for parsing (handlebars, mustache libraries)
- `{{}}` rarely conflicts with markdown content
- Renders as visible text in plain markdown (not hidden)
- Supports variables, conditionals, loops, partials

**Core Syntax**:

| Syntax | Purpose | Example |
|--------|---------|---------|
| `{{variable}}` | Variable interpolation | `Hello, {{name}}` |
| `{{#if cond}}...{{/if}}` | Conditional | `{{#if verbose}}Details...{{/if}}` |
| `{{#each items}}...{{/each}}` | Loop | `{{#each tools}}{{this.name}}{{/each}}` |
| `{{> partial}}` | Include/partial | `{{> _fragments/safety}}` |
| `{{!-- comment --}}` | Comment (not rendered) | `{{!-- TODO: improve --}}` |
| `{{{raw}}}` | Unescaped (no HTML escape) | `{{{code_block}}}` |

### Frontmatter for Metadata

YAML frontmatter defines prompt metadata:

```yaml
---
name: coding-assistant
version: 1.0.0
description: System prompt for code analysis

# Required variables (SDK validates these)
requires:
  - language: string
  - code: string

# Optional variables with defaults
optional:
  response_format:
    type: string
    default: markdown
  include_examples:
    type: boolean
    default: true

# Composition
extends: _base/assistant.prompt.md
partials:
  - _fragments/safety.prompt.md
  - _fragments/tools.prompt.md

# LLM hints (informational, not enforced)
hints:
  model: claude-3-opus
  max_tokens: 4096
  temperature: 0.7
---
```

### File Organization

Recommended project structure:

```
prompts/
├── _base/                    # Base prompts for extension
│   └── assistant.prompt.md
├── _fragments/               # Reusable fragments (partials)
│   ├── safety.prompt.md
│   ├── tools.prompt.md
│   └── examples.prompt.md
├── system/                   # System prompts
│   ├── coding.prompt.md
│   ├── writing.prompt.md
│   └── analysis.prompt.md
├── user/                     # User prompt templates
│   ├── code-review.prompt.md
│   └── summarize.prompt.md
└── chains/                   # Multi-step prompt chains
    ├── analyze-then-fix/
    │   ├── 1-analyze.prompt.md
    │   └── 2-fix.prompt.md
    └── ...
```

Convention: Files starting with `_` are not meant to be used directly (base/fragments).

---

## SDK Design

### Core API

```typescript
import { Prompt, loadPrompt, loadPromptSync } from '@prompt/core'

// Load and render
const prompt = await loadPrompt('./prompts/system/coding.prompt.md')
const rendered = prompt.render({
  language: 'TypeScript',
  code: 'function foo() { ... }',
})

// Access metadata
console.log(prompt.name)        // 'coding-assistant'
console.log(prompt.requires)    // ['language', 'code']
console.log(prompt.optional)    // { response_format: { default: 'markdown' } }

// Validation
prompt.validate({ language: 'Python' })  // throws: missing required 'code'

// Type-safe (with codegen)
import { CodingPrompt } from './prompts/generated'
const rendered = CodingPrompt.render({
  language: 'TypeScript',  // autocomplete works
  code: '...',
})
```

### Multi-Message Prompts

For chat-based APIs that need structured messages:

```typescript
const prompt = await loadPrompt('./prompts/chat.prompt.md')
const messages = prompt.renderMessages({
  user_query: 'How do I sort an array?',
})
// Returns: [
//   { role: 'system', content: '...' },
//   { role: 'user', content: 'How do I sort an array?' },
// ]
```

### Framework Integrations

```typescript
// OpenAI
import OpenAI from 'openai'
import { loadPrompt } from '@prompt/core'

const client = new OpenAI()
const systemPrompt = await loadPrompt('./prompts/system.prompt.md')

const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [
    { role: 'system', content: systemPrompt.render({ ... }) },
    { role: 'user', content: userInput },
  ],
})

// Anthropic
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic()

const response = await client.messages.create({
  model: 'claude-3-opus',
  system: systemPrompt.render({ ... }),
  messages: [{ role: 'user', content: userInput }],
})
```

### Bundler Plugins

For direct imports (compile-time loading):

```typescript
// With Vite/Webpack plugin
import codingPrompt from './prompts/coding.prompt.md'

// Type: Prompt<{ language: string; code: string }>
const rendered = codingPrompt.render({
  language: 'TypeScript',
  code: '...',
})
```

Vite plugin example:

```typescript
// vite.config.ts
import { promptPlugin } from '@prompt/vite'

export default {
  plugins: [promptPlugin()],
}
```

### CLI Tool

```bash
# Render a prompt with variables
prompt render ./prompts/coding.prompt.md \
  --var language=TypeScript \
  --var code="$(cat file.ts)"

# Validate prompt file
prompt validate ./prompts/coding.prompt.md

# Generate TypeScript types
prompt codegen ./prompts --out ./prompts/generated.ts

# List all prompts
prompt list ./prompts

# Check for unused variables
prompt lint ./prompts
```

---

## Message Block Syntax

For multi-message prompts, use a special block syntax:

```markdown
---
name: chat-assistant
---

{{#message role="system"}}
You are a helpful assistant specialized in {{domain}}.
{{/message}}

{{#message role="user"}}
{{user_query}}
{{/message}}

{{#message role="assistant"}}
I'll help you with that. Let me think...
{{/message}}

{{#message role="user"}}
{{followup_query}}
{{/message}}
```

The `{{#message}}` block is a custom Handlebars helper that:
1. Marks message boundaries
2. Specifies the role
3. Enables `.renderMessages()` to return structured array

---

## Inheritance and Extension

### Base Prompts

```markdown
{{!-- _base/assistant.prompt.md --}}
---
name: base-assistant
requires:
  - task_context
---

# Role
You are a helpful AI assistant.

# Guidelines
{{> _fragments/safety}}

# Task
{{task_context}}

{{#block "instructions"}}
Provide clear and concise responses.
{{/block}}
```

### Extended Prompts

```markdown
{{!-- system/coding.prompt.md --}}
---
name: coding-assistant
extends: _base/assistant.prompt.md
requires:
  - language
  - code
---

{{#block "instructions"}}
You are reviewing {{language}} code.
Be specific about line numbers.
Always suggest improvements.
{{/block}}
```

The `extends` mechanism:
1. Loads base prompt
2. Merges `requires` and `optional`
3. Allows overriding named `{{#block}}` sections
4. Child can append to or replace parent blocks

---

## Escaping and Raw Content

### Escaping Template Syntax

When you need literal `{{`:

```markdown
To write a Handlebars template, use \{{variable}}.
```

Or use raw blocks:

```markdown
{{{{raw}}}}
This {{will not}} be interpolated.
{{{{/raw}}}}
```

### Code Blocks with Templates

Template syntax inside fenced code blocks is processed by default:

~~~markdown
```python
def greet(name):
    return f"Hello, {{name}}!"  # This {{name}} IS interpolated
```
~~~

To prevent interpolation in code blocks, use raw:

~~~markdown
```python
{{{{raw}}}}
def greet(name):
    return f"Hello, {name}!"  # Literal, not interpolated
{{{{/raw}}}}
```
~~~

---

## Type Generation

The SDK can generate TypeScript types from prompt files:

```typescript
// prompts/generated.ts (auto-generated)
import { Prompt } from '@prompt/core'

export interface CodingPromptVars {
  language: string
  code: string
  response_format?: string  // optional with default
  include_examples?: boolean
}

export const CodingPrompt: Prompt<CodingPromptVars>

export interface WritingPromptVars {
  topic: string
  style: 'formal' | 'casual' | 'technical'
  length: number
}

export const WritingPrompt: Prompt<WritingPromptVars>
```

Usage:

```typescript
import { CodingPrompt } from './prompts/generated'

// Type error: missing 'code'
CodingPrompt.render({ language: 'TypeScript' })

// Type error: 'language' must be string
CodingPrompt.render({ language: 123, code: '...' })

// OK
CodingPrompt.render({
  language: 'TypeScript',
  code: 'const x = 1',
  include_examples: false,
})
```

---

## Alternatives Considered

### 1. Custom DSL (Rejected)

Could create a completely new language:

```
@prompt coding-assistant
@require language: string
@require code: string

You are a coding assistant for {language}.
```

**Rejected because**:
- Requires custom parser, highlighting, tooling
- Learning curve for new syntax
- Loses markdown ecosystem benefits

### 2. JSX-style Syntax (Rejected)

```jsx
<Prompt name="coding">
  <System>You are a coding assistant for {language}.</System>
  <User>{user_query}</User>
</Prompt>
```

**Rejected because**:
- Ties to JSX ecosystem
- Requires JSX parser
- Less readable for non-developers

### 3. Pure YAML/JSON (Rejected)

```yaml
name: coding-assistant
system: |
  You are a coding assistant for ${language}.
user: ${user_query}
```

**Rejected because**:
- Poor for long-form text content
- Escaping/quoting issues
- No markdown formatting

### 4. Python f-string Style (Rejected)

```markdown
You are a coding assistant for {language}.
Analyze this code: {code}
```

**Rejected because**:
- Single braces conflict with JSON, code samples
- No conditional/loop support without adding more syntax

### 5. Jinja2 (Considered)

```markdown
You are a coding assistant for {{ language }}.
{% if verbose %}
Provide detailed explanations.
{% endif %}
```

**Considered but Handlebars preferred because**:
- Handlebars is simpler (no arbitrary Python expressions)
- Handlebars has better JS ecosystem support
- Jinja2 syntax (`{% %}`) more visually intrusive

---

## Implementation Plan

### Phase 1: Core Library
- [ ] Handlebars parser with frontmatter support
- [ ] Variable validation
- [ ] Partial/include resolution
- [ ] `.render()` and `.renderMessages()` methods

### Phase 2: CLI Tool
- [ ] `prompt render` command
- [ ] `prompt validate` command
- [ ] `prompt codegen` for TypeScript types

### Phase 3: Editor Support
- [ ] VS Code extension (syntax highlighting, variable autocomplete)
- [ ] Language server for validation

### Phase 4: Framework Integrations
- [ ] Vite plugin
- [ ] Webpack plugin
- [ ] Next.js integration

---

## Examples

### Simple System Prompt

```markdown
---
name: summarizer
requires:
  - text
optional:
  max_length:
    type: number
    default: 100
---

Summarize the following text in {{max_length}} words or fewer:

{{text}}
```

### Code Review Prompt

```markdown
---
name: code-review
requires:
  - code
  - language
optional:
  focus:
    type: array
    default: ["bugs", "security", "performance"]
---

Review the following {{language}} code:

```{{language}}
{{code}}
```

{{#if focus}}
Focus on:
{{#each focus}}
- {{this}}
{{/each}}
{{/if}}

Provide specific line-by-line feedback.
```

### Multi-Message Chat

```markdown
---
name: coding-tutor
requires:
  - topic
  - student_level
---

{{#message role="system"}}
You are a coding tutor teaching {{topic}}.
Adjust your explanations for a {{student_level}} level student.
Use simple analogies and examples.
{{/message}}

{{#message role="user"}}
Can you explain {{topic}} to me?
{{/message}}
```

### Prompt with Inheritance

```markdown
{{!-- _base/careful-assistant.prompt.md --}}
---
name: careful-assistant
---

{{> _fragments/safety}}

{{#block "task"}}
Help the user with their request.
{{/block}}

Always double-check your work before responding.
```

```markdown
{{!-- system/math-tutor.prompt.md --}}
---
name: math-tutor
extends: _base/careful-assistant.prompt.md
requires:
  - math_topic
---

{{#block "task"}}
You are a math tutor specializing in {{math_topic}}.
Use step-by-step explanations.
Show your work for all calculations.
{{/block}}
```

---

## Open Questions

1. **Extension choice**: `.prompt.md` vs `.mdp` vs `.prompt`?
   - `.prompt.md` preserves tooling, `.mdp` is cleaner

2. **Default escaping**: Should variables be HTML-escaped by default?
   - For LLM prompts, probably not (unlike web templates)

3. **Async partials**: Should partials support async loading?
   - Needed for dynamic content, complicates implementation

4. **Caching**: Should rendered prompts be cached?
   - Helpful for performance, risk of stale data

5. **Prompt registry**: Should there be a central registry/package manager?
   - Community sharing vs. local-first

---

*Last updated: 2024-12-19*
