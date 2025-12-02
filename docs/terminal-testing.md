# Terminal Testing Guide

This document describes the test strategy for the persistent terminal feature (Phases 1–5).

---

## 1. Unit Tests

### 1.1 Bud (Rust)

**File:** `bud/src/terminal/` (or inline in `main.rs`)

| Component | Test Cases |
|-----------|-----------|
| tmux probe | `test_tmux_available()` — mock PATH, verify version parsing |
| tmux session | `test_ensure_session_creates_new()`, `test_ensure_session_adopts_existing()` |
| pipe-pane | `test_pipe_pane_starts_watcher()`, `test_pipe_pane_restarts_on_reconnect()` |
| readiness detector | `test_prompt_patterns_shell()`, `test_prompt_patterns_python()`, `test_prompt_patterns_node()` |
| quiescence | `test_quiescence_after_300ms_no_output()` |
| hints | `test_hints_password_prompt()`, `test_hints_confirmation()`, `test_hints_pager()` |

**Mocking strategy:**
- Mock `Command` execution for tmux probes
- Use in-memory buffers for pipe-pane output
- Time mocking for quiescence detection

### 1.2 Backend (TypeScript)

**File:** `service/src/runtime/__tests__/terminal-manager.test.ts`

| Component | Test Cases |
|-----------|-----------|
| TerminalManager | `ensureTerminal()` creates DB row and dispatches frame |
| | `sendInput()` validates budId, creates frame, records input |
| | `sendInterrupt()` sends Ctrl+C frame |
| | `handleTerminalOutput()` stores to DB, emits SSE |
| | `handleTerminalReady()` caches assessment, emits SSE |
| | `waitForReadiness()` polls cache with timeout |
| | `tailOutput()` returns most recent bytes from DB |
| Idle management | `markIdleTerminals()` transitions ready→idle after threshold |
| | `closeStaleIdleTerminals()` sends close and updates DB |
| Metrics | `fetchMetrics()` returns correct byte counts |
| | `fetchAggregateMetrics()` aggregates across terminals |

**File:** `service/src/agent/__tests__/terminal-tools.test.ts`

| Component | Test Cases |
|-----------|-----------|
| terminal.run | Sends input, waits for readiness, returns output |
| terminal.observe | Waits for readiness without sending input |
| terminal.interrupt | Sends interrupt, waits for readiness |
| ANSI stripping | `stripAnsi()` removes CSI, OSC, simple escapes |
| CRLF normalization | `normalizeCRLF()` converts to LF |
| Binary detection | `decodeTail()` returns placeholder for binary |
| Fallback readiness | `normalizeReadiness()` provides defaults |

### 1.3 Frontend (React/TypeScript)

**File:** `web/src/__tests__/terminal.test.tsx`

| Component | Test Cases |
|-----------|-----------|
| SSE connection | Mocks EventSource, verifies event handlers attach |
| Output handling | Verifies base64 decode and xterm.write() |
| Readiness display | Shows correct indicator based on confidence |
| Truncation warning | Shows banner when `bytes < total_bytes_available` |
| Input box | Sends command on Enter, clears input |
| Interrupt button | Calls POST /interrupt, disabled when disconnected |

---

## 2. Integration Tests

### 2.1 End-to-End Terminal Flow

**File:** `service/src/__tests__/integration/terminal.test.ts`

```typescript
describe('Terminal E2E', () => {
  it('ensure → input → readiness → output', async () => {
    // 1. Connect mock Bud via WebSocket
    // 2. Call POST /api/terminals/:budId/ensure
    // 3. Verify terminal_ensure frame sent to Bud
    // 4. Mock Bud sends terminal_status { state: 'ready' }
    // 5. Call POST /api/terminals/:budId/input { input: 'echo hello\n' }
    // 6. Verify terminal_input frame
    // 7. Mock Bud sends terminal_output
    // 8. Mock Bud sends terminal_ready
    // 9. Verify SSE events emitted
    // 10. Call GET /api/terminals/:budId/history
    // 11. Verify output returned
  });

  it('interrupt stops running command', async () => {
    // 1. Start long-running command
    // 2. Call POST /api/terminals/:budId/interrupt
    // 3. Verify terminal_interrupt frame
    // 4. Mock Bud sends terminal_ready with interrupt trigger
  });

  it('idle terminals marked and closed', async () => {
    // 1. Create terminal
    // 2. Wait for idle timeout
    // 3. Verify state transitions to 'idle'
    // 4. Wait for cleanup timeout
    // 5. Verify terminal_close sent
  });

  it('reconnect restores terminal', async () => {
    // 1. Create terminal, send output
    // 2. Disconnect Bud
    // 3. Reconnect Bud
    // 4. Verify pipe-pane re-established
    // 5. Verify output continues streaming
  });
});
```

