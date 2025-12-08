# Bud Terminal — Persistent Terminal Environment for AI Agents

**Status:** Design Document  
**Version:** 0.2  
**Last Updated:** November 2025

---

## Executive Summary

Bud Terminal provides AI agents with a **persistent terminal environment** on remote machines. From the agent's perspective, it simply "has a terminal" — it can send commands, observe output, and decide when its task is complete. The agent doesn't manage sessions; the terminal is just there, like a developer's always-open terminal window.

Behind the scenes, **tmux** provides session persistence, ensuring the terminal survives Bud daemon restarts, upgrades, network interruptions, and crashes. A **hybrid readiness detection** system helps the agent understand when programs are waiting for input versus still processing.

The agent operates in an **agentic loop**: send input → observe output → decide next action → repeat until task complete → return control to user.

**Implementation status (Nov 2025):**
- **Phase 1 (Bud tmux)**: ✅ Complete — tmux-backed terminal with hello caps, pipe-pane logging, terminal_* frames with `id`/`ts` envelope, readiness detector.
- **Phase 2 (Backend)**: ✅ Complete — terminal tables, TerminalManager, REST/SSE endpoints, gateway parsing, SSE heartbeat for stale detection.
- **Phase 3 (Agent tools)**: ✅ Complete — terminal.run/observe/interrupt tools; enhanced system prompt with confidence thresholds and hints guidance; `normalizeReadiness()` for proper fallbacks; `logReadinessDecision()` for debugging; `outputBytes` in results.
- **Phase 4 (Robustness)**: 🔄 In progress — readiness detection works; remaining: ANSI stripping, binary guards, CRLF normalization, idle timers, metrics.
- **Phase 5 (UI)**: 🔄 Partial — terminal panel with SSE/REST, connection status UI, auto-reconnect; remaining: input box, interrupt control, readiness display, truncation hints.
- See `plan/persistent-terminal-implementation.md` for detailed status and `review/` for phase completion docs.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Conceptual Model](#2-conceptual-model)
3. [Architecture Overview](#3-architecture-overview)
4. [Agent Tools](#4-agent-tools)
5. [Readiness Detection System](#5-readiness-detection-system)
6. [Terminal Lifecycle (Infrastructure)](#6-terminal-lifecycle-infrastructure)
7. [Protocol Specification](#7-protocol-specification)
8. [Data Model](#8-data-model)
9. [Recovery & Resilience](#9-recovery--resilience)
10. [Security Considerations](#10-security-considerations)
11. [Configuration](#11-configuration)
12. [Implementation Phases](#12-implementation-phases)
13. [Open Questions](#13-open-questions)

---

## 1. Goals & Non-Goals

### Goals

- **Transparent terminal access**: Agent has a terminal; it doesn't think about sessions
- **Persistent environment**: Terminal state (directory, env vars, running processes) persists across agent turns
- **Universal compatibility**: Work with any program — shells, REPLs, installers, interactive CLIs
- **Intelligent readiness detection**: Help agent understand when programs await input
- **Agentic loop support**: Agent sends commands, observes, decides, repeats until done
- **Resilient infrastructure**: Terminal survives crashes, restarts, network issues
- **Real-time output**: Stream output to both agent and web UI

### Non-Goals (This Phase)

- **Multiple terminals per Bud**: Start with one terminal per Bud (can extend later)
- **Agent-managed session lifecycle**: Agent doesn't create/destroy sessions
- **GUI applications**: No X11/Wayland support
- **Windows support**: Linux/macOS first
- **Terminal sharing**: Multiple users interacting simultaneously
- **Full terminal emulation in UI**: Output viewing, not interactive terminal widget

---

## 2. Conceptual Model

### The Agent's View

The agent's mental model is simple:

```
┌─────────────────────────────────────────────────────┐
│                    Agent's World                     │
│                                                      │
│  "I have a terminal on this machine.                │
│   I can run commands and see what happens.          │
│   When I'm done with my task, I tell the user."     │
│                                                      │
│  Tools available:                                    │
│   • terminal.run("pip install pandas")              │
│   • terminal.observe()     # wait for more output   │
│   • terminal.interrupt()   # Ctrl+C                 │
│                                                      │
└─────────────────────────────────────────────────────┘
```

The agent does NOT think about:
- Creating or destroying sessions
- Session IDs
- Terminal persistence
- Recovery from crashes

### The User's View

```
┌─────────────────────────────────────────────────────┐
│                    User's World                      │
│                                                      │
│  "I chat with an AI that can control my machine.    │
│   I see what commands it runs and their output.     │
│   The machine state persists between messages."     │
│                                                      │
│  What they see:                                      │
│   • Chat interface with agent responses             │
│   • Live terminal output as agent works             │
│   • Final results when agent completes task         │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### The Infrastructure's Job

```
┌─────────────────────────────────────────────────────┐
│              Infrastructure (Hidden)                 │
│                                                      │
│  Responsibilities:                                   │
│   • Ensure terminal exists when agent needs it      │
│   • Persist terminal across all failure modes       │
│   • Stream output to agent and UI                   │
│   • Detect when programs are waiting for input      │
│   • Clean up idle terminals eventually              │
│                                                      │
│  Implementation:                                     │
│   • tmux for persistence                            │
│   • Automatic creation on first use                 │
│   • Automatic recovery on reconnect                 │
│   • Idle timeout for cleanup (configurable)         │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### Agentic Loop Flow

```
User: "Install pandas and verify it works"
                    │
                    ▼
         ┌──────────────────┐
         │  Agent Receives  │
         │     Task         │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ terminal.run     │◄─────────────────┐
         │ ("pip install    │                  │
         │   pandas")       │                  │
         └────────┬─────────┘                  │
                  │                            │
                  ▼                            │
         ┌──────────────────┐                  │
         │ Observe Output   │                  │
         │ + Readiness      │                  │
         └────────┬─────────┘                  │
                  │                            │
                  ▼                            │
         ┌──────────────────┐      No         │
         │ Task Complete?   │─────────────────┘
         └────────┬─────────┘
                  │ Yes
                  ▼
         ┌──────────────────┐
         │ Return Response  │
         │ to User          │
         └──────────────────┘
```

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Web Browser                                 │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  React UI: Chat Interface + Terminal Output Panel                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ SSE (output stream) + REST (commands)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Backend (Node/TS)                              │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │  Agent Loop  │  │  Terminal    │  │  Readiness   │                   │
│  │  (LLM +      │◄─│  Manager     │◄─│  Detector    │                   │
│  │   Tools)     │  │              │  │              │                   │
│  └──────────────┘  └──────────────┘  └──────────────┘                   │
│         │                  │                                             │
│         │                  ▼                                             │
│         │          ┌──────────────┐         ┌──────────────┐            │
│         │          │     WSS      │         │  PostgreSQL  │            │
│         │          │   Gateway    │         │  (Supabase)  │            │
│         │          └──────────────┘         └──────────────┘            │
│         │                  │                                             │
└─────────│──────────────────│─────────────────────────────────────────────┘
          │                  │
          │                  │ WSS (JSON protocol)
          │                  ▼
          │  ┌─────────────────────────────────────────────────────────────┐
          │  │                     Bud (Rust Daemon)                        │
          │  │                                                              │
          │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
          │  │  │    WSS       │  │   Terminal   │  │    Tmux      │       │
          │  │  │   Client     │◄─│   Handler    │◄─│   Bridge     │       │
          │  │  └──────────────┘  └──────────────┘  └──────────────┘       │
          │  │                            │                                 │
          │  └────────────────────────────│─────────────────────────────────┘
          │                               │
          │                               ▼
          │  ┌─────────────────────────────────────────────────────────────┐
          │  │                        tmux Server                           │
          │  │                                                              │
          │  │    ┌─────────────────────────────────────────────┐          │
          │  │    │  Terminal Session (bash or user's shell)    │          │
          │  │    │                                              │          │
          │  │    │  $ pip install pandas                       │          │
          │  │    │  Collecting pandas...                       │          │
          │  │    │  Successfully installed pandas-2.0.3        │          │
          │  │    │  $ _                                        │          │
          │  │    │                                              │          │
          │  │    └─────────────────────────────────────────────┘          │
          │  │                           │                                  │
          │  │                         [PTY]                                │
          │  │                           │                                  │
          │  │                      [ /bin/bash ]                           │
          │  │                                                              │
          │  └─────────────────────────────────────────────────────────────┘
          │
          │  Agent only sees this:
          │  ┌─────────────────────────────────────────┐
          └─►│  terminal.run("pip install pandas")     │
             │  → "Successfully installed pandas..."   │
             │  → readiness: ready, confidence: 0.95   │
             └─────────────────────────────────────────┘
```

### Key Design Principles

1. **Terminal is infrastructure, not a tool parameter**: The agent doesn't pass session IDs; there's just "the terminal"

2. **One terminal per Bud**: Each connected Bud device has exactly one terminal environment (can extend to multiple later if needed)

3. **Auto-provisioning**: Terminal is created automatically on first use or Bud connection

4. **Persistence is invisible**: The agent doesn't know or care that tmux is keeping things alive

5. **Readiness is advisory**: System provides signals; agent makes decisions

---

## 4. Agent Tools

The agent has three simple tools for terminal interaction.

### Tool: terminal.run

Send input to the terminal and observe the result.

```typescript
interface TerminalRunTool {
  name: "terminal.run";
  description: `
    Run a command or send input to the terminal.
    
    This sends the input exactly as provided to the terminal. The terminal 
    maintains state between calls — environment variables, current directory,
    and running processes all persist.
    
    IMPORTANT: Include newlines where needed:
    • "ls -la\n" — run command and press Enter
    • "y\n" — answer yes to a prompt
    • "exit\n" — exit a program
    
    For special keys:
    • Use terminal.interrupt() for Ctrl+C
    • "\\x04" — Ctrl+D (EOF)
    • "q" — quit a pager (no newline needed for single-key inputs)
    
    After sending input, the system waits for output and assesses whether
    the terminal is ready for more input. Check the readiness.confidence:
    • > 0.8: Terminal is ready for next command
    • 0.5-0.8: Probably ready, verify output makes sense
    • < 0.5: Likely still processing, use terminal.observe() to wait
    
    Common patterns:
    • Shell prompt ($, #, %) → ready for commands
    • REPL prompt (>>>, >, In[1]:) → ready for input  
    • [Y/n] or Continue? → waiting for confirmation
    • Password: → waiting for password (won't echo)
  `;
  
  parameters: {
    // The input to send (include \n for Enter)
    input: string;
    
    // Optional: max time to wait for readiness assessment (default: 30s)
    timeout_ms?: number;
  };
  
  returns: {
    // Output produced after sending the input
    output: string;
    
    // How many bytes of output total
    output_bytes: number;
    
    // Readiness assessment
    readiness: {
      // Is the terminal likely waiting for input?
      ready: boolean;
      
      // How confident (0.0 - 1.0)
      confidence: number;
      
      // What triggered this assessment
      trigger: "prompt_detected" | "quiescence" | "timeout";
      
      // Detected prompt type (if any)
      prompt_type?: "shell" | "python" | "node" | "ruby" | "confirmation" | "password" | "pager" | "unknown";
      
      // Hints for common scenarios
      hints: {
        looks_like_prompt: boolean;
        looks_like_confirmation: boolean;
        looks_like_password: boolean;
        looks_like_pager: boolean;
        looks_like_error: boolean;
        may_still_be_processing: boolean;
      };
    };
    
    // The last line of output (useful for seeing prompts)
    last_line: string;
  };
}
```

### Tool: terminal.observe

Wait for more output without sending input.

```typescript
interface TerminalObserveTool {
  name: "terminal.observe";
  description: `
    Wait for more output from the terminal without sending any input.
    
    Use this when:
    • Previous readiness confidence was low (< 0.5)
    • You expect a long-running process to produce more output
    • You want to see what happens before deciding what to send
    
    This is useful after starting something that takes time:
    • Compilation
    • Package installation  
    • Downloads
    • Test suites
    
    The call returns when either:
    • New output arrives and readiness is assessed
    • The timeout is reached
  `;
  
  parameters: {
    // How long to wait for output (default: 30s)
    timeout_ms?: number;
  };
  
  returns: {
    // Any new output since last call
    output: string;
    output_bytes: number;
    
    // Readiness assessment (same structure as terminal.run)
    readiness: ReadinessAssessment;
    
    last_line: string;
  };
}
```

### Tool: terminal.interrupt

Send Ctrl+C to interrupt the current process.

```typescript
interface TerminalInterruptTool {
  name: "terminal.interrupt";
  description: `
    Send Ctrl+C (SIGINT) to interrupt the current process.
    
    Use this when:
    • A process is stuck or taking too long
    • You need to cancel a running command
    • You want to break out of a program
    • Output shows something is wrong and you need to stop it
    
    After interrupting, the terminal typically returns to a prompt.
    Check the readiness to confirm.
  `;
  
  parameters: {};
  
  returns: {
    // Output after sending Ctrl+C
    output: string;
    
    // Readiness assessment
    readiness: ReadinessAssessment;
    
    last_line: string;
  };
}
```

### Tool: terminal.get_history (Optional)

Retrieve earlier output from the terminal.

```typescript
interface TerminalGetHistoryTool {
  name: "terminal.get_history";
  description: `
    Retrieve earlier output from the terminal session.
    
    Use this when:
    • You need to see output from before your current task
    • You want to review what happened earlier
    • Output was truncated and you need the full version
    
    Returns the most recent N bytes of terminal history.
  `;
  
  parameters: {
    // How many bytes of history to retrieve (default: 10000)
    bytes?: number;
  };
  
  returns: {
    output: string;
    total_bytes_available: number;
  };
}
```

### Agent System Prompt

```markdown
## Terminal Access

You have access to a persistent terminal on this machine. The terminal maintains 
state between commands — your working directory, environment variables, and any 
running processes all persist.

### Available Tools

**terminal.run(input)** — Send a command or input to the terminal
- Always include `\n` to press Enter: `terminal.run({ input: "ls -la\n" })`
- For confirmations: `terminal.run({ input: "y\n" })`
- For single-key responses (like quitting less): `terminal.run({ input: "q" })`

**terminal.observe()** — Wait for more output without sending input
- Use when a command is still running (readiness confidence < 0.5)
- Use for long operations: builds, installs, downloads

**terminal.interrupt()** — Send Ctrl+C to stop the current process
- Use when something is stuck or you need to cancel

### Understanding Readiness

After each command, you'll receive a readiness assessment:

| Confidence | Meaning | Action |
|------------|---------|--------|
| > 0.8 | Terminal is ready | Send next command |
| 0.5-0.8 | Probably ready | Verify output, then proceed |
| < 0.5 | Likely still running | Use terminal.observe() |

Common prompt patterns the system recognizes:
- Shell: `$`, `#`, `%`, `user@host:~$`
- Python: `>>>`, `...`, `In [1]:`
- Node: `>`
- Confirmations: `[Y/n]`, `Continue?`, `(yes/no)`
- Password: `Password:`, `Passphrase:`
- Pagers: `:`, `(END)`, `--More--`

### Tips

1. **Check readiness before sending more input.** If confidence is low, observe first.

2. **Long operations:** After starting a build or install, use `terminal.observe()` 
   repeatedly until it completes.

3. **Stuck processes:** Use `terminal.interrupt()` to send Ctrl+C if something hangs.

4. **REPLs:** You can start Python (`python3\n`), Node (`node\n`), etc. The terminal
   remembers you're in the REPL until you exit.

5. **Environment persists:** If you `cd /some/dir` or `export VAR=value`, it stays
   set for subsequent commands.

6. **Errors are normal:** If a command fails, you'll see the error in output. 
   Diagnose and try again.

### Example Workflow

Task: "Install pandas and verify it works"

1. `terminal.run({ input: "pip install pandas\n" })`
   → Output shows installation progress
   → Readiness: 0.3 (still installing)

2. `terminal.observe({ timeout_ms: 60000 })`
   → Output shows "Successfully installed"
   → Readiness: 0.95, prompt_type: "shell"

3. `terminal.run({ input: "python3\n" })`
   → Output: "Python 3.11.0 ... >>>"
   → Readiness: 0.95, prompt_type: "python"

4. `terminal.run({ input: "import pandas; print(pandas.__version__)\n" })`
   → Output: "2.0.3\n>>>"
   → Readiness: 0.95

5. `terminal.run({ input: "exit()\n" })`
   → Back to shell prompt

Done! Report success to user.
```

---

## 5. Readiness Detection System

The readiness detection system determines when the terminal is waiting for input versus still processing. This is inherently ambiguous, so the system provides confidence scores.

### Detection Layers

#### Layer 1: Known Prompt Patterns (Highest Confidence)

```yaml
# Patterns that strongly indicate "waiting for input"

shell:
  - pattern: '^.+\$\s*$'                    # user@host:path$
    confidence: 0.95
  - pattern: '^.+#\s*$'                     # root prompt
    confidence: 0.95
  - pattern: '^\$\s*$'                      # minimal $
    confidence: 0.90
  - pattern: '^%\s*$'                       # zsh
    confidence: 0.90
  - pattern: '^>\s*$'                       # generic
    confidence: 0.80

python:
  - pattern: '^>>>\s*$'                     # standard
    confidence: 0.95
  - pattern: '^\.\.\.\s*$'                  # continuation
    confidence: 0.95
  - pattern: '^In \[\d+\]:\s*$'             # IPython
    confidence: 0.95

node:
  - pattern: '^>\s*$'                       # node repl
    confidence: 0.85
  - pattern: '^\.\.\.\s*$'                  # continuation
    confidence: 0.85

ruby:
  - pattern: '^irb\([^)]+\):\d+:\d+[>*]\s*$'  # irb
    confidence: 0.95
  - pattern: '^>>\s*$'                         # pry
    confidence: 0.90

confirmation:
  - pattern: '\[Y/n\]\s*$'
    confidence: 0.95
  - pattern: '\[y/N\]\s*$'
    confidence: 0.95
  - pattern: '\(yes/no\)\??\s*$'
    confidence: 0.95
  - pattern: 'Continue\?\s*'
    confidence: 0.90
  - pattern: 'Proceed\?\s*'
    confidence: 0.90

password:
  - pattern: '[Pp]assword:\s*$'
    confidence: 0.95
  - pattern: '[Pp]assphrase.*:\s*$'
    confidence: 0.95

pager:
  - pattern: '^:\s*$'                       # less
    confidence: 0.90
  - pattern: '^\(END\)\s*$'                 # less at end
    confidence: 0.95
  - pattern: '^--More--'                    # more
    confidence: 0.90

database:
  - pattern: '^mysql>\s*$'
    confidence: 0.95
  - pattern: '^postgres[=#]\s*$'
    confidence: 0.95
  - pattern: '^sqlite>\s*$'
    confidence: 0.95
```

#### Layer 2: Output Quiescence

When no known pattern matches, use timing:

```
QUIESCENCE_THRESHOLD_MS = 1500   # Output quiet this long = probably ready
MAX_WAIT_MS = 30000              # Don't wait longer than this
POLL_INTERVAL_MS = 50            # Check for output this often
```

Algorithm:
1. After sending input, start timer
2. Each time output arrives, reset timer
3. When timer exceeds threshold, analyze current state
4. Apply heuristics to estimate confidence

#### Layer 3: Heuristic Scoring

When quiescence is reached without a known pattern match:

```
Base confidence: 0.5 (we know output stopped, but not why)

Adjustments:
+0.25  Last line ends with: $ # > : ? %
+0.15  Last line is short (< 60 chars)
+0.10  Last line has no internal spaces (looks like prompt)
+0.10  Output ends mid-line (no trailing newline)

-0.20  Last line is very long (> 150 chars)
-0.15  Output ends with blank line (typical of ongoing output)
-0.15  Output contains progress indicators: %, ETA, ..., ━━━
-0.10  Output arrived very recently (< 500ms quiet)
```

### Readiness Assessment Structure

```typescript
interface ReadinessAssessment {
  // Primary signal
  ready: boolean;              // System's best guess
  confidence: number;          // 0.0 - 1.0
  
  // What triggered this assessment
  trigger: 
    | "prompt_detected"        // Known pattern matched
    | "quiescence"             // Output stopped, heuristics applied
    | "timeout";               // Max wait time reached
  
  // If prompt detected, what kind
  prompt_type?: 
    | "shell"
    | "python" 
    | "node"
    | "ruby"
    | "confirmation"
    | "password"
    | "pager"
    | "database"
    | "unknown";
  
  // Hints for agent decision-making
  hints: {
    looks_like_prompt: boolean;
    looks_like_confirmation: boolean;
    looks_like_password: boolean;
    looks_like_pager: boolean;
    looks_like_error: boolean;
    may_still_be_processing: boolean;
  };
  
  // Context
  quiet_for_ms: number;        // How long since last output
}
```

### Confidence Interpretation Guide

| Score | Meaning | Agent Should |
|-------|---------|--------------|
| 0.9-1.0 | Known prompt pattern matched | Send next command |
| 0.7-0.9 | Strong heuristic signals | Probably safe to proceed |
| 0.5-0.7 | Ambiguous | Check context; consider observing |
| 0.3-0.5 | Probably still processing | Use terminal.observe() |
| 0.0-0.3 | Almost certainly processing | Use terminal.observe() |

---

## 6. Terminal Lifecycle (Infrastructure)

This section describes what happens behind the scenes. **The agent is unaware of all this.**

### Terminal States

```
                    ┌─────────────┐
         ┌─────────►│   READY     │◄────────────┐
         │          └──────┬──────┘             │
         │                 │                    │
    (Bud connects,    (agent sends         (agent task
     terminal exists)   command)            completes)
         │                 │                    │
         │                 ▼                    │
         │          ┌─────────────┐             │
         │          │   ACTIVE    │─────────────┘
         │          └──────┬──────┘
         │                 │
         │            (idle timeout)
         │                 │
         │                 ▼
┌─────────────┐     ┌─────────────┐
│  CREATING   │────►│   IDLE      │
└─────────────┘     └──────┬──────┘
      ▲                    │
      │               (idle too long)
      │                    │
      │                    ▼
      │             ┌─────────────┐
      └─────────────│   CLOSED    │
     (new task)     └─────────────┘
```

| State | Description |
|-------|-------------|
| `CREATING` | Terminal being provisioned (tmux session starting) |
| `READY` | Terminal exists, waiting for commands |
| `ACTIVE` | Agent is currently using terminal |
| `IDLE` | No activity for a while; still available |
| `CLOSED` | Terminal shut down (will recreate on next use) |

### Auto-Provisioning

Terminal is created automatically when:
1. Bud connects and no terminal exists
2. Agent sends first command after terminal was closed
3. Backend requests terminal and Bud doesn't have one

```typescript
// Backend logic (simplified)
async function getTerminalForBud(budId: string): Promise<Terminal> {
  let terminal = await db.terminal.findActive(budId);
  
  if (!terminal) {
    // Create new terminal
    terminal = await createTerminal(budId);
  }
  
  if (terminal.state === 'CLOSED') {
    // Recreate
    terminal = await createTerminal(budId);
  }
  
  return terminal;
}
```

### Idle Management

```
IDLE_TIMEOUT_MINUTES = 30        # Mark idle after 30 min no input
IDLE_CLEANUP_HOURS = 24          # Close terminal after 24 hours idle

Timeline:
0:00  - Agent finishes task, terminal state → READY
0:30  - No activity, terminal state → IDLE  
24:00 - Still no activity, terminal state → CLOSED, tmux session killed
```

When closed, all state is lost (directory, env vars, processes). Next use creates fresh terminal.

### Recovery Flows

#### Bud Restart

```
1. Bud process stops (crash, upgrade, etc.)
2. tmux session continues running (independent process)
3. Bud process starts
4. Bud checks for existing tmux session: tmux has-session -t bud_terminal
5. If exists:
   a. Reconnect output watcher to existing log file
   b. Report terminal state to backend
6. If not exists:
   a. Report no terminal to backend
   b. Terminal will be created on first use
```

#### Backend Restart

```
1. Backend process stops
2. Bud detects disconnection, enters reconnect loop
3. Backend process starts
4. Bud reconnects, sends hello with terminal state
5. Backend reconciles:
   a. Update DB with current terminal state
   b. Resume output streaming
```

#### Network Interruption

```
1. WebSocket connection drops
2. Bud side:
   a. Terminal continues running
   b. Output continues logging to file
   c. Output messages queue (bounded)
3. Backend side:
   a. Mark terminal as "disconnected"
   b. Agent operations fail with "terminal unavailable"
4. On reconnect:
   a. Bud sends queued output messages
   b. Backend resumes normal operation
```

---

## 7. Protocol Specification

### Message Envelope

All messages include:

```typescript
interface MessageEnvelope {
  type: string;
  proto: "0.2";
  message_id: string;          // ULID
  sent_at: string;             // ISO 8601
}
```

### Terminal Messages (Backend → Bud)

#### terminal_ensure

Ensure terminal exists (auto-create if needed).

```typescript
interface TerminalEnsureMessage extends MessageEnvelope {
  type: "terminal_ensure";
  
  // Configuration for new terminal (if creating)
  config?: {
    shell?: string;            // Default: user's login shell
    cwd?: string;              // Default: ~
    env?: Record<string, string>;
    cols?: number;             // Default: 200
    rows?: number;             // Default: 50
  };
}
```

#### terminal_input

Send input to the terminal.

```typescript
interface TerminalInputMessage extends MessageEnvelope {
  type: "terminal_input";
  
  // Input data (base64 encoded, may include control chars)
  data: string;
  
  // Request readiness detection after sending
  await_ready: {
    enabled: boolean;
    quiescence_ms?: number;    // Override default
    max_wait_ms?: number;      // Override default
  };
}
```

#### terminal_interrupt

Send SIGINT (Ctrl+C).

```typescript
interface TerminalInterruptMessage extends MessageEnvelope {
  type: "terminal_interrupt";
  
  await_ready?: {
    enabled: boolean;
    max_wait_ms?: number;
  };
}
```

#### terminal_resize

Resize terminal (if UI supports it).

```typescript
interface TerminalResizeMessage extends MessageEnvelope {
  type: "terminal_resize";
  cols: number;
  rows: number;
}
```

#### terminal_close

Close the terminal (admin/cleanup only).

```typescript
interface TerminalCloseMessage extends MessageEnvelope {
  type: "terminal_close";
  reason: string;
}
```

### Terminal Messages (Bud → Backend)

#### terminal_status

Report terminal state (on connect, on change).

```typescript
interface TerminalStatusMessage extends MessageEnvelope {
  type: "terminal_status";
  
  state: "none" | "creating" | "ready" | "active" | "closed";
  
  // If terminal exists
  info?: {
    tmux_session: string;
    pid: number;
    shell: string;
    cwd: string;               // Current working directory (if detectable)
    cols: number;
    rows: number;
    output_log_bytes: number;  // Size of output history
    started_at: string;
    last_activity_at: string;
  };
}
```

#### terminal_output

Streaming output from terminal.

```typescript
interface TerminalOutputMessage extends MessageEnvelope {
  type: "terminal_output";
  
  seq: number;                 // Monotonic sequence
  data: string;                // Base64 encoded output
  byte_offset: number;         // Position in total output stream
}
```

#### terminal_ready

Readiness assessment (after input, if requested).

```typescript
interface TerminalReadyMessage extends MessageEnvelope {
  type: "terminal_ready";
  
  assessment: ReadinessAssessment;
  
  // Output context
  output_since_input: string;  // Base64
  output_bytes: number;
  last_line: string;
}
```

### Enhanced Hello Message

```typescript
interface HelloMessage extends MessageEnvelope {
  type: "hello";
  
  // ... existing fields (bud_id, device info, etc.) ...
  
  // Terminal state on connect
  terminal?: {
    state: "none" | "ready" | "active";
    tmux_session?: string;
    pid?: number;
    output_log_bytes?: number;
    started_at?: string;
  };
}
```

---

## 8. Data Model

### Database Schema

```sql
-- One terminal per Bud
create table bud_terminal (
    bud_id              text primary key references bud(bud_id) on delete cascade,
    
    -- State
    state               text not null default 'none',
                        -- none, creating, ready, active, idle, closed
    
    -- tmux details
    tmux_session_name   text,              -- e.g., "bud_terminal"
    pid                 integer,           -- shell PID
    shell               text,              -- /bin/bash, /bin/zsh, etc.
    
    -- Terminal config
    cols                integer default 200,
    rows                integer default 50,
    
    -- Timestamps
    created_at          timestamptz,
    last_input_at       timestamptz,
    last_output_at      timestamptz,
    closed_at           timestamptz,
    
    -- Stats
    total_input_bytes   bigint not null default 0,
    total_output_bytes  bigint not null default 0,
    
    -- Multi-tenant
    tenant_id           text
);

-- Terminal output history
-- Stored in chunks for retrieval
create table terminal_output (
    bud_id              text not null references bud_terminal(bud_id) on delete cascade,
    seq                 bigint not null,
    
    data                bytea not null,
    byte_offset         bigint not null,
    
    created_at          timestamptz not null default now(),
    
    primary key (bud_id, seq)
);

create index terminal_output_offset_idx on terminal_output(bud_id, byte_offset);

-- Optional: input audit log
create table terminal_input_log (
    id                  uuid primary key default gen_random_uuid(),
    bud_id              text not null references bud_terminal(bud_id) on delete cascade,
    
    data                bytea not null,
    
    -- Attribution
    source              text not null,     -- 'agent', 'user', 'system'
    run_id              text,              -- agent run that sent this
    user_id             text,
    
    created_at          timestamptz not null default now()
);

create index terminal_input_log_bud_idx on terminal_input_log(bud_id, created_at);
```

### In-Memory State (Backend)

```typescript
interface TerminalState {
  bud_id: string;
  state: TerminalStateEnum;
  
  // Output buffering
  output_buffer: CircularBuffer<Uint8Array>;  // Recent output
  output_byte_offset: number;
  last_output_at: Date;
  
  // Readiness detection
  pending_readiness: ReadinessRequest | null;
  
  // Subscribers
  output_subscribers: Set<Subscriber>;
}

interface TerminalManager {
  terminals: Map<string, TerminalState>;  // keyed by bud_id
  
  // Operations
  ensureTerminal(budId: string): Promise<void>;
  sendInput(budId: string, data: Uint8Array): Promise<TerminalResponse>;
  sendInterrupt(budId: string): Promise<TerminalResponse>;
  getHistory(budId: string, bytes: number): Promise<Uint8Array>;
  
  // Subscriptions
  subscribe(budId: string, subscriber: Subscriber): () => void;
  
  // Lifecycle
  handleBudConnected(budId: string, terminalInfo?: TerminalInfo): void;
  handleBudDisconnected(budId: string): void;
}
```

### In-Memory State (Bud)

```rust
struct Terminal {
    tmux_session_name: String,
    
    // Output capture
    output_log_path: PathBuf,
    output_watcher: JoinHandle<()>,
    output_seq: AtomicU64,
    last_sent_offset: AtomicU64,
    
    // State
    state: AtomicCell<TerminalState>,
    last_input_at: AtomicCell<Instant>,
    last_output_at: AtomicCell<Instant>,
    
    // Config
    started_at: Instant,
}

struct TerminalManager {
    terminal: Option<Terminal>,
    tmux_session_name: String,     // Fixed: "bud_terminal"
    output_log_path: PathBuf,      // Fixed: /tmp/bud_terminal.log
}
```

---

## 9. Recovery & Resilience

### Bud Startup Sequence

```rust
async fn init_terminal() -> Result<Option<Terminal>> {
    // Check if tmux session exists
    let exists = Command::new("tmux")
        .args(["has-session", "-t", TMUX_SESSION_NAME])
        .status()
        .await?
        .success();
    
    if exists {
        // Recover existing terminal
        let pid = get_tmux_pane_pid(TMUX_SESSION_NAME).await?;
        let log_size = fs::metadata(&OUTPUT_LOG_PATH)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        
        // Resume output watching from current position
        let watcher = spawn_output_watcher(OUTPUT_LOG_PATH, log_size);
        
        Ok(Some(Terminal {
            tmux_session_name: TMUX_SESSION_NAME.to_string(),
            output_log_path: OUTPUT_LOG_PATH.to_path_buf(),
            output_watcher: watcher,
            output_seq: AtomicU64::new(0),
            last_sent_offset: AtomicU64::new(log_size),
            state: AtomicCell::new(TerminalState::Ready),
            // ... etc
        }))
    } else {
        // No existing terminal
        Ok(None)
    }
}
```

### Terminal Creation

```rust
async fn create_terminal(config: TerminalConfig) -> Result<Terminal> {
    let shell = config.shell.unwrap_or_else(|| get_user_shell());
    let cwd = config.cwd.unwrap_or_else(|| home_dir());
    
    // Create tmux session
    Command::new("tmux")
        .args([
            "new-session",
            "-d",                              // detached
            "-s", TMUX_SESSION_NAME,
            "-x", &config.cols.to_string(),
            "-y", &config.rows.to_string(),
            "-c", &cwd,
            &shell,
        ])
        .status()
        .await?;
    
    // Set up output capture
    Command::new("tmux")
        .args([
            "pipe-pane",
            "-t", TMUX_SESSION_NAME,
            "-o",
            &format!("cat >> {}", OUTPUT_LOG_PATH.display()),
        ])
        .status()
        .await?;
    
    // Start watching output file
    let watcher = spawn_output_watcher(OUTPUT_LOG_PATH, 0);
    
    Ok(Terminal { /* ... */ })
}
```

### Sending Input

```rust
async fn send_input(&self, data: &[u8]) -> Result<()> {
    // tmux send-keys with -l (literal) flag
    // But first we need to handle the input encoding
    
    // For printable text, use send-keys -l
    // For control characters, need special handling
    
    let input = String::from_utf8_lossy(data);
    
    Command::new("tmux")
        .args(["send-keys", "-t", &self.tmux_session_name, "-l", &input])
        .status()
        .await?;
    
    self.last_input_at.store(Instant::now());
    Ok(())
}

async fn send_interrupt(&self) -> Result<()> {
    Command::new("tmux")
        .args(["send-keys", "-t", &self.tmux_session_name, "C-c"])
        .status()
        .await?;
    
    Ok(())
}
```

### Output Watching

```rust
async fn spawn_output_watcher(
    log_path: PathBuf,
    start_offset: u64,
    output_tx: mpsc::Sender<OutputChunk>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut offset = start_offset;
        let mut seq = 0u64;
        
        loop {
            // Check file size
            let size = match fs::metadata(&log_path).await {
                Ok(m) => m.len(),
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            
            if size > offset {
                // New data available
                let mut file = fs::File::open(&log_path).await?;
                file.seek(SeekFrom::Start(offset)).await?;
                
                let mut buf = vec![0u8; (size - offset) as usize];
                file.read_exact(&mut buf).await?;
                
                // Send chunk
                output_tx.send(OutputChunk {
                    seq,
                    data: buf,
                    byte_offset: offset,
                }).await?;
                
                offset = size;
                seq += 1;
            }
            
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
}
```

---

## 10. Security Considerations

### Command Execution

- Commands execute as the user running Bud (no privilege escalation)
- No special sanitization of input (agent has full terminal access)
- Dangerous command detection is a **backend/agent concern**, not Bud's

### Output Handling

- Output is captured as raw bytes
- Frontend must sanitize before rendering (XSS prevention)
- Consider stripping/escaping ANSI codes for agent consumption

### Sensitive Data

- Terminal output may contain secrets (passwords, tokens, etc.)
- Consider:
  - Encryption at rest for output logs
  - Automatic scrubbing of known patterns (optional)
  - Retention limits on output history

### Idle Timeout

- Prevents abandoned terminals from running indefinitely
- Enforced by Bud (cannot be bypassed by backend issues)
- Configurable per deployment

---

## 11. Configuration

### Bud Configuration

```toml
# ~/.bud/config.toml

[terminal]
# Enable terminal support
enabled = true

# tmux session name (fixed)
session_name = "bud_terminal"

# Output log location
output_log = "/tmp/bud_terminal.log"

# Default shell (empty = user's login shell)
default_shell = ""

# Default working directory (empty = home)
default_cwd = ""

# Terminal size
cols = 200
rows = 50

# Timeouts
idle_timeout_minutes = 30
max_lifetime_hours = 24

# Output streaming
output_chunk_size = 16384
output_buffer_chunks = 128
```

### Backend Configuration

```bash
# Environment variables

# Terminal feature
TERMINAL_ENABLED=true

# Readiness detection
TERMINAL_QUIESCENCE_MS=1500
TERMINAL_MAX_WAIT_MS=30000

# Output
TERMINAL_OUTPUT_BUFFER_SIZE=1048576    # 1 MB
TERMINAL_OUTPUT_RETENTION_DAYS=7

# Prompt patterns file (optional override)
TERMINAL_PATTERNS_FILE=/etc/bud/patterns.yaml
```

### Prompt Patterns File

```yaml
# /etc/bud/patterns.yaml

patterns:
  shell:
    - pattern: '^.+[$#%]\s*$'
      confidence: 0.90
      prompt_type: shell
      
  python:
    - pattern: '^>>>\s*$'
      confidence: 0.95
      prompt_type: python
      
  # ... (see Section 5 for full list)
  
  # Custom patterns can be added here
  custom:
    - pattern: '^myapp>\s*$'
      confidence: 0.90
      prompt_type: unknown
```

---

## 12. Implementation Phases

### Phase 1: Basic Terminal (Week 1-2)

**Goal:** Terminal creation, input/output, no readiness detection

Deliverables:
- [ ] Database schema for bud_terminal
- [ ] Bud: tmux session management (create, detect existing, cleanup)
- [ ] Bud: Output capture via pipe-pane + file watching
- [ ] Protocol: terminal_ensure, terminal_input, terminal_output, terminal_status
- [ ] Backend: TerminalManager with state tracking
- [ ] Backend: Output streaming to SSE for UI

Acceptance Criteria:
- Backend can request terminal, Bud creates it
- Can send input, see output in real-time
- Terminal survives Bud restart

### Phase 2: Readiness Detection (Week 3)

**Goal:** Intelligent detection of when terminal awaits input

Deliverables:
- [ ] Prompt pattern configuration system
- [ ] Quiescence detection logic
- [ ] Heuristic scoring
- [ ] ReadinessAssessment structure
- [ ] Protocol: terminal_ready message
- [ ] Bud: Readiness detection after input

Acceptance Criteria:
- Python/Node/shell prompts detected with >0.9 confidence
- Unknown prompts detected via quiescence with reasonable confidence
- Y/n confirmations detected correctly

### Phase 3: Agent Integration (Week 4)

**Goal:** Agent tools working end-to-end

Deliverables:
- [ ] Agent tools: terminal.run, terminal.observe, terminal.interrupt
- [ ] Tool handlers in backend
- [ ] Agent system prompt
- [ ] Integration with existing agent loop

Acceptance Criteria:
- Agent can complete multi-step terminal tasks
- Agent handles confirmations correctly
- Agent uses observe() for long-running commands
- Agent can interrupt stuck processes

### Phase 4: Recovery & Polish (Week 5)

**Goal:** Production-ready resilience

Deliverables:
- [ ] Bud startup recovery (detect existing tmux)
- [ ] Backend reconnect handling
- [ ] Idle timeout enforcement
- [ ] terminal.get_history tool
- [ ] Output history storage and retrieval
- [ ] Metrics and logging

Acceptance Criteria:
- Terminal survives Bud restart automatically
- Terminal survives backend restart
- Idle terminals cleaned up correctly
- Can retrieve historical output

### Phase 5: UI Integration (Week 6)

**Goal:** User can see terminal activity

Deliverables:
- [ ] Terminal output panel in web UI
- [ ] Real-time output streaming via SSE
- [ ] Visual indicators for terminal state
- [ ] Output scroll/search

Acceptance Criteria:
- User sees live output as agent works
- Output persists and can be scrolled
- Clear indication of terminal activity

---

## 13. Open Questions

### Product

1. **Multiple terminals?** Should we eventually support multiple terminals per Bud? (e.g., one for builds, one for server)

2. **Direct user access?** Should users be able to type directly into the terminal, or only through the agent?

3. **Terminal UI fidelity?** Full terminal emulator in browser, or simplified output view?

4. **Output retention?** How long to keep terminal history? Per-tenant settings?

### Technical

5. **Large output handling?** What if a command produces GB of output? Truncation? Streaming to S3?

6. **Binary output?** How to handle `cat binary_file`? Detect and warn?

7. **tmux availability?** What if tmux isn't installed? Auto-install? Fallback?

8. **Control characters?** Full support for all control chars, or subset?

### Agent Behavior

9. **Stuck detection?** Should infrastructure detect genuinely stuck programs and alert agent?

10. **Token limits?** Should large output be summarized before sending to agent?

11. **Working directory tracking?** Should we track/report current directory to agent?

---

## Appendix A: tmux Command Reference

```bash
# Check if session exists
tmux has-session -t bud_terminal 2>/dev/null && echo "exists"

# Create session
tmux new-session -d -s bud_terminal -x 200 -y 50

# Set up output capture (append to log file)
tmux pipe-pane -t bud_terminal -o "cat >> /tmp/bud_terminal.log"

# Send literal input (including special characters)
tmux send-keys -t bud_terminal -l "echo hello\n"

# Send control keys
tmux send-keys -t bud_terminal C-c        # Ctrl+C
tmux send-keys -t bud_terminal C-d        # Ctrl+D
tmux send-keys -t bud_terminal C-z        # Ctrl+Z

# Get shell PID
tmux display-message -t bud_terminal -p "#{pane_pid}"

# Get current directory (if shell supports it)
tmux display-message -t bud_terminal -p "#{pane_current_path}"

# Kill session
tmux kill-session -t bud_terminal
```

---

## Appendix B: Example Agent Workflows

### Simple Command

```
User: "What Python version is installed?"

Agent thinking: I need to check the Python version.

terminal.run({ input: "python3 --version\n" })
→ {
    output: "Python 3.11.0\n$ ",
    readiness: { ready: true, confidence: 0.95, prompt_type: "shell" }
  }

Agent response: "Python 3.11.0 is installed."
```

### Multi-Step Task

```
User: "Create a virtual environment and install requests"

Agent thinking: I need to create a venv, activate it, and install requests.

terminal.run({ input: "python3 -m venv myenv\n" })
→ {
    output: "$ ",
    readiness: { ready: true, confidence: 0.92 }
  }

terminal.run({ input: "source myenv/bin/activate\n" })
→ {
    output: "(myenv) $ ",
    readiness: { ready: true, confidence: 0.95 }
  }

terminal.run({ input: "pip install requests\n" })
→ {
    output: "Collecting requests\n  Downloading...\n",
    readiness: { ready: false, confidence: 0.25, hints: { may_still_be_processing: true } }
  }

terminal.observe({ timeout_ms: 60000 })
→ {
    output: "Successfully installed requests-2.31.0\n(myenv) $ ",
    readiness: { ready: true, confidence: 0.95 }
  }

Agent response: "Done! Created virtual environment 'myenv' and installed requests 2.31.0."
```

### Handling Confirmation

```
User: "Update all packages with apt"

terminal.run({ input: "sudo apt update && sudo apt upgrade\n" })
→ {
    output: "...45 packages can be upgraded...\nDo you want to continue? [Y/n] ",
    readiness: { 
      ready: true, 
      confidence: 0.95, 
      prompt_type: "confirmation",
      hints: { looks_like_confirmation: true }
    }
  }

Agent thinking: It's asking for confirmation. I'll say yes.

terminal.run({ input: "y\n" })
→ {
    output: "Unpacking...",
    readiness: { ready: false, confidence: 0.2 }
  }

terminal.observe({ timeout_ms: 120000 })
→ {
    output: "...45 upgraded, 0 newly installed...\n$ ",
    readiness: { ready: true, confidence: 0.92 }
  }

Agent response: "Updated 45 packages successfully."
```

### Handling Interactive Program

```
User: "Start Python and test if numpy is installed"

terminal.run({ input: "python3\n" })
→ {
    output: "Python 3.11.0 (main, ...)\n>>> ",
    readiness: { ready: true, confidence: 0.95, prompt_type: "python" }
  }

terminal.run({ input: "import numpy\n" })
→ {
    output: ">>> ",
    readiness: { ready: true, confidence: 0.95, prompt_type: "python" }
  }

Agent thinking: No error, numpy imported successfully.

terminal.run({ input: "print(numpy.__version__)\n" })
→ {
    output: "1.24.0\n>>> ",
    readiness: { ready: true, confidence: 0.95 }
  }

terminal.run({ input: "exit()\n" })
→ {
    output: "$ ",
    readiness: { ready: true, confidence: 0.92, prompt_type: "shell" }
  }

Agent response: "NumPy is installed (version 1.24.0)."
```

### Handling Stuck Process

```
User: "Run the server"

terminal.run({ input: "./start_server.sh\n" })
→ {
    output: "Starting server on port 8080...\nListening...",
    readiness: { ready: false, confidence: 0.15, hints: { may_still_be_processing: true } }
  }

Agent thinking: Server is running, it won't exit. Let me check if it's working.

terminal.interrupt()
→ {
    output: "^C\n$ ",
    readiness: { ready: true, confidence: 0.92 }
  }

terminal.run({ input: "./start_server.sh &\n" })
→ {
    output: "[1] 12345\nStarting server...\n$ ",
    readiness: { ready: true, confidence: 0.90 }
  }

terminal.run({ input: "curl localhost:8080/health\n" })
→ {
    output: "{\"status\": \"ok\"}\n$ ",
    readiness: { ready: true, confidence: 0.92 }
  }

Agent response: "Server is running in the background on port 8080 and responding to health checks."
```
