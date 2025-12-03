# Agent Terminal Context Awareness

**Date:** 2025-12-03
**Status:** Draft
**Problem:** Agent doesn't know when it's inside a REPL-like program

## Problem Statement

When the agent runs a command that starts a REPL (like `claude`, `node`, `python`, `psql`, etc.), it has no awareness that it's now operating inside a different execution context. This causes several issues:

1. **Wrong command syntax**: Agent sends shell commands (`sed 1,200`, `cat file.txt`) when it should be using REPL-specific syntax or delegating to the REPL program
2. **Wrong input format**: Agent sends `\n` (newline) but some REPLs require actual Enter key or special key sequences
3. **Wrong exit strategy**: Agent tries shell patterns to "finish" when it should be using REPL-specific exit commands

### Example Scenario

```
User: "Review my code using Claude Code"

Agent: terminal.run("claude\n")           # Starts Claude Code
# Claude Code launches, shows its UI
# Agent sees prompt-like output, thinks it's back at shell

Agent: terminal.run("sed -n 1,200p src/main.rs\n")   # WRONG!
# This sends "sed -n 1,200p src/main.rs" as INPUT to Claude Code
# Should instead ask Claude Code to review the file

Agent: terminal.run("cat package.json\n")   # WRONG!
# Same problem - this is shell syntax, not Claude Code syntax
```

### Root Cause

The current implementation only provides last-line-based readiness hints. The agent has no context about:

1. What program is currently running in the foreground
2. Whether a command that was sent has "completed" (returned to shell) or "launched a program"
3. The appropriate interaction patterns for different program types

## Current Architecture

### Agent Context (from system prompt)

```
You are Bud Agent, coordinating terminal access to a user's machine.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.
```

### Readiness Assessment (from Bud)

```typescript
{
  ready: boolean;
  confidence: number;
  trigger: "prompt_detected" | "quiescence" | "timeout";
  prompt_type?: "shell" | "python" | "node" | "confirmation" | "password" | "pager" | "database";
  hints: {
    looks_like_prompt: boolean;
    looks_like_confirmation: boolean;
    looks_like_password: boolean;
    looks_like_pager: boolean;
    looks_like_error: boolean;
    may_still_be_processing: boolean;
  }
}
```

### What's Missing

