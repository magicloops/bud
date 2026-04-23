const NOTIFICATION_BODY_LIMIT = 140;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit - 3)}...`;
}

export function buildNotificationTitle(threadTitle: string | null, budLabel: string): string {
  const trimmedThreadTitle = threadTitle?.trim();
  if (trimmedThreadTitle) {
    return trimmedThreadTitle;
  }

  const trimmedBudLabel = budLabel.trim();
  return trimmedBudLabel || "Bud";
}

export function buildAssistantPreviewBody(message: string): string {
  const normalized = message.trim().replace(/\s+/g, " ");
  return truncate(normalized || "Bud replied", NOTIFICATION_BODY_LIMIT);
}

export function buildGenericNotificationBody(kind: string): string {
  return kind === "human_input_requested" ? "Bud needs your input" : "Bud replied";
}
