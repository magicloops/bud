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

test("source_access questions name a source, and the client only says what the user did", () => {
  const request = normalizeAskUserQuestionsRequest({ questions: [
    { question_id: "where", kind: "source_access", label: "To tell you where you are", source: { id: "location", level: null } },
    { question_id: "sleep", kind: "source_access", label: "To review your sleep", source: { id: "health" } }] });
  assert.deepEqual(request.questions.map(question => question.source), [{ id: "location" }, { id: "health" }]);
  assert.throws(() => normalizeAskUserQuestionsRequest({ questions: [{ kind: "source_access", label: "Location" }] }), /require a source/);
  assert.throws(() => normalizeAskUserQuestionsRequest({ questions: [
    { kind: "source_access", label: "Health", source: { id: "health", level: "always" } }] }), /location only/);
  assert.throws(() => normalizeAskUserQuestionsRequest({ questions: [
    { kind: "source_access", label: "Location", source: { id: "location" }, default_answer: { kind: "source_access", outcome: "granted" } }] }),
    /can't have a default answer/);
  assert.throws(() => normalizeAskUserQuestionsRequest({ questions: [{ kind: "source_access", label: "Photos", source: { id: "photos" } }] }));

  const respond = (answer: unknown) => validateAskUserQuestionsResponse({ schema: "ask_user_questions_response_v1",
    client_response_id: "11111111-1111-4111-8111-111111111111", answers: [{ question_id: "where", status: "answered", answer }] }, request);
  const response = respond({ kind: "source_access", outcome: "granted", reading_event_id: "event-1" });
  assert.deepEqual(response.answers[0].answer, { kind: "source_access", outcome: "granted", reading_event_id: "event-1" });
  assert.equal(response.answers[1].status, "skipped", "an unanswered source question is skipped, like any other");
  // State is the service's to add: a client can't claim it.
  assert.deepEqual(respond({ kind: "source_access", outcome: "granted", enabled: true, agent_allowed: true, usable: true }).answers[0].answer,
    { kind: "source_access", outcome: "granted" });
  assert.throws(() => respond({ kind: "source_access", outcome: "allowed" }));

  const told = (answer: Record<string, unknown>) => buildAskUserQuestionsToolResult(request, { ...response,
    answers: [{ question_id: "where", status: "answered", answer: { kind: "source_access", ...answer } as never }] }, "qr_1").responses[0];
  assert.deepEqual(told({ outcome: "granted", usable: true }).question.source, { id: "location" });
  assert.match(told({ outcome: "granted", usable: true, enabled: true, agent_allowed: true, permission: "granted", level: "while_using",
    reading: "received" }).display_answer!, /^Location is on and readable\. iOS permission: granted \(while using\)\. A fresh reading was just received/);
  assert.match(told({ outcome: "granted", usable: false, enabled: false }).display_answer!, /still not readable: the source is off/);
  assert.match(told({ outcome: "granted", usable: false, enabled: true, agent_allowed: false }).display_answer!, /the agent isn't allowed/);
  assert.match(told({ outcome: "declined" }).display_answer!, /^Declined\. Location access was not changed/);
  assert.match(told({ outcome: "unavailable" }).display_answer!, /can't be allowed on this device/);
});

test("a declined source holds for the conversation: skips become declines and repeat requests are answered without a card", async () => {
  const { declineSkippedSources, declinedSourcesIn, refuseDeclinedSources, buildAskUserQuestionsToolResult: result } = await import("./user-question-contracts.js");
  const request = normalizeAskUserQuestionsRequest({ questions: [
    { question_id: "where", kind: "source_access", label: "To tell you where you are", source: { id: "location" } },
    { question_id: "sure", kind: "boolean", label: "Continue?" }] });
  const skipped = { schema: "ask_user_questions_response_v1" as const, client_response_id: "018f4f2a-0000-7000-9000-000000000001",
    answers: [{ question_id: "where", status: "skipped" as const, skip_reason: "user_skipped" as const },
      { question_id: "sure", status: "skipped" as const, skip_reason: "user_skipped" as const }] };
  // The user's skip of a source question is a decline; other questions stay skipped.
  assert.deepEqual(declineSkippedSources(request, skipped).answers, [
    { question_id: "where", status: "answered", answer: { kind: "source_access", outcome: "declined" } }, skipped.answers[1]]);
  // Not a user's skip (the service marks those it can't ask): left alone.
  const unasked = { ...skipped, answers: [{ ...skipped.answers[0], skip_reason: "not_applicable" as const }, skipped.answers[1]] };
  assert.deepEqual(declineSkippedSources(request, unasked), unasked);

  // What a thread's stored answers say is declined: the latest answer per source, oldest row first.
  const row = (turnId: string, source: string, outcome: string) => ({ turnId, response: { answers: [
    { answer: { kind: "source_access", outcome, source } }, { status: "skipped" }] } });
  assert.deepEqual(declinedSourcesIn([row("t1", "location", "declined"), row("t1", "health", "granted"), row("t2", "location", "declined"),
    { turnId: "t3", response: null }, { turnId: "t3", response: { answers: "x" } }]), [{ source: "location", turnId: "t2" }]);
  // Allowing it later lifts the decline; declining after a grant sets it.
  assert.deepEqual(declinedSourcesIn([row("t1", "location", "declined"), row("t2", "location", "granted")]), []);
  assert.deepEqual(declinedSourcesIn([row("t1", "health", "granted"), row("t2", "health", "declined")]), [{ source: "health", turnId: "t2" }]);

  // Asking again: no card. The declined source is answered declined, the rest are to be asked again.
  assert.equal(refuseDeclinedSources(request, ["health"], skipped.client_response_id), null);
  const refusal = refuseDeclinedSources(request, ["location"], skipped.client_response_id)!;
  assert.deepEqual(refusal.answers, [
    { question_id: "where", status: "answered", answer: { kind: "source_access", outcome: "declined", source: "location", asked: false } },
    { question_id: "sure", status: "skipped", skip_reason: "not_applicable" }]);
  const told = result(request, refusal, "qr_1");
  assert.match(told.responses[0].display_answer ?? "", /the user just declined Location/);
  assert.equal(told.responses[1].skip_reason, "not_applicable");
  // The refusal is itself a recorded decline.
  assert.deepEqual(declinedSourcesIn([{ turnId: "t1", response: refusal }]), [{ source: "location", turnId: "t1" }]);
});