- **Foreground process name**: What program is actually running?
- **Command stack**: Which commands are "pending" (started but haven't returned to shell)?
- **Context-specific guidance**: How should the agent interact with this specific program?

---

## Proposed Approaches

### Approach 1: Process Tree Introspection

**Concept**: Query the actual foreground process from tmux/proc and pass this information to the agent.

#### Implementation

1. **Bud queries foreground process** when sending readiness:
   ```rust
   // Get foreground process via tmux
   tmux display-message -t {session} -p "#{pane_current_command}"

   // Or via /proc on Linux
   readlink /proc/{pane_pid}/fd/0  // stdin of foreground
   ```

2. **Include in terminal_ready frame**:
   ```json
   {
     "ready": true,
     "foreground_process": "claude",
     "process_cmdline": ["/usr/local/bin/claude"],
     "prompt_type": "repl"
   }
   ```

3. **Agent receives process context** in tool results:
   ```
   TOOL_RESULT: {
     "output": "...",
     "readiness": {
       "foreground_process": "claude",
       "is_shell": false
     }
   }
   ```

4. **System prompt includes guidance** for known processes:
   ```
   When foreground_process is "claude" (Claude Code):
   - You are inside an AI coding assistant
   - Do NOT send shell commands directly
   - Ask Claude Code to perform tasks using natural language
   - Exit with Ctrl+C or type "exit"
   ```

#### Pros
- **Accurate**: Knows exactly what program is running
- **Automatic**: No explicit tracking needed
- **Real-time**: Always reflects current state

#### Cons
- **Platform-specific**: Different mechanisms for Linux vs macOS
- **Process name ambiguity**: `node` could be any Node.js app
- **Subprocess complexity**: What if claude spawns a shell?
- **Performance overhead**: Extra tmux/proc queries per readiness check

#### Complexity: Medium
#### Accuracy: High
#### Maintenance: Medium

---

### Approach 2: Command Stack Tracking

**Concept**: Track which commands have been sent but haven't returned to a shell prompt. Pass this "pending command stack" to the agent.

#### Implementation

1. **Track command initiation** in TerminalManager:
   ```typescript
   interface PendingCommand {
     input: string;          // "claude\n"
     sentAt: number;         // timestamp
     returnedToShell: boolean;
   }

   class TerminalManager {
     private pendingCommands = new Map<string, PendingCommand[]>();

     async sendInput(budId, input, opts) {
       // If sending to shell prompt, push to pending stack
       if (this.currentContext(budId) === "shell") {
         this.pendingCommands.get(budId)?.push({
           input: input.toString().trim(),
           sentAt: Date.now(),
           returnedToShell: false
         });
       }
     }
   }
   ```

2. **Detect shell return** in readiness handler:
   ```typescript
   onReadiness(budId, assessment) {
     if (assessment.prompt_type === "shell" && assessment.confidence >= 0.8) {
       // Returned to shell - pop the stack
       const pending = this.pendingCommands.get(budId);
       if (pending?.length) {
         const last = pending[pending.length - 1];
         last.returnedToShell = true;
       }
     }
   }
   ```

3. **Pass to agent** in tool results:
   ```json
   {
     "output": "...",
     "readiness": {...},
     "context": {
       "pending_commands": ["claude"],
       "likely_environment": "claude_code",
       "hint": "You are inside Claude Code. Use natural language requests instead of shell commands."
     }
   }
   ```

#### Pros
- **Semantic context**: Agent knows what IT started, not just what's running
- **Stack-based**: Handles nested contexts (shell → claude → shell)
- **No platform deps**: Pure application-level tracking

#### Cons
- **Heuristic accuracy**: May mis-detect "returned to shell"
- **State drift**: Stack can desync if user manually exits programs
- **Complexity**: Need to handle edge cases (Ctrl+C, crashes, etc.)

#### Complexity: Medium
#### Accuracy: Medium (depends on shell detection)
#### Maintenance: Low

---

### Approach 3: REPL Mode Declaration

**Concept**: Add explicit tools for the agent to declare when it's entering/exiting a REPL environment.

#### Implementation

1. **New agent tools**:
   ```typescript
   const TERMINAL_ENTER_REPL_TOOL = {
     name: "terminal_enter_repl",
     description: "Declare that you're entering a REPL/interactive program",
     parameters: {
       program: { type: "string" },  // "claude", "python", "node", etc.
       hints: { type: "string" }     // Optional interaction hints
     }
   };

   const TERMINAL_EXIT_REPL_TOOL = {
     name: "terminal_exit_repl",
     description: "Declare that you've exited back to shell"
   };
   ```

2. **Backend tracks mode**:
   ```typescript
   interface TerminalContext {
     mode: "shell" | "repl";
     replProgram?: string;
     enteredAt?: number;
   }
   ```

3. **System prompt adapts** based on mode:
   ```
   Current context: REPL mode (claude)

   When in Claude Code:
   - Communicate with natural language requests
   - Do not send shell commands
   - To exit, send "exit\n" or use terminal.interrupt
   ```

4. **Agent workflow**:
   ```
   Agent: terminal.run("claude\n")
   Agent: terminal.enter_repl({ program: "claude" })
   # System now provides Claude-specific guidance
   Agent: terminal.run("Please review src/main.rs for bugs\n")
   # Agent sends natural language, not shell commands
   Agent: terminal.run("exit\n")
   Agent: terminal.exit_repl()
   ```

#### Pros
- **Explicit contract**: No ambiguity about current state
- **Agent-driven**: Agent declares its understanding
- **Extensible**: Easy to add new REPL types

#### Cons
- **Agent burden**: Agent must remember to call enter/exit
- **Failure modes**: What if agent forgets? Desync occurs
- **Extra round-trips**: More API calls for context management

#### Complexity: Low
#### Accuracy: Depends on agent compliance
#### Maintenance: Low

---

### Approach 4: Enhanced Multi-line Readiness Detection

**Concept**: Don't just analyze the last line - build a state machine that analyzes output patterns to detect REPL entry/exit automatically.

#### Implementation

1. **Bud maintains output state machine**:
   ```rust
   enum TerminalContext {
     Shell,
     Repl { program: String, detected_at: u64 },
     Pager { program: String },
     Editor { program: String },
   }

   impl ReadinessDetector {
     fn analyze_context(&mut self, output: &[u8]) -> TerminalContext {
       let recent = self.last_n_lines(50);

       // Detect Claude Code entry
       if recent.contains("╭─") || recent.contains("Claude") {
         return TerminalContext::Repl { program: "claude".into() };
       }

       // Detect Python REPL
       if recent.contains("Python 3.") && recent.contains(">>>") {
         return TerminalContext::Repl { program: "python".into() };
       }

       // Detect return to shell
       if self.looks_like_shell_prompt(&recent) && !self.in_repl_ui(&recent) {
         return TerminalContext::Shell;
       }
     }
   }
   ```

2. **Include context in terminal_ready**:
   ```json
   {
     "ready": true,
     "context": {
       "type": "repl",
       "program": "claude",
       "confidence": 0.9,
       "detected_via": "ui_pattern"
     }
   }
   ```

3. **Bud sends context_change events**:
   ```json
   {
     "type": "terminal_context_change",
     "previous": { "type": "shell" },
     "current": { "type": "repl", "program": "claude" },
     "trigger": "ui_pattern_detected"
   }
   ```

#### Pros
- **Automatic**: No agent action required
- **Rich patterns**: Can detect many program types
- **UI-aware**: Can recognize TUI applications

#### Cons
- **Heuristic fragility**: Patterns may break with version changes
- **False positives**: May misdetect context
- **Complexity**: State machine is complex to maintain
- **Performance**: More processing per output chunk

#### Complexity: High
#### Accuracy: Medium (heuristic-based)
#### Maintenance: High (patterns evolve)

---

### Approach 5: Hybrid - Process Introspection + Context Stack

**Concept**: Combine process introspection (for accuracy) with command stack (for semantic context).

#### Implementation

1. **Bud queries foreground process** with each readiness assessment
2. **Service maintains command stack** tracking what agent sent
3. **Merge both signals** for comprehensive context:
   ```typescript
   interface TerminalContext {
     // From process introspection
     foreground: {
       process: string;       // "claude"
       pid: number;
       cmdline: string[];
     };

     // From command stack
     agent_history: {
       last_command: string;  // "claude\n"
       pending_since: number; // timestamp
       expected_exit: string; // "exit\n" or "Ctrl+C"
     };

     // Derived
     context_type: "shell" | "repl" | "pager" | "editor" | "unknown";
     interaction_hints: string[];
   }
   ```

2. **System prompt dynamically includes** context-specific guidance:
   ```
   CURRENT TERMINAL CONTEXT:
   - Foreground process: claude (Claude Code AI assistant)
   - You started this with: claude
   - This is an AI-powered coding assistant

   INTERACTION GUIDELINES FOR CLAUDE CODE:
   - Use natural language requests, not shell commands
   - Ask Claude to perform tasks: "Please review src/main.rs"
   - To run shell commands, ask Claude: "Run npm test"
   - To exit: send "exit\n" or use terminal.interrupt

   DO NOT send shell commands directly - Claude Code will interpret them as requests.
   ```

3. **Lookup table** for known programs:
   ```typescript
   const PROGRAM_CONTEXTS: Record<string, ProgramContext> = {
     "claude": {
       type: "repl",
       name: "Claude Code",
       description: "AI-powered coding assistant",
       interaction: "natural_language",
       exit_commands: ["exit", "/exit", "Ctrl+C"],
       hints: [
         "Use natural language requests",
         "Ask Claude to perform tasks",
         "Do not send raw shell commands"
       ]
     },
     "python": {
       type: "repl",
       name: "Python REPL",
       interaction: "python_code",
       exit_commands: ["exit()", "quit()", "Ctrl+D"],
       hints: [
         "Send Python code, not shell commands",
         "Use print() to display output"
       ]
     },
     "node": {
       type: "repl",
       name: "Node.js REPL",
       interaction: "javascript_code",
       exit_commands: [".exit", "Ctrl+D"],
       hints: [
         "Send JavaScript code",
         "Use console.log() for output"
       ]
     }
   };
   ```

#### Pros
- **High accuracy**: Process introspection is ground truth
- **Rich context**: Command history adds semantic understanding
- **Flexible**: Lookup table is easy to extend
- **Robust**: Multiple signals provide redundancy

#### Cons
- **Complexity**: Multiple systems to maintain
- **Platform deps**: Process introspection varies by OS
- **Latency**: Multiple queries per readiness check

#### Complexity: High
#### Accuracy: High
#### Maintenance: Medium

---

## Comparison Matrix

| Approach | Accuracy | Complexity | Agent Changes | Backend Changes | Platform Deps |
|----------|----------|------------|---------------|-----------------|---------------|
| 1. Process Introspection | High | Medium | Minimal | Medium | Yes |
| 2. Command Stack | Medium | Medium | Minimal | Medium | No |
| 3. REPL Declaration | Variable | Low | Significant | Low | No |
| 4. Pattern Detection | Medium | High | Minimal | High | No |
| 5. Hybrid | High | High | Minimal | High | Yes |

## Recommendation

### For Immediate Implementation: Approach 2 (Command Stack)

**Rationale:**
- No platform dependencies
- Can be implemented entirely in TypeScript service
- Provides semantic context ("you started claude")
- Gracefully degrades if detection fails

**Quick win additions:**
- Add `pending_command` to tool results
- Extend system prompt with program-specific guidance when detected
- Use existing readiness prompt_type as secondary signal

### For Future Enhancement: Approach 5 (Hybrid)

**Rationale:**
- Process introspection provides ground truth
- Command stack provides semantic context
- Lookup table makes it extensible
- Worth the complexity for high-accuracy requirement

### Implementation Phases

**Phase 1 (Command Stack - 1-2 days):**
1. Add `pendingCommand` tracking to TerminalManager
2. Include in tool results sent to agent
3. Add program-specific hints to system prompt

**Phase 2 (Process Introspection - 2-3 days):**
1. Add `pane_current_command` query to Bud
2. Include in terminal_ready frames
3. Build program context lookup table

**Phase 3 (Integration - 1 day):**
1. Merge both signals in service
2. Generate dynamic system prompt additions
3. Add context_change events for UI

---

## Appendix: Known Program Signatures

### Claude Code
- **Process name**: `claude`
- **Prompt patterns**: `╭─`, `│`, `╰─`, uses box-drawing characters
- **Interaction**: Natural language requests
- **Exit**: `exit`, `/exit`, Ctrl+C

### Python REPL
- **Process name**: `python`, `python3`
- **Prompt patterns**: `>>>`, `...`
- **Interaction**: Python code
- **Exit**: `exit()`, `quit()`, Ctrl+D

### Node.js REPL
- **Process name**: `node`
- **Prompt patterns**: `>`, `...`
- **Interaction**: JavaScript code
- **Exit**: `.exit`, Ctrl+D

### PostgreSQL
- **Process name**: `psql`
- **Prompt patterns**: `postgres=#`, `postgres=>`
- **Interaction**: SQL commands
- **Exit**: `\q`

### MySQL
- **Process name**: `mysql`
- **Prompt patterns**: `mysql>`
- **Interaction**: SQL commands
- **Exit**: `exit`, `quit`

### Vim/Neovim
- **Process name**: `vim`, `nvim`
- **Prompt patterns**: None (full-screen)
- **Interaction**: Vim commands, modal
- **Exit**: `:q`, `:wq`, `:q!`

### Less/More (Pagers)
- **Process name**: `less`, `more`
- **Prompt patterns**: `:`, `(END)`, `--More--`
- **Interaction**: Single keys (q, space, etc.)
- **Exit**: `q`
