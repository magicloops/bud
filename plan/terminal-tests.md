# Plan: Terminal Feature Test Suite

## Context
- Related docs: `/docs/terminal-testing.md` (test strategy), `/PROGRESS.md` (phase status)
- The Persistent Terminal feature (Phases 1–5) is fully implemented but lacks automated tests
- Existing test infrastructure: Node's built-in `node:test` runner (see `session-manager.test.ts`), Rust's built-in test framework

## Objective
Create comprehensive automated tests for the terminal feature across all layers:
- **Bud (Rust)**: Unit tests for readiness detection, tmux interactions
- **Backend (TypeScript)**: Unit tests for TerminalManager, agent tools; integration tests with mock Bud
- **Frontend (React)**: Component tests for terminal UI, SSE handling

### Acceptance Criteria
- [ ] All new test files pass in CI
- [ ] Coverage targets met: 80% TerminalManager, 90% agent tools, 90% readiness detector
- [ ] Integration tests cover critical end-to-end flows
- [ ] Test fixtures reusable across test suites

---

## Design / Approach

### Phase 1: Test Infrastructure Setup

**1.1 Backend Test Runner**
- Current: `tsx src/runtime/session-manager.test.ts` (single file, manual)
- Target: Use `node:test` with glob pattern for all `*.test.ts` files
- Changes to `package.json`:
  ```json
  {
    "scripts": {
      "test": "node --import tsx --test 'src/**/*.test.ts'",
      "test:unit": "node --import tsx --test 'src/**/*.test.ts' --test-name-pattern='unit:'",
      "test:integration": "node --import tsx --test 'src/**/*.test.ts' --test-name-pattern='integration:'"
    }
  }
  ```

**1.2 Frontend Test Runner**
- Add Vitest (Vite-native, fast, good React support)
- Changes to `web/package.json`:
  ```json
  {
    "scripts": {
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "devDependencies": {
      "vitest": "^2.0.0",
      "@testing-library/react": "^16.0.0",
      "@testing-library/jest-dom": "^6.0.0",
      "jsdom": "^25.0.0"
    }
  }
  ```

**1.3 Rust Test Organization**
- Current: No terminal-specific tests
- Target: Add `#[cfg(test)]` modules in terminal-related code
- No new dependencies needed (Rust has built-in test framework)

---

### Phase 2: Backend Unit Tests

**2.1 TerminalManager Tests**
File: `service/src/runtime/__tests__/terminal-manager.test.ts`

| Test Name | Description |
|-----------|-------------|
| `unit: ensureTerminal creates DB row and dispatches frame` | Mock DB, verify insert called, verify frame sent to gateway |
| `unit: ensureTerminal returns existing terminal` | When terminal exists, returns cached data without creating |
| `unit: sendInput validates budId exists` | Returns error for unknown budId |
| `unit: sendInput creates frame and records input` | Mock gateway, verify frame shape, verify DB insert |
| `unit: sendInterrupt sends Ctrl+C frame` | Verify frame type and payload |
| `unit: handleTerminalOutput stores to DB and emits SSE` | Mock DB insert, verify SSE event shape |
| `unit: handleTerminalReady caches assessment and emits SSE` | Verify cache update, verify SSE event |
| `unit: waitForReadiness resolves on ready` | Mock cache with ready state, verify immediate resolution |
| `unit: waitForReadiness times out` | Mock cache never ready, verify timeout error |
| `unit: tailOutput returns most recent bytes` | Mock DB query, verify byte limit and ordering |
| `unit: markIdleTerminals transitions ready→idle` | Mock DB update, verify state transition |
| `unit: closeStaleIdleTerminals sends close frame` | Verify frame sent, DB updated |
| `unit: fetchMetrics returns correct counts` | Mock DB aggregates, verify response shape |
| `unit: fetchAggregateMetrics aggregates across terminals` | Verify sum/count/avg calculations |

