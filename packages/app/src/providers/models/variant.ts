type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

// Only the presence of variants matters here.
type Model = AgentModel & {
  variants?: object
}

/** What a selection says about the variant: follow preferences and configuration, the explicit Default, or a name. */
export type VariantSelection =
  | { readonly type: "inherit" }
  | { readonly type: "default" }
  | { readonly type: "named"; readonly value: string }

export const INHERIT_VARIANT: VariantSelection = Object.freeze({ type: "inherit" })

export const DEFAULT_VARIANT: VariantSelection = Object.freeze({ type: "default" })

type VariantInput = {
  variants: readonly string[]
  selected: VariantSelection
  configured: string | undefined
  preferred?: string
}

/** Reads the composer prompt's mirror, where `null` is the explicit Default and `undefined` inherits. */
export function variantSelectionFrom(value: string | null | undefined): VariantSelection {
  if (value === null) return DEFAULT_VARIANT

  if (value === undefined) return INHERIT_VARIANT

  return { type: "named", value }
}

/** A committed variant: the server records the Default as no variant. */
export function durableVariantSelection(value: string | undefined): VariantSelection {
  return value === undefined ? DEFAULT_VARIANT : { type: "named", value }
}

/** The per-model variant store, as both selection owners read it. */
type VariantPreferenceStore = {
  variant: {
    get: (model: { providerID: string; modelID: string }) => string | undefined
  }
}

/**
 * What selecting `item` must seed the slot's variant with: the value recorded for that model, else inherit so the
 * model's own defaults apply. Never the variant of the model being replaced or of the other slot (FR-011/FR-034),
 * which is why both the session owner and the draft owner go through this one selector.
 * The store spells an explicit Default as the name `"default"`; a selection spells it as its own kind, so that name
 * resolves to `DEFAULT_VARIANT` rather than a variant called "default".
 */
export function recordedVariant(models: VariantPreferenceStore, item: { providerID: string; modelID: string }): VariantSelection {
  const value = models.variant.get({ providerID: item.providerID, modelID: item.modelID })

  if (value === undefined) return INHERIT_VARIANT

  return value === "default" ? DEFAULT_VARIANT : durableVariantSelection(value)
}

/**
 * The composer prompt's mirror of a selection: `null` is the explicit Default, `undefined` inherits, a name is a
 * name. The inverse of `variantSelectionFrom`, so a draft seeds its prompt with the same rule the session owner
 * seeds its durable choice with.
 */
export function promptVariantValue(selection: VariantSelection): string | null | undefined {
  if (selection.type === "named") return selection.value

  return selection.type === "default" ? null : undefined
}

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined

  if (!input.agent.model) return undefined

  if (!input.model?.variants) return undefined

  if (input.agent.model.providerID !== input.model.providerID) return undefined

  if (input.agent.model.modelID !== input.model.modelID) return undefined

  return input.agent.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (input.selected.type === "default") return undefined
  const value = input.selected.type === "named" ? input.selected.value : (input.preferred ?? input.configured)

  return value && value !== "default" && input.variants.includes(value) ? value : undefined
}

export function cycleModelVariant(input: VariantInput) {
  const current = resolveModelVariant(input)

  return input.variants[current ? input.variants.indexOf(current) + 1 : 0]
}
