import { z } from "zod";

export const ASK_USER_QUESTIONS_TOOL = "ask_user_questions" as const;
export const ASK_USER_QUESTIONS_REQUEST_SCHEMA = "ask_user_questions_request_v1" as const;
export const ASK_USER_QUESTIONS_RESPONSE_SCHEMA = "ask_user_questions_response_v1" as const;
export const ASK_USER_QUESTIONS_TOOL_RESULT_SCHEMA = "ask_user_questions_tool_result_v1" as const;

const DEFAULT_TEXT_MAX_LENGTH = 4_000;

export type AskUserQuestionKind =
  | "boolean"
  | "single_choice"
  | "multi_choice"
  | "text"
  | "number";

export type AskUserQuestionImportance = "required" | "important" | "optional";
export type AskUserQuestionAnswerStatus = "answered" | "skipped";
export type AskUserQuestionSkipReason = "user_skipped" | "not_applicable" | "unknown";

export type AskUserQuestionChoice = {
  choice_id: string;
  label: string;
  description?: string;
};

export type AskUserQuestion = {
  question_id: string;
  kind: AskUserQuestionKind;
  label: string;
  help_text?: string;
  importance: AskUserQuestionImportance;
  skippable: true;
  choices?: AskUserQuestionChoice[];
  default_answer?: AskUserQuestionAnswer;
  multiline?: boolean;
  placeholder?: string;
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
};

export type AskUserQuestionsRequest = {
  schema: typeof ASK_USER_QUESTIONS_REQUEST_SCHEMA;
  request_id?: string;
  title?: string;
  body?: string;
  submit_label?: string;
  skip_all_label?: string;
  questions: AskUserQuestion[];
};

export type AskUserQuestionAnswer =
  | { kind: "boolean"; value: boolean }
  | { kind: "single_choice"; choice_id: string }
  | { kind: "multi_choice"; choice_ids: string[] }
  | { kind: "text"; value: string }
  | { kind: "number"; value: number };

export type AskUserQuestionResponseAnswer = {
  question_id: string;
  status: AskUserQuestionAnswerStatus;
  answer?: AskUserQuestionAnswer;
  skip_reason?: AskUserQuestionSkipReason;
};

export type AskUserQuestionsResponse = {
  schema: typeof ASK_USER_QUESTIONS_RESPONSE_SCHEMA;
  client_response_id: string;
  answers: AskUserQuestionResponseAnswer[];
};

export type AskUserQuestionsToolResultResponse = {
  question_id: string;
  question: {
    question_id: string;
    kind: AskUserQuestionKind;
    label: string;
    help_text?: string;
    choices?: AskUserQuestionChoice[];
  };
  status: AskUserQuestionAnswerStatus;
  answer?: AskUserQuestionAnswer;
  display_answer?: string;
  skip_reason?: AskUserQuestionSkipReason;
};

export type AskUserQuestionsToolResult = {
  schema: typeof ASK_USER_QUESTIONS_TOOL_RESULT_SCHEMA;
  request_id: string;
  title?: string;
  body?: string;
  responses: AskUserQuestionsToolResultResponse[];
  summary_markdown: string;
};

export class AskUserQuestionsContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AskUserQuestionsContractError";
    this.code = code;
  }
}

const RawChoiceSchema = z.object({
  choice_id: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
});

const RawQuestionSchema = z.object({
  question_id: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
  kind: z.enum(["boolean", "single_choice", "multi_choice", "text", "number"]),
  label: z.string().trim().min(1),
  help_text: z.string().trim().min(1).optional(),
  importance: z.enum(["required", "important", "optional"]).optional(),
  choices: z.array(RawChoiceSchema).optional(),
  default_answer: z.unknown().optional(),
  multiline: z.boolean().optional(),
  placeholder: z.string().trim().min(1).optional(),
  min_length: z.number().int().nonnegative().optional(),
  max_length: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  unit: z.string().trim().min(1).optional(),
});

const RawRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).optional(),
  submit_label: z.string().trim().min(1).optional(),
  skip_all_label: z.string().trim().min(1).optional(),
  questions: z.array(RawQuestionSchema).min(1),
});

const ClientAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  z.object({ kind: z.literal("single_choice"), choice_id: z.string().trim().min(1) }),
  z.object({
    kind: z.literal("multi_choice"),
    choice_ids: z.array(z.string().trim().min(1)).min(1),
  }),
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({ kind: z.literal("number"), value: z.number() }),
]);

const ClientResponseSchema = z.object({
  schema: z.literal(ASK_USER_QUESTIONS_RESPONSE_SCHEMA),
  client_response_id: z.string().uuid(),
  answers: z.array(z.object({
    question_id: z.string().trim().min(1),
    status: z.enum(["answered", "skipped"]),
    answer: ClientAnswerSchema.optional(),
    skip_reason: z.enum(["user_skipped", "not_applicable", "unknown"]).optional(),
  })),
});

export function normalizeAskUserQuestionsRequest(input: unknown): AskUserQuestionsRequest {
  const parsed = RawRequestSchema.safeParse(stripNullFields(input));
  if (!parsed.success) {
    throw new AskUserQuestionsContractError(
      "invalid_question_request",
      parsed.error.issues[0]?.message ?? "Invalid ask_user_questions request",
    );
  }

  const seenQuestionIds = new Set<string>();
  const questions = parsed.data.questions.map((question, index): AskUserQuestion => {
    const questionId = normalizeId(question.question_id ?? question.id ?? `q_${index + 1}`);
    if (seenQuestionIds.has(questionId)) {
      throw new AskUserQuestionsContractError(
        "duplicate_question_id",
        `Duplicate question_id: ${questionId}`,
      );
    }
    seenQuestionIds.add(questionId);

    const choices = normalizeChoices(question);
    const normalized: AskUserQuestion = {
      question_id: questionId,
      kind: question.kind,
      label: question.label.trim(),
      ...(question.help_text ? { help_text: question.help_text.trim() } : {}),
      importance: question.importance ?? "optional",
      skippable: true,
      ...(choices ? { choices } : {}),
      ...(question.multiline === true ? { multiline: true } : {}),
      ...(question.placeholder ? { placeholder: question.placeholder.trim() } : {}),
      ...(typeof question.min_length === "number" ? { min_length: question.min_length } : {}),
      max_length: question.max_length ?? (question.kind === "text" ? DEFAULT_TEXT_MAX_LENGTH : undefined),
      ...(typeof question.min === "number" ? { min: question.min } : {}),
      ...(typeof question.max === "number" ? { max: question.max } : {}),
      ...(typeof question.step === "number" ? { step: question.step } : {}),
      ...(question.unit ? { unit: question.unit.trim() } : {}),
    };

    if (question.default_answer !== undefined) {
      normalized.default_answer = validateAnswerForQuestion(
        normalized,
        question.default_answer,
        "invalid_default_answer",
      );
    }

    return removeUndefinedFields(normalized);
  });

  return removeUndefinedFields({
    schema: ASK_USER_QUESTIONS_REQUEST_SCHEMA,
    ...(parsed.data.title ? { title: parsed.data.title.trim() } : {}),
    ...(parsed.data.body ? { body: parsed.data.body.trim() } : {}),
    ...(parsed.data.submit_label ? { submit_label: parsed.data.submit_label.trim() } : {}),
    ...(parsed.data.skip_all_label ? { skip_all_label: parsed.data.skip_all_label.trim() } : {}),
    questions,
  });
}

export function attachRequestIdToAskUserQuestionsRequest(
  request: AskUserQuestionsRequest,
  requestId: string,
): AskUserQuestionsRequest {
  return {
    ...request,
    request_id: requestId,
  };
}

export function parseStoredAskUserQuestionsRequest(input: unknown): AskUserQuestionsRequest {
  const record = assertRecord(input, "invalid_stored_question_request");
  if (record.schema !== ASK_USER_QUESTIONS_REQUEST_SCHEMA) {
    throw new AskUserQuestionsContractError(
      "invalid_stored_question_request",
      "Stored question request has an unsupported schema",
    );
  }
  const request = normalizeAskUserQuestionsRequest({
    ...record,
    questions: record.questions,
  });
  return typeof record.request_id === "string" && record.request_id
    ? { ...request, request_id: record.request_id }
    : request;
}