**Test Helpers Needed:**
```typescript
// service/src/__tests__/helpers/mock-gateway.ts
export const createMockGateway = () => ({
  dispatchToBud: jest.fn(),
  // ...
});

// service/src/__tests__/helpers/mock-db.ts
export const createMockDb = () => ({
  insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: async () => [] }) }),
  // ...
});

// service/src/__tests__/helpers/mock-event-bus.ts
export const createMockEventBus = () => {
  const events: Array<{ channel: string; event: unknown }> = [];
  return {
    events,
    emit: (channel: string, event: unknown) => events.push({ channel, event }),
  };
};
```

**2.2 Agent Terminal Tools Tests**
File: `service/src/agent/__tests__/terminal-tools.test.ts`

| Test Name | Description |
|-----------|-------------|
| `unit: stripAnsi removes CSI sequences` | Test `\x1b[31mred\x1b[0m` → `red` |
| `unit: stripAnsi removes OSC sequences` | Test `\x1b]0;title\x07` → `` |
| `unit: stripAnsi removes simple escapes` | Test `\x1bM` → `` |
| `unit: stripAnsi preserves plain text` | Test `hello world` unchanged |
| `unit: normalizeCRLF converts CRLF to LF` | Test `line1\r\nline2` → `line1\nline2` |
| `unit: normalizeCRLF converts lone CR to LF` | Test `line1\rline2` → `line1\nline2` |
| `unit: decodeTail detects binary content` | Test with null bytes, verify placeholder |
| `unit: decodeTail applies ANSI stripping` | Verify stripAnsi called on output |
| `unit: normalizeReadiness provides defaults` | Test with missing hints, verify all fields present |
| `unit: normalizeReadiness preserves existing hints` | Test with partial hints, verify merge |
| `unit: terminal.run sends input and waits for readiness` | Mock TerminalManager, verify flow |
| `unit: terminal.observe waits without sending input` | Verify no sendInput called |
| `unit: terminal.interrupt sends interrupt signal` | Verify sendInterrupt called |

**Test Fixtures:**
```typescript
// service/src/__tests__/fixtures/ansi-samples.ts
export const ANSI_SAMPLES = {
  coloredText: '\x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m',
  cursorMove: '\x1b[2J\x1b[H',
  oscTitle: '\x1b]0;Terminal Title\x07',
  mixed: '\x1b[1;32m➜\x1b[0m \x1b[36m~/code\x1b[0m git:(\x1b[31mmain\x1b[0m)',
};

// service/src/__tests__/fixtures/readiness-samples.ts
export const READINESS_SAMPLES = {
  shellReady: {
    ready: true,
    confidence: 0.95,
    trigger: 'prompt_detected',
    hints: { looks_like_prompt: true },
  },
  waitingForPassword: {
    ready: true,
    confidence: 0.9,
    trigger: 'prompt_detected',
    hints: { looks_like_password: true },
  },
  // ...
};
```

---

### Phase 3: Backend Integration Tests

**3.1 Mock Bud Client**
File: `service/src/__tests__/helpers/mock-bud.ts`

```typescript
export class MockBud {
  private ws: WebSocket | null = null;
  private handlers: Map<string, (payload: unknown) => void> = new Map();

  async connect(url: string): Promise<void>;
  async sendHello(capabilities: object): Promise<void>;
  async sendTerminalStatus(state: string): Promise<void>;
  async sendTerminalOutput(data: string, seq: number): Promise<void>;
  async sendTerminalReady(assessment: object): Promise<void>;

  onFrame(type: string, handler: (payload: unknown) => void): void;
  disconnect(): void;
}
```

**3.2 Integration Test Suite**
File: `service/src/__tests__/integration/terminal.test.ts`

| Test Name | Description |
|-----------|-------------|
| `integration: ensure → input → output → ready flow` | Full happy path with mock Bud |
| `integration: interrupt stops running command` | Send interrupt, verify Bud receives, mock ready response |
| `integration: reconnect restores terminal state` | Disconnect/reconnect mock Bud, verify state preserved |
| `integration: idle terminal marked after threshold` | Fast-forward time, verify state transition |
| `integration: stale idle terminal closed` | Fast-forward beyond cleanup threshold, verify close sent |
| `integration: SSE events emitted for output` | Connect SSE client, verify events received |
| `integration: SSE events emitted for readiness` | Verify readiness events on SSE channel |
| `integration: history endpoint returns buffered output` | Send output, call history, verify data |

