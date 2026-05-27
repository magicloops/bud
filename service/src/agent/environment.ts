export type AgentEnvironmentMode = "normal" | "bud_offline";

export type AgentToolAvailability = "available" | "unavailable";

export type AgentEnvironmentTools = {
  terminal: AgentToolAvailability;
  web_view: AgentToolAvailability;
  ask_user_questions: AgentToolAvailability;
};

export type AgentEnvironmentSnapshot = {
  mode: AgentEnvironmentMode;
  bud_id: string;
  bud_status: "online" | "offline";
  reason: "bud_disconnected" | null;
  last_seen_at: string | null;
  tools: AgentEnvironmentTools;
};

export function buildAgentEnvironmentSnapshot(args: {
  budId: string;
  online: boolean;
  lastSeenAt?: Date | null;
}): AgentEnvironmentSnapshot {
  const mode: AgentEnvironmentMode = args.online ? "normal" : "bud_offline";
  return {
    mode,
    bud_id: args.budId,
    bud_status: args.online ? "online" : "offline",
    reason: args.online ? null : "bud_disconnected",
    last_seen_at: args.lastSeenAt?.toISOString() ?? null,
    tools: buildAgentEnvironmentTools(mode),
  };
}

export function buildAgentEnvironmentTools(
  mode: AgentEnvironmentMode,
): AgentEnvironmentTools {
  const budToolsAvailable = mode === "normal" ? "available" : "unavailable";
  return {
    terminal: budToolsAvailable,
    web_view: budToolsAvailable,
    ask_user_questions: "available",
  };
}

export function buildAgentEnvironmentInstruction(
  environment: AgentEnvironmentSnapshot,
): string | null {
  if (environment.mode !== "bud_offline") {
    return null;
  }

  return [
    "The selected Bud is currently offline.",
    "You cannot inspect terminal state, run commands, open local web views, read files from the Bud, or use proxy features while it is offline.",
    "You may still use available non-device tools, including asking the user structured questions.",
    "Do not claim to have used the Bud or observed current device state.",
    "If the user asks for device work, explain that Bud tools are unavailable and help them reconnect or describe what you would do once the Bud is online.",
    "If the request does not require the Bud, answer normally.",
  ].join(" ");
}