export function validateAskUserQuestionsResponse(
  input: unknown,
  request: AskUserQuestionsRequest,
): AskUserQuestionsResponse {
  const parsed = ClientResponseSchema.safeParse(input);
  if (!parsed.success) {
    throw new AskUserQuestionsContractError(
      "invalid_question_response",
      parsed.error.issues[0]?.message ?? "Invalid ask_user_questions response",
    );
  }

  const answersByQuestion = new Map<string, AskUserQuestionResponseAnswer>();
  for (const answer of parsed.data.answers) {
    if (answersByQuestion.has(answer.question_id)) {
      throw new AskUserQuestionsContractError(
        "duplicate_answer",
        `Duplicate answer for question_id: ${answer.question_id}`,
      );
    }
    answersByQuestion.set(answer.question_id, answer as AskUserQuestionResponseAnswer);
  }

  const knownQuestionIds = new Set(request.questions.map((question) => question.question_id));
  for (const questionId of answersByQuestion.keys()) {
    if (!knownQuestionIds.has(questionId)) {
      throw new AskUserQuestionsContractError(
        "unknown_question_id",
        `Unknown question_id: ${questionId}`,
      );
    }
  }

  const normalizedAnswers = request.questions.map((question): AskUserQuestionResponseAnswer => {
    const answer = answersByQuestion.get(question.question_id);
    if (!answer || answer.status === "skipped") {
      return {
        question_id: question.question_id,
        status: "skipped",
        skip_reason: answer?.skip_reason ?? "user_skipped",
      };
    }

    if (!answer.answer) {
      throw new AskUserQuestionsContractError(
        "missing_answer",
        `Question ${question.question_id} is marked answered without an answer`,
      );
    }

    return {
      question_id: question.question_id,
      status: "answered",
      answer: validateAnswerForQuestion(question, answer.answer, "invalid_answer"),
    };
  });

  return {
    schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
    client_response_id: parsed.data.client_response_id,
    answers: normalizedAnswers,
  };
}

export function buildAskUserQuestionsToolResult(
  request: AskUserQuestionsRequest,
  response: AskUserQuestionsResponse,
  requestId: string,
): AskUserQuestionsToolResult {
  const answersByQuestion = new Map(response.answers.map((answer) => [answer.question_id, answer]));
  const responses = request.questions.map((question): AskUserQuestionsToolResultResponse => {
    const answer = answersByQuestion.get(question.question_id) ?? {
      question_id: question.question_id,
      status: "skipped" as const,
      skip_reason: "unknown" as const,
    };
    return removeUndefinedFields({
      question_id: question.question_id,
      question: removeUndefinedFields({
        question_id: question.question_id,
        kind: question.kind,
        label: question.label,
        help_text: question.help_text,
        choices: question.choices,
      }),
      status: answer.status,
      answer: answer.answer,
      display_answer: answer.answer ? formatAnswer(question, answer.answer) : undefined,
      skip_reason: answer.status === "skipped" ? answer.skip_reason ?? "user_skipped" : undefined,
    });
  });

  const result: AskUserQuestionsToolResult = removeUndefinedFields({
    schema: ASK_USER_QUESTIONS_TOOL_RESULT_SCHEMA,
    request_id: requestId,
    title: request.title,
    body: request.body,
    responses,
    summary_markdown: buildAskUserQuestionsSummaryMarkdown(request, responses),
  });
  return result;
}

export function buildAskUserQuestionsSummaryMarkdown(
  request: Pick<AskUserQuestionsRequest, "title" | "body">,
  responses: AskUserQuestionsToolResultResponse[],
): string {
  const lines: string[] = [];
  lines.push(request.title ? `Question response: ${request.title}` : "Question response");
  if (request.body) {
    lines.push("", request.body);
  }
  for (const [index, response] of responses.entries()) {
    lines.push("", `${index + 1}. ${response.question.label}`);
    if (response.status === "answered") {
      lines.push(`Answer: ${response.display_answer ?? "(answered)"}`);
    } else {
      lines.push(`Answer: skipped (${response.skip_reason ?? "user_skipped"})`);
    }
  }
  return lines.join("\n");
}

