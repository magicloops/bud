# Phase 6: Prompt Guidance And Question Count

**Status**: Implemented
**Parent**: [implementation-spec.md](./implementation-spec.md)

---

## Objective

Tighten the `ask_user_questions` model guidance so agents use the structured tool instead of writing long markdown question lists, and remove the current hard five-question cap from the model-facing and service validation contracts.

This phase does not change the core pause/resume contract. `agent.tool_call`, `/agent/state.pending_tool`, response submission, and tool-result replay keep the same shapes.

## Current Problem

Testing shows a recurring failure mode: when the agent has many questions, it may respond with a markdown list instead of calling `ask_user_questions`.

Before this phase, the prompt contributed to this in two ways:

- it says to ask all currently needed questions in one `ask_user_questions` call
- the tool schema and service validator capped the request at five questions

When the model believes there are more than five questions to ask, markdown can look like the only valid way to ask them.

## Prompt Changes

Update `AGENT_SYSTEM_PROMPT` in `service/src/agent/conversation-loader.ts` with four additions:

1. Forbid markdown lists for multiple questions needed before proceeding.

   Suggested language:

   > Do not ask multiple questions as a markdown list. If you need the user to answer two or more questions before proceeding, use `ask_user_questions` unless the questions are only casual discussion.

2. Explain how to handle many possible questions without naming a numeric limit.

   Suggested language:

   > If you think you need many answers, ask the highest-leverage questions now, combine related questions, and defer lower-priority details until the answers reveal they are still needed. Never spill extra questions into markdown.

3. Narrow the normal-markdown exception.

   Suggested language:

   > A normal markdown question is only for exactly one simple freeform answer. For multiple questions, mixed question types, choices, approvals, deployment/configuration decisions, or anything needed before tool execution, use `ask_user_questions`.

4. Add a conversion rule for long prose question lists.

   Suggested language:

   > When you are tempted to write a long markdown checklist of questions, convert it into `ask_user_questions`: use concise labels, choice/boolean/number questions where possible, and put short shared context in `body` instead of repeating it in every question.

Do not add a numeric question-count recommendation to the prompt. The model should choose the appropriate number based on the task.

## Contract Changes

Remove the hard question-count ceiling from:

- `service/src/agent/model-runner.ts`
  - remove `maxItems: 5` from the `ask_user_questions.questions` tool schema
- `service/src/agent/user-question-contracts.ts`
  - remove `ASK_USER_QUESTIONS_MAX_QUESTIONS`
  - change the raw request schema from `.min(1).max(...)` to `.min(1)`

Keep these constraints:

- at least one question is still required
- labels, ids, choices, defaults, and answers are still normalized and validated
- every question remains skippable
- secret collection remains disallowed by prompt policy

## Test Updates

Update or add focused tests for:

- system prompt contains the new markdown-list avoidance guidance
- system prompt keeps the single-freeform markdown exception narrow
- model-facing `ask_user_questions` schema no longer advertises `maxItems`
- request normalization accepts more than five valid questions
- duplicate question ids and invalid choice/default/answer payloads still fail closed after the cap is removed

Verified with:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/conversation-loader.test.ts src/agent/model-runner.test.ts src/agent/user-question-contracts.test.ts
```

## Docs And Specs

Update these docs/specs when implementing:

- `service/src/agent/agent.spec.md`
- `plan/ask-question-tool/phase-1-service-contract-and-persistence.md`
- `plan/ask-question-tool/progress-checklist.md`
- `plan/ask-question-tool/validation-checklist.md`

The older Phase 1 "at most five questions" note is superseded by this phase.

## Acceptance Criteria

- [x] agents are explicitly told not to ask multiple questions in markdown
- [x] agents are told to convert long question checklists into `ask_user_questions`
- [x] prompt language does not advertise a numeric question limit
- [x] model-facing schema no longer includes `maxItems` for `questions`
- [x] service request normalization accepts more than five questions
- [x] tests cover the prompt and schema/normalization behavior
