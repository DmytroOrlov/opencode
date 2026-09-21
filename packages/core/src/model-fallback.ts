export type ModelFallbackConfig = {
  model: string
  variant: string | null
}

export const LEGACY_MODEL_FALLBACK: ModelFallbackConfig = {
  model: "mlx/qwen3.8-27b",
  variant: "xhigh",
}

export function resolveModelFallback(value: ModelFallbackConfig | null | undefined) {
  if (value === undefined) return LEGACY_MODEL_FALLBACK
  return value
}
