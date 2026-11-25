export * as ConfigFallback from "./fallback.js"

import { Model } from "@opencode/schema/model"
import { ConfigModel } from "@opencode/schema/config/model"
import { Provider } from "@opencode/schema/provider"

export const LEGACY_MODEL_FALLBACK: ConfigModel.Selection = {
  providerID: Provider.ID.make("mlx"),
  model: Model.ID.make("qwen3.8-27b"),
  variant: Model.VariantID.make("xhigh"),
}

export function resolve(value: ConfigModel.Selection | null | undefined) {
  if (value === undefined) return LEGACY_MODEL_FALLBACK
  return value
}
