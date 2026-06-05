import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/transport'

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ReasoningOption = {
  value: ReasoningLevel
  label: string
}

export type ModelInfo = {
  id: string
  provider: string
  provider_model: string
  display_name: string
  is_default: boolean
  capabilities: {
    vision: boolean
    tools: boolean
    streaming: boolean
    structured_outputs: boolean
    context_window_tokens: number
    usable_context_window_tokens: number | null
    reserved_output_tokens: number | null
    usable_input_window_tokens: number | null
    max_output_tokens: number
  }
  reasoning: {
    kind:
      | 'openai_reasoning_effort'
      | 'anthropic_output_effort'
      | 'anthropic_thinking_budget'
      | 'ds4_responses_reasoning_effort'
      | 'none'
    levels: ReasoningOption[]
    default_level: ReasoningLevel
  }
  request_mode?: string
  compatibility?: string[]
  source?: {
    kind: 'service_local_dev' | 'bud_local'
    bud_id?: string
  }
}

type ModelsResponse = {
  models: ModelInfo[]
  service_default_model?: string | null
  default_model?: string | null
  default_reasoning_effort?: ReasoningLevel | null
}

export function getSelectedModelInfo(models: ModelInfo[], selectedModel: string): ModelInfo | null {
  return models.find((model) => model.id === selectedModel) ?? null
}

export function getReasoningOptionsForModel(
  models: ModelInfo[],
  selectedModel: string
): ReasoningOption[] {
  return getSelectedModelInfo(models, selectedModel)?.reasoning.levels ?? [{ value: 'none', label: 'Fast' }]
}

export function getDefaultReasoningForModel(
  models: ModelInfo[],
  selectedModel: string
): ReasoningLevel {
  return getSelectedModelInfo(models, selectedModel)?.reasoning.default_level ?? 'none'
}

export function normalizeReasoningForModel(
  models: ModelInfo[],
  selectedModel: string,
  currentReasoning: ReasoningLevel
): ReasoningLevel {
  const options = getReasoningOptionsForModel(models, selectedModel)
  if (options.some((option) => option.value === currentReasoning)) {
    return currentReasoning
  }
  return getDefaultReasoningForModel(models, selectedModel)
}

export function useAvailableModels(budId?: string | null) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [serviceDefaultModel, setServiceDefaultModel] = useState<string | null>(null)
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState<ReasoningLevel | null>(null)

  useEffect(() => {
    let cancelled = false

    const query = budId ? `?bud_id=${encodeURIComponent(budId)}` : ''

    apiFetch(`/api/models${query}`)
      .then(async (response) => {
        if (!response.ok || cancelled) {
          return
        }

        const data = (await response.json()) as ModelsResponse

        if (cancelled) {
          return
        }

        setModels(data.models)
        setServiceDefaultModel(data.service_default_model ?? null)
        setDefaultReasoningEffort(data.default_reasoning_effort ?? null)
        setSelectedModel((currentModel) => {
          if (currentModel && data.models.some((model) => model.id === currentModel)) {
            return currentModel
          }

          const serverDefault = data.default_model
          const hasDefault = serverDefault && data.models.some((model) => model.id === serverDefault)
          return hasDefault ? serverDefault : data.models[0]?.id ?? ''
        })
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Failed to fetch models', error)
        }
      })

    return () => {
      cancelled = true
    }
  }, [budId])

  return {
    models,
    selectedModel,
    setSelectedModel,
    serviceDefaultModel,
    defaultReasoningEffort,
  }
}