**Test Setup:**
```typescript
// service/src/__tests__/integration/setup.ts
export async function setupIntegrationTest() {
  // Start minimal Fastify server
  // Configure test database (in-memory or test schema)
  // Return server instance and cleanup function
}
```

---

### Phase 4: Bud (Rust) Unit Tests

**4.1 Readiness Detector Tests**
File: `bud/src/terminal/readiness.rs` (add `#[cfg(test)]` module)

| Test Name | Description |
|-----------|-------------|
| `test_prompt_pattern_bash` | `user@host:~$ ` → prompt detected |
| `test_prompt_pattern_zsh` | `➜ ~/code ` → prompt detected |
| `test_prompt_pattern_python` | `>>> ` → prompt detected |
| `test_prompt_pattern_ipython` | `In [1]: ` → prompt detected |
| `test_prompt_pattern_node` | `> ` at line start → prompt detected |
| `test_no_prompt_mid_output` | `$100` in text → not a prompt |
| `test_password_hint` | `Password: ` → `looks_like_password: true` |
| `test_confirmation_hint` | `(y/n)? ` → `looks_like_confirmation: true` |
| `test_pager_hint` | `(END)` or `: ` at end → `looks_like_pager: true` |
| `test_quiescence_triggers_ready` | No output for 300ms → ready with low confidence |
| `test_prompt_beats_quiescence` | Prompt detected before timeout → higher confidence |
| `test_confidence_thresholds` | Verify 0.95 for prompt, 0.6 for quiescence |

**Test Fixtures:**
```rust
// bud/src/terminal/test_fixtures.rs
pub const SHELL_PROMPTS: &[&str] = &[
    "$ ",
    "user@host:~$ ",
    "[user@host ~]$ ",
    "bash-5.1$ ",
    "% ",
    "➜ ",
    "➜  ~/code git:(main) ",
];

pub const PYTHON_PROMPTS: &[&str] = &[
    ">>> ",
    "... ",
    "In [1]: ",
    "ipdb> ",
];

pub const PASSWORD_PROMPTS: &[&str] = &[
    "Password: ",
    "Enter passphrase: ",
    "[sudo] password for user: ",
];
```

**4.2 tmux Interaction Tests**
File: `bud/src/terminal/tmux.rs` (add `#[cfg(test)]` module)

| Test Name | Description |
|-----------|-------------|
| `test_tmux_version_parse` | Parse `tmux 3.4` → version struct |
| `test_session_name_generation` | Verify deterministic session naming |
| `test_pipe_pane_command_format` | Verify correct pipe-pane command construction |

Note: Full tmux integration requires real tmux binary; these tests focus on command construction and parsing.

---

### Phase 5: Frontend Tests

**5.1 Test Setup**
File: `web/vitest.config.ts`
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    globals: true,
  },
});
```

File: `web/src/__tests__/setup.ts`
```typescript
import '@testing-library/jest-dom';

// Mock EventSource
class MockEventSource {
  // ...implementation
}
global.EventSource = MockEventSource as any;
```

**5.2 Terminal Component Tests**
File: `web/src/__tests__/terminal.test.tsx`

| Test Name | Description |
|-----------|-------------|
| `renders terminal panel when budId set` | Verify xterm container present |
| `connects SSE on mount` | Verify EventSource created with correct URL |
| `handles terminal.output event` | Mock SSE event, verify xterm.write called |
| `handles terminal.ready event` | Mock SSE event, verify readiness state updated |
| `shows reconnecting overlay on disconnect` | Set connection state, verify overlay visible |
| `input box sends command on Enter` | Type + Enter, verify POST called |
| `input box clears after send` | After submit, verify input empty |
| `interrupt button calls POST /interrupt` | Click button, verify fetch called |
| `interrupt button disabled when disconnected` | Set disconnected, verify button disabled |
| `readiness indicator shows correct state` | Test ready/waiting/processing states |
| `readiness hints show correct icons` | Test password/confirmation/pager hints |
| `truncation warning appears when applicable` | Set truncated state, verify banner visible |
| `truncation warning dismissible` | Click X, verify banner hidden |

**Mock Helpers:**
```typescript
// web/src/__tests__/helpers/mock-sse.ts
export class MockEventSource {
  private handlers: Map<string, (event: MessageEvent) => void> = new Map();

