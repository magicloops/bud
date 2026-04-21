/**
 * Context Sync Service
 *
 * Pre-flight terminal context synchronization service.
 * Detects terminal state changes before user messages are processed
 * and injects context update messages to keep the agent informed.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { terminalSessionTable, messageTable } from "../db/schema.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type { TerminalStateSnapshot, StateChangeDetails } from "./types.js";
import {
  providerRegistry,
  type CanonicalMessage,
  type ModelConfig,
} from "../llm/index.js";

// Model to use for context summaries (fast, cheap)
const SUMMARY_MODEL = "claude-haiku-4-5";

export class ContextSyncService {
  constructor(
    private terminalSessionManager: TerminalSessionManager,
    private logger: FastifyBaseLogger
  ) {}

  /**
   * Capture current terminal state and update the snapshot.
   * Called after agent tool calls to keep snapshot current.
   * Does NOT inject any messages - just updates the stored state.
   */
  async refreshSnapshot(sessionId: string): Promise<void> {
    try {
      const { hash, lastLine, capture } = await this.captureCurrentState(sessionId);
      const currentMode = this.detectModeHeuristic(capture, lastLine);

      if (currentMode === "shell") {
        this.terminalSessionManager.clearPendingCommand(sessionId);
      }

      await this.updateSnapshot(sessionId, hash, lastLine, currentMode, null);

      this.logger.debug(
        { sessionId, mode: currentMode, lastLine: lastLine.slice(0, 50) },
        "Context sync: snapshot refreshed"
      );
    } catch (err) {
      this.logger.warn({ sessionId, err }, "Context sync: failed to refresh snapshot");
    }
  }

  /**
   * Check if terminal state changed since last snapshot.
   * If changed, generate summary and insert context message.
   *
   * @returns The summary message if state changed, null otherwise
   */
  async checkAndSync(
    sessionId: string,
    threadId: string,
    ownerUserId?: string | null,
  ): Promise<string | null> {
    try {
      // 1. Capture current state
      const { capture, hash, lastLine } = await this.captureCurrentState(sessionId);

      // 2. Detect current mode
      const currentMode = this.detectModeHeuristic(capture, lastLine);

      // 3. Clear pendingCommands if mode changed to shell
      // This ensures inferred terminal context is aligned after an interactive program exits.
      if (currentMode === "shell") {
        this.terminalSessionManager.clearPendingCommand(sessionId);
      }

      // 4. Detect changes compared to last snapshot
      const { changed, details } = await this.detectStateChange(
        sessionId,
        capture,
        hash,
        lastLine,
        currentMode
      );

      if (!changed) {
        // Update hash but don't inject message
        await this.updateSnapshot(sessionId, hash, lastLine, currentMode, null);
        return null;
      }

      // 5. Generate summary using LLM
      const summary = await this.generateSummary(details!);

      // 6. Insert context message
      await this.insertContextMessage(threadId, summary, details!, ownerUserId);

      // 7. Update snapshot
      await this.updateSnapshot(sessionId, hash, lastLine, currentMode, null);

      this.logger.info(
        { sessionId, threadId, previousMode: details!.previousMode, currentMode },
        "Context sync: state change detected"
      );

      return summary;
    } catch (err) {
      this.logger.warn({ sessionId, err }, "Context sync failed, skipping");
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // State Capture
  // ─────────────────────────────────────────────────────────────────────────────

  private async captureCurrentState(sessionId: string): Promise<{
    capture: string;
    hash: string;
    lastLine: string;
  }> {
    const result = await this.terminalSessionManager.capturePane(
      sessionId,
      { startLine: -30, joinLines: true },
      3000
    );

    const capture = result.output;
    const hash = createHash("sha256").update(capture).digest("hex").slice(0, 16);
    const lastLine = this.extractLastLine(capture);

    return { capture, hash, lastLine };
  }

  private extractLastLine(capture: string): string {
    const lines = capture.split("\n").filter((l) => l.trim());
    return lines[lines.length - 1] || "";
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Heuristic Mode Detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Detect terminal mode from screen content.
   * Fast heuristic-based detection without LLM.
   */
  private detectModeHeuristic(
    capture: string,
    lastLine: string
  ): "shell" | "repl" | "tui" | "unknown" {
    const trimmed = lastLine.trim();

    // Node REPL (but not Claude Code)
    if (trimmed === ">" && !capture.includes("Claude")) {
      return "repl";
    }

    // Shell prompt indicators
    if (trimmed.endsWith("$") || trimmed.endsWith("#") || trimmed.endsWith("%")) {
      return "shell";
    }
    if (/[❯λ➜>]\s*$/.test(trimmed)) {
      return "shell";
    }

    // Python REPL
    if (trimmed.startsWith(">>>") || trimmed.startsWith("...")) {
      return "repl";
    }

    // IPython
    if (/^In \[\d+\]:/.test(trimmed)) {
      return "repl";
    }

    // Claude Code TUI
    if (capture.includes("╭") && capture.includes("╰")) {
      return "tui";
    }
    if (capture.includes("Claude") && capture.includes("───")) {
      return "tui";
    }

    // Vim/editor
    if (capture.includes("~") && /^\s*\d+\s/.test(capture)) {
      return "tui";
    }

    return "unknown";
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Change Detection
  // ─────────────────────────────────────────────────────────────────────────────

  private async detectStateChange(
    sessionId: string,
    currentCapture: string,
    currentHash: string,
    currentLastLine: string,
    currentModeHint: "shell" | "repl" | "tui" | "unknown"
  ): Promise<{ changed: boolean; details?: StateChangeDetails }> {
    // Get last snapshot from DB
    const session = await db.query.terminalSessionTable.findFirst({
      where: eq(terminalSessionTable.sessionId, sessionId),
      columns: { stateSnapshot: true },
    });

    const lastSnapshot = session?.stateSnapshot as TerminalStateSnapshot | null;

    if (!lastSnapshot) {
      // First check - no comparison possible
      return { changed: false };
    }

    // Quick check: identical hash means no change
    if (currentHash === lastSnapshot.screenHash) {
      return { changed: false };
    }

    // Hash changed - check if it's significant
    const modeChanged = currentModeHint !== lastSnapshot.detectedMode;
    const lastLineChanged = currentLastLine !== lastSnapshot.lastLine;

    // Only report change if mode or prompt changed
    if (!modeChanged && !lastLineChanged) {
      return { changed: false };
    }

    return {
      changed: true,
      details: {
        previousMode: lastSnapshot.detectedMode,
        previousProgram: lastSnapshot.detectedProgram,
        previousLastLine: lastSnapshot.lastLine,
        currentCapture,
        currentLastLine,
        currentModeHint,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LLM Summary Generation
  // ─────────────────────────────────────────────────────────────────────────────

  private async generateSummary(details: StateChangeDetails): Promise<string> {
    const prompt = `You are summarizing terminal state changes for an AI agent.

Previous state: ${details.previousMode} mode${details.previousProgram ? ` (${details.previousProgram})` : ""}
Previous prompt: "${details.previousLastLine}"

Current terminal (last 20 lines):
\`\`\`
${details.currentCapture.split("\n").slice(-20).join("\n")}
\`\`\`

Write ONE brief sentence describing what changed. Focus on what the agent needs to know.

Examples:
- "Claude Code has exited and the terminal shows a shell prompt."
- "The Python REPL is still running."
- "A new shell session started in ~/project."`;

    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: prompt }] },
    ];

    const modelConfig: ModelConfig = {
      model: providerRegistry.resolveModelAlias(SUMMARY_MODEL),
      maxOutputTokens: 100,
    };

    try {
      const provider = providerRegistry.getProviderForModel(SUMMARY_MODEL);
      const response = await provider.invokeSync!(messages, [], modelConfig);

      // Extract text from response
      const textBlock = response.content.find((b) => b.type === "text");
      const text = textBlock && "text" in textBlock ? textBlock.text : "";
      return text.trim() || "Terminal state changed.";
    } catch (err) {
      this.logger.warn({ err }, "LLM summary generation failed, using fallback");
      return this.generateFallbackSummary(details);
    }
  }

  private generateFallbackSummary(details: StateChangeDetails): string {
    const { previousMode, currentModeHint } = details;

    if (previousMode === "repl" && currentModeHint === "shell") {
      return "The interactive program has exited. Terminal shows a shell prompt.";
    }
    if (previousMode === "tui" && currentModeHint === "shell") {
      return "The TUI application has exited. Terminal shows a shell prompt.";
    }
    if (previousMode === "shell" && currentModeHint === "repl") {
      return "An interactive program is now running.";
    }
    if (previousMode === "shell" && currentModeHint === "tui") {
      return "A TUI application is now running.";
    }

    return "Terminal state has changed.";
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Injection
  // ─────────────────────────────────────────────────────────────────────────────

  private async insertContextMessage(
    threadId: string,
    summary: string,
    details: StateChangeDetails,
    ownerUserId?: string | null,
  ): Promise<void> {
    await db.insert(messageTable).values({
      clientId: generateMessageClientId(),
      threadId,
      role: "system",
      displayRole: "Terminal Status",
      content: summary,
      createdByUserId: ownerUserId ?? undefined,
      metadata: {
        type: "context_sync",
        previousMode: details.previousMode,
        currentMode: details.currentModeHint,
        automated: true,
      },
      // Timestamp slightly before "now" to sort before user message
      createdAt: new Date(Date.now() - 100),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Snapshot Management
  // ─────────────────────────────────────────────────────────────────────────────

  private async updateSnapshot(
    sessionId: string,
    hash: string,
    lastLine: string,
    mode: "shell" | "repl" | "tui" | "unknown",
    program: string | null
  ): Promise<void> {
    const snapshot = {
      screenHash: hash,
      lastLine,
      detectedMode: mode,
      detectedProgram: program,
      capturedAt: new Date().toISOString(),
    };

    await db
      .update(terminalSessionTable)
      .set({ stateSnapshot: snapshot })
      .where(eq(terminalSessionTable.sessionId, sessionId));
  }
}
