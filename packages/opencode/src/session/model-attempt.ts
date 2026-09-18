import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

export type ModelAttemptRef = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  variant?: string
}

export function sameModel(a: ModelAttemptRef, b: ModelAttemptRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID
}

export function sameModelAttempt(a: ModelAttemptRef, b: ModelAttemptRef) {
  return sameModel(a, b) && a.variant === b.variant
}