  addEventListener(type: string, handler: (event: MessageEvent) => void): void {
    this.handlers.set(type, handler);
  }

  simulateEvent(type: string, data: unknown): void {
    const handler = this.handlers.get(type);
    if (handler) {
      handler(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }

  close(): void {}
}

// web/src/__tests__/helpers/mock-xterm.ts
export const createMockTerminal = () => ({
  write: vi.fn(),
  clear: vi.fn(),
  open: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn(),
});
```

---

## Impacted Contracts

- [ ] WSS protocol — Tests will verify frame shapes match `/docs/proto.md`
- [ ] SSE events — Tests will verify event names and payloads
- [ ] DB schema — Integration tests may need test fixtures
- [ ] Agent adapter/tool registry — Terminal tools tested in isolation
- [ ] Web UI surfaces — Component tests verify UI behavior

---

## Test Plan (meta)

### Running Tests

```bash
# Backend unit tests
cd service && npm test

# Backend integration tests (requires test DB)
cd service && npm run test:integration

# Rust tests
cd bud && cargo test

# Frontend tests
cd web && npm test
```

### CI Integration

```yaml
# .github/workflows/test.yml
jobs:
  test-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: cd service && npm ci && npm test

  test-bud:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cd bud && cargo test

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: cd web && npm ci && npm test
```

---

## Rollout

### Implementation Order

1. **Phase 1: Infrastructure** — Set up test runners, add dependencies
2. **Phase 2: Backend Unit Tests** — TerminalManager + agent tools
3. **Phase 3: Backend Integration** — Mock Bud client + E2E flows
4. **Phase 4: Bud Tests** — Readiness detector + tmux parsing
5. **Phase 5: Frontend Tests** — Terminal component + SSE handling

### Docs to Update

- [ ] `service/README.md` — Add test commands
- [ ] `web/README.md` — Add test commands
- [ ] `bud/README.md` — Add test commands
- [ ] `/docs/terminal-testing.md` — Update with implementation details

---

## Out of Scope

- E2E tests with real tmux in CI (requires tmux installation, complex setup)
- Load/stress testing for high-volume output
- Chaos testing (network partitions, process kills)
- Visual regression testing for terminal rendering
- Performance benchmarks

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Mock Bud diverges from real Bud | Keep MockBud minimal, focus on protocol compliance |
| xterm.js hard to test | Mock Terminal class, test state changes not rendering |
| Flaky async tests | Use proper async utilities, avoid arbitrary timeouts |
| Test DB setup complexity | Use in-memory mocks for unit tests, real DB only for integration |

---

## Open Questions

1. **Test DB strategy**: Should integration tests use a separate test schema, in-memory SQLite, or mock the entire DB layer?
2. **SSE testing**: Should we test actual EventSource behavior or mock it entirely?
3. **Coverage tooling**: Do we want to add c8/istanbul for backend coverage reports?

---

## Follow-on / Future Work

These items are out of scope for the current test implementation but should be addressed in future iterations:

| Item | Description | Priority |
|------|-------------|----------|
| **Terminal history pagination** | Currently fetches 128KB max; add pagination to retrieve older history on scroll-up. Requires S3-backed storage for large histories. | Medium |
| **S3 log offload** | Move terminal output storage to S3 for long-lived sessions; DB stores only recent buffer + S3 pointers. | Medium |
| **Terminal resize handling** | Send resize events to Bud when terminal dimensions change; currently uses fixed/fit dimensions. | Low |
| **Multi-terminal support** | Allow multiple terminal sessions per Bud (e.g., separate terminals for different tasks). | Low |
| **Terminal sharing** | Allow multiple users to view/interact with same terminal session. | Low |
