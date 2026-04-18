import { createHash } from "node:crypto";
import type { TerminalContext } from "../../terminal/types.js";
import { config } from "../../config.js";

export function summarizeContextForLog(context: TerminalContext): Record<string, unknown> {
  return {
    mode: context.mode,
    program: context.program ?? null,
    programDisplayName: context.programDisplayName ?? null,
    interactionStyle: context.interactionStyle ?? null,
    pendingCommand: context.pendingCommand?.command ?? null,
    pendingSource: context.pendingCommand?.source ?? null
  };
}

export function summarizeObservedOutput(output: string): Record<string, unknown> {
  const lines = output.length === 0 ? [] : output.split(/\r?\n/);
  let lastNonEmptyLine = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] && lines[index].trim().length > 0) {
      lastNonEmptyLine = lines[index];
      break;
    }
  }
  if (!lastNonEmptyLine && lines.length > 0) {
    lastNonEmptyLine = lines[lines.length - 1] ?? "";
  }
  const summary: Record<string, unknown> = {
    screenHash: createHash("sha256").update(output).digest("hex").slice(0, 16),
    lineCount: lines.length,
    lastNonEmptyLine: truncateForLog(lastNonEmptyLine)
  };

  if (config.agentDebug) {
    summary.firstLines = lines.slice(0, 2).map((line) => truncateForLog(line));
    summary.lastLines = lines.slice(-2).map((line) => truncateForLog(line));
  }

  return summary;
}

export function truncateForLog(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

