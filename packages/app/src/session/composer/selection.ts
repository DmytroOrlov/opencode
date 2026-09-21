export function resolveSessionComposerSelection(
  info: { agent?: string; model?: { id: string; providerID: string; variant?: string } } | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  const model = metadata?.model

  const historical =
    model &&
    typeof model === "object" &&
    !Array.isArray(model) &&
    "providerID" in model &&
    "modelID" in model &&
    typeof model.providerID === "string" &&
    typeof model.modelID === "string"
      ? {
          providerID: model.providerID,
          modelID: model.modelID,
          variant: "variant" in model && typeof model.variant === "string" ? model.variant : undefined,
        }
      : undefined

  return {
    agent: info?.agent ?? (typeof metadata?.agent === "string" ? metadata.agent : undefined),
    model: info?.model
      ? { providerID: info.model.providerID, modelID: info.model.id, variant: info.model.variant }
      : historical,
  }
}

export type ComposerModelPair = {
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly variant?: string
}

export function swapModelPair(input: {
  readonly primary?: ComposerModelPair
  readonly fallback?: ComposerModelPair
  readonly primaryVariants: readonly string[]
  readonly fallbackVariants: readonly string[]
}) {
  if (!input.fallback) return
  const primaryVariant = input.fallback.variant && input.fallbackVariants.includes(input.fallback.variant)
    ? input.fallback.variant
    : undefined
  const fallbackVariant = input.primary?.variant && input.primaryVariants.includes(input.primary.variant)
    ? input.primary.variant
    : undefined
  return {
    primary: { model: input.fallback.model, variant: primaryVariant },
    fallback: input.primary ? { model: input.primary.model, variant: fallbackVariant } : null,
  }
}
