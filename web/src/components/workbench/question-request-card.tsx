import { useMemo, useState, type FormEvent } from 'react'
import { MapPin } from 'lucide-react'
import { PlacePinDialog } from '@/components/place-pin-editor'
import type {
  ApiAskUserQuestion,
  ApiAskUserQuestionsRequest,
  ApiAskUserQuestionsResponseInput,
} from '@/lib/api-types'
import { usePlaces } from '@/lib/places'
import { placeAnswer, placeErrorMessage, placeQuestionStart, placeQuestionTitle } from '@/lib/place-pin'
import { cn } from '@/lib/utils'
import '@/components/settings-layout.css'
import {
  buildAskUserQuestionsResponseInput,
  buildInitialQuestionAnswers,
  buildSkippedQuestionAnswers,
  needsSkipConfirmation,
  submitsOnClick,
  type QuestionRequestAnswerState,
} from './question-request-response.ts'

type QuestionRequestCardProps = {
  request: ApiAskUserQuestionsRequest
  disabled?: boolean
  submitError?: string | null
  onSubmit: (response: ApiAskUserQuestionsResponseInput) => Promise<void> | void
}

export function QuestionRequestCard({
  request,
  disabled = false,
  submitError = null,
  onSubmit,
}: QuestionRequestCardProps) {
  const [answers, setAnswers] = useState<Record<string, QuestionRequestAnswerState>>(() =>
    buildInitialQuestionAnswers(request),
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  const answeredCount = useMemo(
    () => Object.values(answers).filter((answer) => answer.status === 'answered').length,
    [answers],
  )

  const [confirmingSkip, setConfirmingSkip] = useState(false)
  const single = request.questions.length === 1
  const answerOnClick = submitsOnClick(request)
  const blocked = disabled || isSubmitting

  const submit = async (next: Record<string, QuestionRequestAnswerState>) => {
    if (blocked) {
      return
    }
    setIsSubmitting(true)
    try {
      await onSubmit(buildAskUserQuestionsResponseInput(request, next))
    } finally {
      setIsSubmitting(false)
    }
  }

  const updateAnswer = (questionId: string, answer: QuestionRequestAnswerState) => {
    const next = { ...answers, [questionId]: answer }
    setAnswers(next)
    if (answerOnClick && answer.status === 'answered') void submit(next)
  }

  // Skipping everything sends the response; an important question asks first.
  const skipAll = (confirmed = false) => {
    if (!confirmed && needsSkipConfirmation(request)) {
      setConfirmingSkip(true)
      return
    }
    setConfirmingSkip(false)
    const skipped = buildSkippedQuestionAnswers(request)
    setAnswers(skipped)
    void submit(skipped)
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit(answers)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {(request.title || request.body) && (
        <div className="space-y-1">
          {request.title && <div className="text-sm font-semibold text-foreground">{request.title}</div>}
          {request.body && <p className="text-xs text-muted-foreground">{request.body}</p>}
        </div>
      )}

      <div className="space-y-3">
        {request.questions.map((question) => (
          <QuestionInput
            key={question.question_id}
            question={question}
            value={answers[question.question_id] ?? { status: 'skipped' }}
            disabled={blocked}
            single={single}
            answerOnClick={answerOnClick}
            onChange={(answer) => updateAnswer(question.question_id, answer)}
          />
        ))}
      </div>

      {submitError && <div className="text-[11px] text-destructive">{placeErrorMessage(submitError)}</div>}

      {confirmingSkip ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs" role="alertdialog" aria-label="Skip important questions">
          <span>
            {single
              ? 'This question was marked important. You can still skip it.'
              : 'One or more questions were marked important. You can still skip them.'}
          </span>
          <div className="flex items-center gap-3">
            <button type="button" className={quietButtonClass} onClick={() => setConfirmingSkip(false)}>Cancel</button>
            <button type="button" className="settings-action" disabled={blocked} onClick={() => skipAll(true)}>
              {single ? 'Skip' : 'Skip all'}
            </button>
          </div>
        </div>
      ) : (
        // The way out on the left, the answer on the right.
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button type="button" className={quietButtonClass} disabled={blocked} onClick={() => skipAll()}>
              {single ? 'Skip' : request.skip_all_label ?? 'Skip all'}
            </button>
            {!single && (
              <span className="text-[11px] text-muted-foreground">
                {answeredCount} of {request.questions.length} answered
              </span>
            )}
          </div>
          {isSubmitting && answerOnClick && <span className="text-[11px] text-muted-foreground">Sending…</span>}
          {!answerOnClick && (
            <button type="submit" className="settings-action" disabled={blocked}>
              {isSubmitting ? 'Sending…' : request.submit_label ?? 'Submit'}
            </button>
          )}
        </div>
      )}
    </form>
  )
}

