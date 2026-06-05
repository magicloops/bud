export type AgentRuntimeFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

const FALLBACK_CODE = "AGENT_FAILED";

const RETRYABLE_CODES = new Set([
  "BUD_BUSY",
  "DATA_PLANE_STREAM_LIMIT_EXCEEDED",
  "LOCAL_LLM_CONNECT_FAILED",
  "LOCAL_LLM_OPEN_IDLE_TIMEOUT",
  "LOCAL_LLM_RESPONSE_IDLE_TIMEOUT",
]);

const NON_RETRYABLE_CODES = new Set([
  "LOCAL_LLM_NOT_CONFIGURED",
  "LOCAL_LLM_REQUEST_TOO_LARGE",
  "LOCAL_LLM_RESPONSE_TOO_LARGE",
]);

export function formatAgentRuntimeFailure(error: unknown): AgentRuntimeFailure {
  const code = extractErrorCode(error);
  const retryable = extractRetryable(error, code);
  const message = `${messageForCode(code)}\n\nError: ${code}`;

  return {
    code,
    retryable,
    message,
  };
}

function extractErrorCode(error: unknown): string {
  const rawCode = readStringProperty(error, "code");
  if (rawCode) {
    return normalizeErrorCode(rawCode);
  }

  const message = readErrorMessage(error).toLowerCase();
  if (message.includes("active local_llm_http stream")) {
    return "DATA_PLANE_STREAM_LIMIT_EXCEEDED";
  }
  if (message.includes("local llm response was idle") || message.includes("response_idle_timeout")) {
    return "LOCAL_LLM_RESPONSE_IDLE_TIMEOUT";
  }
  if (message.includes("local llm open") && message.includes("timeout")) {
    return "LOCAL_LLM_OPEN_IDLE_TIMEOUT";
  }
  if (message.includes("local llm") && message.includes("not configured")) {
    return "LOCAL_LLM_NOT_CONFIGURED";
  }
  if (message.includes("local llm") && (message.includes("connect") || message.includes("unavailable"))) {
    return "LOCAL_LLM_CONNECT_FAILED";
  }

  return FALLBACK_CODE;
}

function extractRetryable(error: unknown, code: string): boolean {
  const retryable = readBooleanProperty(error, "retryable");
  if (retryable !== null) {
    return retryable;
  }
  if (RETRYABLE_CODES.has(code)) {
    return true;
  }
  if (NON_RETRYABLE_CODES.has(code)) {
    return false;
  }
  return false;
}

function messageForCode(code: string): string {
  if (code === "DATA_PLANE_STREAM_LIMIT_EXCEEDED" || code === "BUD_BUSY") {
    return "The local model is already busy. Try again after the current run finishes.";
  }
  if (code === "LOCAL_LLM_RESPONSE_IDLE_TIMEOUT" || code === "LOCAL_LLM_OPEN_IDLE_TIMEOUT") {
    return "The local model stopped streaming for too long. Try again with a shorter request.";
  }
  if (code === "LOCAL_LLM_CONNECT_FAILED" || code === "LOCAL_LLM_NOT_CONFIGURED") {
    return "The local model is unavailable. Check that it is running on the Bud machine.";
  }
  return "Bud could not complete this turn. Try again.";
}

function normalizeErrorCode(code: string): string {
  const normalized = code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized.slice(0, 80) : FALLBACK_CODE;
}

function readStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function readBooleanProperty(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}
