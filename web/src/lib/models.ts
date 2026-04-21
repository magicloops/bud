import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/transport'

export type ModelInfo = {
  id: string
  provider: string
  display_name: string
  capabilities: {
    vision: boolean
    tools: boolean
    streaming: boolean
    reasoning: boolean
    thinking: boolean
  }
  is_alias?: boolean
  alias_target?: string
}

type ModelsResponse = {
  models: ModelInfo[]
  default_model?: string
}

export function useAvailableModels() {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')

  useEffect(() => {
    let cancelled = false

    apiFetch('/api/models')
      .then(async (response) => {
        if (!response.ok || cancelled) {
          return
        }

        const data = (await response.json()) as ModelsResponse
        const aliasModels = data.models.filter((model) => model.is_alias)
        const displayModels = aliasModels.length > 0 ? aliasModels : data.models

        if (cancelled) {
          return
        }

        setModels(displayModels)
        setSelectedModel((currentModel) => {
          if (currentModel) {
            return currentModel
          }

          const serverDefault = data.default_model
          const hasDefault = serverDefault && displayModels.some((model) => model.id === serverDefault)
          return hasDefault ? serverDefault : displayModels[0]?.id ?? ''
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
  }, [])

  return {
    models,
    selectedModel,
    setSelectedModel,
  }
}