### 2.2 Agent Integration

**File:** `service/src/__tests__/integration/agent-terminal.test.ts`

```typescript
describe('Agent Terminal Integration', () => {
  it('agent uses terminal.run for commands', async () => {
    // 1. Create thread, send user message
    // 2. Agent should choose terminal.run
    // 3. Verify input sent to terminal
    // 4. Mock readiness response
    // 5. Agent receives output and continues
  });

  it('agent uses observe for long-running commands', async () => {
    // 1. Agent runs command with low confidence response
    // 2. Agent should call terminal.observe
    // 3. Eventually receives high confidence
    // 4. Agent proceeds
  });

  it('agent handles password prompts', async () => {
    // 1. Command triggers password prompt
    // 2. Readiness has looks_like_password: true
    // 3. Agent notifies user or handles appropriately
  });
});
```

---

## 3. Manual Test Recipes

### 3.1 Basic Terminal Flow

1. Start Bud with `--terminal` flag
2. Start backend service
3. Open web UI, select Bud
4. Verify terminal panel shows "Terminal: ready"
5. Type `ls -la` in command input, press Enter
6. Verify output appears in terminal
7. Type `python3` to start REPL
8. Verify readiness shows "Ready" (REPL prompt detected)
9. Type `exit()` to exit REPL
10. Verify readiness updates

### 3.2 Interrupt Flow

1. Run `sleep 60` in terminal
2. Verify readiness shows "Processing..."
3. Click "Ctrl+C" button
4. Verify process interrupted
5. Verify readiness shows "Ready"

### 3.3 Reconnect Flow

1. With terminal active, restart backend service
2. Verify UI shows "Reconnecting..."
3. Wait for service to come back
4. Verify terminal restores (history shown)
5. Verify new commands work

### 3.4 Bud Reconnect

1. With terminal active, restart Bud daemon
2. Verify terminal continues working
3. Verify output from previous session available via history

### 3.5 Long-Running Output

1. Run `for i in {1..1000}; do echo "line $i"; sleep 0.1; done`
2. Verify output streams continuously
3. Verify terminal scrolls
4. Verify interrupt stops the loop

### 3.6 Truncation

1. Run command that produces large output (> history cap)
2. Refresh page
3. Verify truncation warning appears
4. Verify dismiss button works

---

## 4. Test Fixtures

### 4.1 Prompt Patterns

**File:** `bud/src/test_fixtures/prompts.txt`

```
# Shell prompts
$
user@host:~$
[user@host ~]$
bash-5.1$
%
➜

# Python prompts
>>>
...
In [1]:
ipdb>

# Node prompts
>
node>

# Confirmation prompts
(y/n)?
[Y/n]:
Continue? [yes/no]
Do you want to proceed? (Y/n)

# Password prompts
Password:
Enter passphrase:
[sudo] password for user:

# Pager indicators
(END)
lines 1-42
-- More --
:
```

### 4.2 Mock Bud Client

**File:** `service/src/__tests__/fixtures/mock-bud.ts`

```typescript
export class MockBud {
  private ws: WebSocket;

  async connect(url: string): Promise<void>;
  async sendHello(): Promise<void>;
  async sendTerminalStatus(state: string): Promise<void>;
  async sendTerminalOutput(data: string): Promise<void>;
  async sendTerminalReady(assessment: object): Promise<void>;

  onTerminalEnsure(handler: (config: object) => void): void;
  onTerminalInput(handler: (data: string) => void): void;
  onTerminalInterrupt(handler: () => void): void;
}
```

---

## 5. Test Coverage Goals

| Component | Target |
|-----------|--------|
| TerminalManager | 80% |
| Agent terminal tools | 90% |
| Readiness detector (Bud) | 90% |
| Frontend SSE handling | 70% |
| E2E flows | All critical paths |

---

## 6. CI Integration

```yaml
# .github/workflows/test.yml
jobs:
  test-backend:
    steps:
      - run: npm test -- --coverage
      - run: npm run test:integration

  test-bud:
    steps:
      - run: cargo test
      - run: cargo test --features integration

  test-frontend:
    steps:
      - run: npm test
```

---

## 7. Known Test Gaps (TODO)

- [ ] Bud unit tests for readiness detector
- [ ] Backend integration tests with mock Bud WebSocket
- [ ] Frontend tests with mocked EventSource
- [ ] E2E tests with real tmux (requires tmux in CI)
- [ ] Load testing for high-volume output
- [ ] Chaos testing (kill Bud mid-command, network partitions)
