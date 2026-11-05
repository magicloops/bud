import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
  buildAskUserQuestionsToolResult,
  normalizeAskUserQuestionsRequest,
  validateAskUserQuestionsResponse,
} from "./user-question-contracts.js";

test("normalizes mixed ask_user_questions requests and validates answers", () => {
  const request = normalizeAskUserQuestionsRequest({
    title: "Deploy",
    questions: [
      {
        question_id: "env",
        kind: "single_choice",
        label: "Environment?",
        choices: [
          { choice_id: "staging", label: "Staging" },
          { choice_id: "prod", label: "Production" },
        ],
      },
      {
        question_id: "notify",
        kind: "boolean",
        label: "Notify team?",
      },
      {
        question_id: "notes",
        kind: "text",
        label: "Notes",
      },
    ],
  });

  assert.equal(request.schema, "ask_user_questions_request_v1");
  assert.equal(request.questions[0]?.skippable, true);

  const response = validateAskUserQuestionsResponse(
    {
      schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
      client_response_id: "018f4f2a-0000-7000-9000-000000000000",
      answers: [
        {
          question_id: "env",
          status: "answered",
          answer: { kind: "single_choice", choice_id: "staging" },
        },
        {
          question_id: "notify",
          status: "answered",
          answer: { kind: "boolean", value: true },
        },
      ],
    },
    request,
  );

  assert.equal(response.answers.length, 3);
  assert.equal(response.answers[2]?.status, "skipped");

  const result = buildAskUserQuestionsToolResult(request, response, "qr_01TEST");
  assert.equal(result.schema, "ask_user_questions_tool_result_v1");
  assert.equal(result.responses[0]?.question.label, "Environment?");
  assert.equal(result.responses[0]?.display_answer, "Staging");
  assert.match(result.summary_markdown, /1\. Environment\?/);
});

test("normalizes OpenAI strict-mode null optional fields as omitted", () => {
  const request = normalizeAskUserQuestionsRequest({
    title: null,
    body: null,
    submit_label: null,
    skip_all_label: null,
    questions: [
      {
        question_id: "env",
        kind: "single_choice",
        label: "Environment?",
        help_text: null,
        importance: null,
        choices: [
          {
            choice_id: "staging",
            label: "Staging",
            description: null,
          },
        ],
        default_answer: null,
        multiline: null,
        placeholder: null,
        min_length: null,
        max_length: null,
        min: null,
        max: null,
        step: null,
        unit: null,
      },
    ],
  });

  assert.equal(request.title, undefined);
  assert.equal(request.questions[0]?.help_text, undefined);
  assert.equal(request.questions[0]?.choices?.[0]?.description, undefined);
  assert.equal(request.questions[0]?.default_answer, undefined);
});

test("normalizes more than five questions", () => {
  const request = normalizeAskUserQuestionsRequest({
    title: "Setup details",
    questions: Array.from({ length: 8 }, (_value, index) => ({
      question_id: `question_${index + 1}`,
      kind: "boolean",
      label: `Question ${index + 1}?`,
    })),
  });

  assert.equal(request.questions.length, 8);
  assert.equal(request.questions[7]?.question_id, "question_8");
  assert.equal(request.questions[7]?.skippable, true);
});

test("rejects duplicate question ids and wrong answer kinds", () => {
  assert.throws(
    () =>
      normalizeAskUserQuestionsRequest({
        questions: [
          { question_id: "same", kind: "boolean", label: "First?" },
          { question_id: "same", kind: "boolean", label: "Second?" },
        ],
      }),
    /Duplicate question_id/,
  );

  const request = normalizeAskUserQuestionsRequest({
    questions: [{ question_id: "count", kind: "number", label: "How many?" }],
  });

  assert.throws(
    () =>
      validateAskUserQuestionsResponse(
        {
          schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
          client_response_id: "018f4f2a-0000-7000-9000-000000000001",
          answers: [
            {
              question_id: "count",
              status: "answered",
              answer: { kind: "text", value: "many" },
            },
          ],
        },
        request,
      ),
    /does not match question kind/,
  );
});

test("place questions carry what the picker starts from, and answers are the user's pin", () => {
  const request = normalizeAskUserQuestionsRequest({
    title: "Save your places",
    questions: [
      { question_id: "home", kind: "place", label: "Where's home?", place: { name: "Home", query: "3327 26th St, San Francisco", place_id: null, radius_m: null } },
      { question_id: "office", kind: "place", label: "Move the office pin", place: { name: "Office", place_id: "01M5DV10ZNSFWHYS34RCZ6F1PR" } },
      { question_id: "gym", kind: "place", label: "Your gym", place: { name: "Gym", radius_m: 300 } },
    ],
  });
  // A new place defaults to 100 m; a move keeps the place's own radius unless one is suggested.
  assert.deepEqual(request.questions.map(question => question.place), [
    { name: "Home", query: "3327 26th St, San Francisco", radius_m: 100 },
    { name: "Office", place_id: "01M5DV10ZNSFWHYS34RCZ6F1PR" },
    { name: "Gym", radius_m: 300 },
  ]);
  for (const place of [undefined, { name: "" }, { name: "Home", radius_m: 20 }, { name: "Home", place_id: "office" }])
    assert.throws(() => normalizeAskUserQuestionsRequest({ questions: [{ kind: "place", label: "Where?", place }] }));
  assert.throws(() => normalizeAskUserQuestionsRequest({ questions: [{ kind: "place", label: "Where?", place: { name: "Home" },
    default_answer: { kind: "place", name: "Home", latitude: 1, longitude: 2, radius_m: 100 } }] }), { code: "invalid_default_answer" });

  const pin = { kind: "place" as const, name: "Home", latitude: 37.749003, longitude: -122.416487, radius_m: 50 };
  const response = validateAskUserQuestionsResponse({
    schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
    client_response_id: "018f4f2a-0000-7000-9000-000000000001",
    // A client can't name the saved place: the service adds it once it has saved the pin.
    answers: [{ question_id: "home", status: "answered", answer: { ...pin, place_id: "01M5DV10ZNSFWHYS34RCZ6F1PR" } },
      { question_id: "office", status: "skipped" }],
  }, request);
  assert.deepEqual(response.answers[0].answer, pin);
  for (const bad of [{ radius_m: 49 }, { radius_m: 2001 }, { latitude: 91 }, { name: "" }])
    assert.throws(() => validateAskUserQuestionsResponse({ schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
      client_response_id: "018f4f2a-0000-7000-9000-000000000002", answers: [{ question_id: "home", status: "answered", answer: { ...pin, ...bad } }] }, request));

  const saved = { ...response, answers: [{ ...response.answers[0], answer: { ...pin, place_id: "01M6PLACE0000000000000000A", operation: "created" as const } },
    ...response.answers.slice(1)] };
  const result = buildAskUserQuestionsToolResult(request, saved, "qr_place");
  assert.deepEqual(result.responses[0].question.place, request.questions[0].place);
  assert.equal(result.responses[0].display_answer, "Saved Home at 37.749003, -122.416487 with a 50 m radius");
  assert.equal((result.responses[0].answer as { place_id?: string }).place_id, "01M6PLACE0000000000000000A");
});
