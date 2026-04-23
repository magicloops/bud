export type MessageWatermark = {
  messageId: string | null;
  createdAt: Date | null;
};

export type ThreadAttentionState = {
  lastAttentionMessageId: string | null;
  lastAttentionMessageCreatedAt: Date | null;
  lastSeenMessageId: string | null;
  lastSeenMessageCreatedAt: Date | null;
};

export function compareMessageTuple(
  leftCreatedAt: Date | null,
  leftMessageId: string | null,
  rightCreatedAt: Date | null,
  rightMessageId: string | null,
): number {
  if (!leftCreatedAt || !leftMessageId) {
    return rightCreatedAt && rightMessageId ? -1 : 0;
  }
  if (!rightCreatedAt || !rightMessageId) {
    return 1;
  }

  const timeDiff = leftCreatedAt.getTime() - rightCreatedAt.getTime();
  if (timeDiff !== 0) {
    return timeDiff > 0 ? 1 : -1;
  }

  if (leftMessageId === rightMessageId) {
    return 0;
  }

  return leftMessageId > rightMessageId ? 1 : -1;
}

export function isMessageNewerThanWatermark(
  messageCreatedAt: Date | null,
  messageId: string | null,
  watermark: MessageWatermark,
): boolean {
  return compareMessageTuple(
    messageCreatedAt,
    messageId,
    watermark.createdAt,
    watermark.messageId,
  ) > 0;
}

export function hasUnseenAttention(state: ThreadAttentionState): boolean {
  return isMessageNewerThanWatermark(
    state.lastAttentionMessageCreatedAt,
    state.lastAttentionMessageId,
    {
      createdAt: state.lastSeenMessageCreatedAt,
      messageId: state.lastSeenMessageId,
    },
  );
}

export function countUnseenThreads(states: ThreadAttentionState[]): number {
  return states.reduce((count, state) => count + (hasUnseenAttention(state) ? 1 : 0), 0);
}
