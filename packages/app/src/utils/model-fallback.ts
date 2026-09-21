import { resolveModelFallback, type ModelFallbackConfig } from "@opencode-ai/core/model-fallback"

export type ModelIdentity = {
  providerID: string
  modelID: string
}

export function parseModelReference(value: string): ModelIdentity {
  const [providerID, ...rest] = value.split("/")
  return { providerID, modelID: rest.join("/") }
}

export function formatModelReference(model: ModelIdentity) {
  return `${model.providerID}/${model.modelID}`
}

export function sameModelIdentity(a: ModelIdentity, b: ModelIdentity) {
  return a.providerID === b.providerID && a.modelID === b.modelID
}

export function displayedFallbackForPrimary(
  primary: ModelIdentity | undefined,
  rawFallback: ModelFallbackConfig | null | undefined,
) {
  const fallback = resolveModelFallback(rawFallback)
  if (!fallback) return null
  if (primary && sameModelIdentity(primary, parseModelReference(fallback.model))) return null
  return fallback
}

export function shouldClearFallbackForPrimary(
  primary: ModelIdentity,
  rawFallback: ModelFallbackConfig | null | undefined,
) {
  const fallback = resolveModelFallback(rawFallback)
  return fallback !== null && sameModelIdentity(primary, parseModelReference(fallback.model))
}

export function fallbackForModelPair(input: {
  model: ModelIdentity
  variants: Record<string, unknown>
  variant: string | null | undefined
}): ModelFallbackConfig {
  return {
    model: formatModelReference(input.model),
    variant: input.variant && Object.hasOwn(input.variants, input.variant) ? input.variant : null,
  }
}

export function fallbackForModelSelection(input: {
  model: ModelIdentity
  variants: Record<string, unknown>
  rawFallback: ModelFallbackConfig | null | undefined
}): ModelFallbackConfig {
  const fallback = resolveModelFallback(input.rawFallback)
  return fallbackForModelPair({ model: input.model, variants: input.variants, variant: fallback?.variant ?? undefined })
}

export function filterFallbackModels<T extends { id: string; provider: { id: string } }>(
  models: T[],
  primary: ModelIdentity | undefined,
) {
  if (!primary) return models
  return models.filter((item) => !sameModelIdentity({ providerID: item.provider.id, modelID: item.id }, primary))
}