function normalizeChoices(question: z.infer<typeof RawQuestionSchema>): AskUserQuestionChoice[] | undefined {
  if (question.kind !== "single_choice" && question.kind !== "multi_choice") {
    return undefined;
  }

  if (!question.choices || question.choices.length === 0) {
    throw new AskUserQuestionsContractError(
      "missing_choices",
      `${question.kind} questions require at least one choice`,
    );
  }

  const seenChoiceIds = new Set<string>();
  return question.choices.map((choice, index) => {
    const choiceId = normalizeId(choice.choice_id ?? choice.id ?? `choice_${index + 1}`);
    if (seenChoiceIds.has(choiceId)) {
      throw new AskUserQuestionsContractError(
        "duplicate_choice_id",
        `Duplicate choice_id: ${choiceId}`,
      );
    }
    seenChoiceIds.add(choiceId);
    return removeUndefinedFields({
      choice_id: choiceId,
      label: choice.label.trim(),
      description: choice.description?.trim(),
    });
  });
}

function validateAnswerForQuestion(
  question: AskUserQuestion,
  input: unknown,
  errorCode: string,
): AskUserQuestionAnswer {
  const parsed = ClientAnswerSchema.safeParse(input);
  if (!parsed.success) {
    throw new AskUserQuestionsContractError(
      errorCode,
      parsed.error.issues[0]?.message ?? "Invalid answer",
    );
  }

  const answer = parsed.data;
  if (answer.kind !== question.kind) {
    throw new AskUserQuestionsContractError(
      errorCode,
      `Answer kind ${answer.kind} does not match question kind ${question.kind}`,
    );
  }

  if (answer.kind === "single_choice") {
    assertChoiceExists(question, answer.choice_id, errorCode);
  }
  if (answer.kind === "multi_choice") {
    const uniqueChoiceIds = new Set(answer.choice_ids);
    if (uniqueChoiceIds.size !== answer.choice_ids.length) {
      throw new AskUserQuestionsContractError(errorCode, "Duplicate multi_choice ids are not allowed");
    }
    for (const choiceId of answer.choice_ids) {
      assertChoiceExists(question, choiceId, errorCode);
    }
  }
  if (answer.kind === "text") {
    const minLength = question.min_length ?? 0;
    const maxLength = question.max_length ?? DEFAULT_TEXT_MAX_LENGTH;
    if (answer.value.length < minLength || answer.value.length > maxLength) {
      throw new AskUserQuestionsContractError(
        errorCode,
        `Text answer must be between ${minLength} and ${maxLength} characters`,
      );
    }
  }
  if (answer.kind === "number") {
    if (typeof question.min === "number" && answer.value < question.min) {
      throw new AskUserQuestionsContractError(errorCode, `Number answer must be >= ${question.min}`);
    }
    if (typeof question.max === "number" && answer.value > question.max) {
      throw new AskUserQuestionsContractError(errorCode, `Number answer must be <= ${question.max}`);
    }
  }

  return answer;
}

function assertChoiceExists(
  question: AskUserQuestion,
  choiceId: string,
  errorCode: string,
): void {
  if (!question.choices?.some((choice) => choice.choice_id === choiceId)) {
    throw new AskUserQuestionsContractError(
      errorCode,
      `Unknown choice_id ${choiceId} for question ${question.question_id}`,
    );
  }
}

function formatAnswer(question: AskUserQuestion, answer: AskUserQuestionAnswer): string {
  switch (answer.kind) {
    case "boolean":
      return answer.value ? "Yes" : "No";
    case "single_choice":
      return question.choices?.find((choice) => choice.choice_id === answer.choice_id)?.label
        ?? answer.choice_id;
    case "multi_choice":
      return answer.choice_ids
        .map((choiceId) => question.choices?.find((choice) => choice.choice_id === choiceId)?.label ?? choiceId)
        .join(", ");
    case "text":
      return answer.value;
    case "number":
      return `${answer.value}${question.unit ? ` ${question.unit}` : ""}`;
  }
}

function normalizeId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "question";
}

function assertRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AskUserQuestionsContractError(code, "Expected object");
  }
  return value as Record<string, unknown>;
}

function removeUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}

function stripNullFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNullFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== null)
      .map(([key, nested]) => [key, stripNullFields(nested)]),
  );
}
