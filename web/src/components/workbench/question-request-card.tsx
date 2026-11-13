import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Check, CircleSlash, MapPin, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PlacePinDialog } from '@/components/place-pin-editor'
import type {
  ApiAskUserQuestion,
  ApiAskUserQuestionSource,
  ApiAskUserQuestionsRequest,
  ApiAskUserQuestionsResponseInput,
} from '@/lib/api-types'
import { phonePermission, webAccessSteps, type DataSource, type DataSourcesDocument } from '@/lib/data-sources'
import { usePlaces } from '@/lib/places'
import { apiFetchJson } from '@/lib/transport'
import { formatPin, placeAnswer, placeErrorMessage, placeQuestionStart, placeQuestionTitle } from '@/lib/place-pin'
import { cn } from '@/lib/utils'
import {
  buildAskUserQuestionsResponseInput,
  buildInitialQuestionAnswers,
  buildSkippedQuestionAnswers,
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

  const updateAnswer = (questionId: string, answer: QuestionRequestAnswerState) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }))
  }

  const skipAll = () => {
    setAnswers(buildSkippedQuestionAnswers(request))
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled || isSubmitting) {
      return
    }
    setIsSubmitting(true)
    try {
      await onSubmit(buildAskUserQuestionsResponseInput(request, answers))
    } finally {
      setIsSubmitting(false)
    }
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
            disabled={disabled || isSubmitting}
            onChange={(answer) => updateAnswer(question.question_id, answer)}
          />
        ))}
      </div>

      {submitError && <div className="text-[11px] text-destructive">{placeErrorMessage(submitError)}</div>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {answeredCount} of {request.questions.length} answered
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || isSubmitting}
            onClick={skipAll}
            className="border-2 border-black text-[11px]"
          >
            <CircleSlash className="h-3.5 w-3.5" />
            {request.skip_all_label ?? 'Skip all'}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={disabled || isSubmitting}
            className="border-2 border-black text-[11px]"
            style={{ backgroundColor: 'var(--bud-accent-muted)', color: 'black' }}
          >
            {isSubmitting ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            {request.submit_label ?? 'Submit answers'}
          </Button>
        </div>
      </div>
    </form>
  )
}

function QuestionInput({
  question,
  value,
  disabled,
  onChange,
}: {
  question: ApiAskUserQuestion
  value: QuestionRequestAnswerState
  disabled: boolean
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
        <button
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
        </button>
      </div>
      {renderQuestionControl(question, value, onChange)}
    </fieldset>
  )
}

function renderQuestionControl(
  question: ApiAskUserQuestion,
  value: QuestionRequestAnswerState,
  onChange: (value: QuestionRequestAnswerState) => void,
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
    case 'source_access':
      return question.source ? <SourceAccessControl source={question.source} value={value} onChange={onChange} /> : null
    default:
      return (
        <div className="rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          Unsupported question type. It will be skipped.
        </div>
      )
  }
}

/**
 * A request for access to a data source. The agent's permission and the source's switch are
 * changed here, each by a click; iOS permission (and a fresh location reading) only on the phone,
 * where the same request shows as a card. The agent can't grant anything.
 */
function SourceAccessControl({ source, value, onChange }: {
  source: ApiAskUserQuestionSource
  value: QuestionRequestAnswerState
  onChange: (value: QuestionRequestAnswerState) => void
}) {
  const [entry, setEntry] = useState<DataSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    apiFetchJson<DataSourcesDocument>('/api/data/sources', { signal: controller.signal })
      .then(document => { if (!controller.signal.aborted) setEntry(document.sources.find(item => item.id === source.id) ?? null) })
      .catch(() => { if (!controller.signal.aborted) setMessage('Could not load this data source.') })
    return () => controller.abort()
  }, [source.id, reload])
  const steps = entry ? webAccessSteps(entry) : null
  const granted = value.answer?.kind === 'source_access' && value.answer.outcome === 'granted'
  const remaining = steps?.length
  useEffect(() => {
    // Nothing left that the web can see: the answer is "allowed"; the service checks it on submit.
    if (remaining === 0 && !granted) onChange({ status: 'answered', answer: { kind: 'source_access', outcome: 'granted' } })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onChange` is a new function each render; the answer is what matters
  }, [remaining, granted])
  const act = async (step: 'allow_agent' | 'turn_on') => {
    setBusy(true); setMessage('')
    try {
      if (step === 'turn_on') {
        await apiFetchJson(`/api/data/sources/${source.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }) })
      } else {
        const grant = await apiFetchJson<{ version: number; scopes: string[]; history_days: number }>('/api/data/agent-grant')
        const scope = `${source.id}.read`
        if (!grant.scopes.includes(scope)) {
          await apiFetchJson('/api/data/agent-grant', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: grant.version, scopes: [...grant.scopes, scope], history_days: grant.history_days }) })
        }
      }
    } catch { setMessage('That did not go through. Try again.') }
    finally { setBusy(false); setReload(count => count + 1) }
  }
  if (!entry || !steps) return <div className="text-[11px] text-muted-foreground">{message || 'Checking access…'}</div>
  const name = entry.label.toLowerCase()
  const step = steps[0]
  return (
    <div className="space-y-2 text-xs">
      {step === 'allow_agent' && <>
        <div className="text-muted-foreground">Your agent, and the model provider it uses, will be able to read your {name}.</div>
        <Button size="sm" disabled={busy} onClick={() => void act('allow_agent')}>Let my agent read {name}</Button>
      </>}
      {step === 'turn_on' && <>
        <div className="text-muted-foreground">Bud will collect {name} from your phone and keep it in your account.</div>
        <Button size="sm" disabled={busy} onClick={() => void act('turn_on')}>Turn on {entry.label}</Button>
      </>}
      {step === 'continue_on_phone' && <>
        <div>Continue on your iPhone: open Bud there and this request appears in the conversation, where iOS can ask for access.</div>
        {entry.installations.map((phone, index) => <div key={phone.installation_id} className="text-muted-foreground">
          Phone {index + 1}: {phonePermission(source.id, phone)}</div>)}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setReload(count => count + 1)}>Check again</Button>
      </>}
      {!step && <div className="text-muted-foreground">{entry.label} is on and your agent can read it.{source.id === 'location' ? ' For a fresh reading, answer from your phone.' : ''}</div>}
      {steps.length > 1 && <div className="text-[11px] text-muted-foreground">{steps.length} steps left</div>}
      {message && <div className="text-[11px] text-destructive">{message}</div>}
    </div>
  )
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
          {answer.name}{answer.address ? `, ${answer.address},` : ''} at {formatPin(answer)}
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
