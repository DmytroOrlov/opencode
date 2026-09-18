import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

export type ModelAttemptRef = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: string
}

// Temporary backend-only fallback. Keep this as the single source of truth
// until fallback selection is exposed through the model/session settings.
export const FIXED_FALLBACK: ModelAttemptRef = {
  providerID: ProviderV2.ID.make("mlx"),
  modelID: ModelV2.ID.make("qwen3.8-27b"),
  variant: "xhigh",
}

export function sameModelAttempt(a: ModelAttemptRef, b: ModelAttemptRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant
}