const quietButtonClass = 'text-xs underline underline-offset-4 disabled:opacity-50'

function QuestionInput({
  question,
  value,
  disabled,
  single,
  answerOnClick,
  onChange,
}: {
  question: ApiAskUserQuestion
  value: QuestionRequestAnswerState
  disabled: boolean
  /** The only question: the footer's "Skip" is its way out. */
  single: boolean
  /** A click on an option sends the answer, so options are buttons. */
  answerOnClick: boolean
  onChange: (value: QuestionRequestAnswerState) => void
}) {
  const skipped = value.status === 'skipped'

  return (
    <fieldset className="space-y-2 rounded-md border border-border bg-background/60 p-3" disabled={disabled}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <legend className="text-xs font-semibold text-foreground">{question.label}</legend>
          {question.help_text && <p className="mt-0.5 text-[11px] text-muted-foreground">{question.help_text}</p>}
        </div>
        {!single && <button
          type="button"
          onClick={() => onChange({ status: 'skipped' })}
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
            skipped
              ? 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300'
              : 'border-border bg-card text-muted-foreground',
          )}
        >
          Skip
        </button>}
      </div>
      {renderQuestionControl(question, value, onChange, answerOnClick)}
    </fieldset>
  )
}

function renderQuestionControl(
  question: ApiAskUserQuestion,
  value: QuestionRequestAnswerState,
  onChange: (value: QuestionRequestAnswerState) => void,
  answerOnClick: boolean,
) {
  switch (question.kind) {
    case 'boolean':
      return (
        <div className="flex gap-2">
          {[true, false].map((option) => (
            <button
              key={String(option)}
              type="button"
              onClick={() => onChange({ status: 'answered', answer: { kind: 'boolean', value: option } })}
              className={choiceButtonClass(value.answer?.kind === 'boolean' && value.answer.value === option)}
            >
              {option ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      )
    case 'single_choice':
      if (answerOnClick) {
        return (
          <div className="grid gap-1.5">
            {(question.choices ?? []).map((choice) => (
              <button
                key={choice.choice_id}
                type="button"
                onClick={() => onChange({ status: 'answered', answer: { kind: 'single_choice', choice_id: choice.choice_id } })}
                className={cn(choiceButtonClass(value.answer?.kind === 'single_choice' && value.answer.choice_id === choice.choice_id), 'text-left')}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )
      }
      return (
        <div className="grid gap-1.5">
          {(question.choices ?? []).map((choice) => (
            <label key={choice.choice_id} className={choiceRowClass()}>
              <input
                type="radio"
                checked={value.answer?.kind === 'single_choice' && value.answer.choice_id === choice.choice_id}
                onChange={() => onChange({
                  status: 'answered',
                  answer: { kind: 'single_choice', choice_id: choice.choice_id },
                })}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      )
    case 'multi_choice': {
      const selected = value.answer?.kind === 'multi_choice' ? value.answer.choice_ids : []
      return (
        <div className="grid gap-1.5">
          {(question.choices ?? []).map((choice) => {
            const checked = selected.includes(choice.choice_id)
            return (
              <label key={choice.choice_id} className={choiceRowClass()}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? selected.filter((id) => id !== choice.choice_id)
                      : [...selected, choice.choice_id]
                    onChange(
                      next.length > 0
                        ? { status: 'answered', answer: { kind: 'multi_choice', choice_ids: next } }
                        : { status: 'skipped' },
                    )
                  }}
                />
                <span>{choice.label}</span>
              </label>
            )
          })}
        </div>
      )
    }
    case 'text': {
      const textValue = value.answer?.kind === 'text' ? value.answer.value : ''
      const handleTextChange = (next: string) => {
        onChange(next.length > 0
          ? { status: 'answered', answer: { kind: 'text', value: next } }
          : { status: 'skipped' })
      }
      return question.multiline ? (
        <textarea
          value={textValue}
          placeholder={question.placeholder}
          maxLength={question.max_length}
          onChange={(event) => {
            const next = event.currentTarget.value
            handleTextChange(next)
          }}
          className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
        />
      ) : (
        <input
          value={textValue}
          placeholder={question.placeholder}
          maxLength={question.max_length}
          onChange={(event) => {
            const next = event.currentTarget.value
            handleTextChange(next)
          }}
          className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
        />
      )
    }
    case 'number': {
      const numberValue = value.answer?.kind === 'number' ? String(value.answer.value) : ''
      return (
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={numberValue}
            min={question.min}
            max={question.max}
            step={question.step}
            onChange={(event) => {
              const raw = event.currentTarget.value
              const parsed = Number(raw)
              onChange(raw.length > 0 && Number.isFinite(parsed)
                ? { status: 'answered', answer: { kind: 'number', value: parsed } }
                : { status: 'skipped' })
            }}
            className="w-32 rounded-md border border-border bg-card px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
          />
          {question.unit && <span className="text-[11px] text-muted-foreground">{question.unit}</span>}
        </div>
      )
    }
    case 'place':
      return question.place
        ? <PlaceQuestionControl question={question} place={question.place} value={value} onChange={onChange} />
        : null
    default:
      return (
        <div className="rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          Unsupported question type. It will be skipped.
        </div>
      )
  }
}

/** A place to pin: the chosen pin, radius and name become the answer; the service saves it on submit. */
function PlaceQuestionControl({
  question,
  place,
  value,
  onChange,
}: {
  question: ApiAskUserQuestion
  place: NonNullable<ApiAskUserQuestion['place']>
  value: QuestionRequestAnswerState
  onChange: (value: QuestionRequestAnswerState) => void
}) {
  const [open, setOpen] = useState(false)
  const { places } = usePlaces(Boolean(place.place_id))
  const existing = places?.find((saved) => saved.id === place.place_id)
  const answer = value.answer?.kind === 'place' ? value.answer : null
  const start = answer
    ? { name: answer.name, center: { lat: answer.latitude, lon: answer.longitude }, radius: answer.radius_m, address: answer.address ?? '',
      ...(place.query ? { query: place.query } : {}) }
    : placeQuestionStart(place, existing)
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground">
      <MapPin className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div>{placeQuestionTitle(place, existing)}</div>
        {answer && <div className="text-[11px] text-muted-foreground">
          {answer.name} · {answer.address || 'Pin chosen on the map'}
        </div>}
        {place.place_id && places && !existing && (
          <div className="text-[11px] text-muted-foreground">That place no longer exists. Skip, or ask for a new one.</div>
        )}
      </div>
      <button
        type="button"
        disabled={Boolean(place.place_id) && !places}
        onClick={() => setOpen(true)}
        className={choiceButtonClass(false)}
      >
        {answer ? 'Change pin' : 'Choose on map'}
      </button>
      {open && (
        <PlacePinDialog
          title={question.label}
          start={start}
          existing={Boolean(existing)}
          saveLabel="Use this pin"
          onSave={(pin) => {
            onChange({ status: 'answered', answer: placeAnswer(pin) })
            setOpen(false)
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function choiceButtonClass(active: boolean) {
  return cn(
    'rounded-md border px-3 py-1.5 text-xs font-medium transition',
    active
      ? 'border-black bg-foreground text-background'
      : 'border-border bg-card text-foreground hover:bg-muted',
  )
}

function choiceRowClass() {
  return 'flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground'
}
