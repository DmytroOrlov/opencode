import { describe, expect, test } from "bun:test"
import {
  displayedFallbackForPrimary,
  fallbackForModelPair,
  fallbackForModelSelection,
  filterFallbackModels,
  formatModelReference,
  parseModelReference,
  sameModelIdentity,
  shouldClearFallbackForPrimary,
} from "./model-fallback"

describe("model fallback helpers", () => {
  test("preserves slashes in model references", () => {
    expect(parseModelReference("openrouter/org/model")).toEqual({ providerID: "openrouter", modelID: "org/model" })
    expect(formatModelReference({ providerID: "openrouter", modelID: "org/model" })).toBe("openrouter/org/model")
  })

  test("clears fallback for a primary model collision regardless of variant", () => {
    expect(
      shouldClearFallbackForPrimary(
        { providerID: "mlx", modelID: "qwen3.8-27b" },
        { model: "mlx/qwen3.8-27b", variant: "xhigh" },
      ),
    ).toBe(true)
    expect(
      sameModelIdentity({ providerID: "mlx", modelID: "qwen3.8-27b" }, { providerID: "mlx", modelID: "qwen3.8-27b" }),
    ).toBe(true)
  })

  test("resolves absent fallback to the legacy model and preserves null", () => {
    expect(shouldClearFallbackForPrimary({ providerID: "mlx", modelID: "qwen3.8-27b" }, undefined)).toBe(true)
    expect(shouldClearFallbackForPrimary({ providerID: "test", modelID: "model" }, null)).toBe(false)
  })

  test("hides displayed fallback when it collides with the primary model", () => {
    expect(displayedFallbackForPrimary({ providerID: "mlx", modelID: "qwen3.8-27b" }, undefined)).toBeNull()
    expect(displayedFallbackForPrimary({ providerID: "test", modelID: "model" }, undefined)).toEqual({
      model: "mlx/qwen3.8-27b",
      variant: "xhigh",
    })
    expect(displayedFallbackForPrimary(undefined, null)).toBeNull()
  })

  test("preserves supported variants and clears unsupported variants", () => {
    const model = { providerID: "test", modelID: "custom" }
    expect(
      fallbackForModelSelection({
        model,
        variants: { low: {}, high: {}, xhigh: {} },
        rawFallback: { model: "mlx/old", variant: "xhigh" },
      }),
    ).toEqual({ model: "test/custom", variant: "xhigh" })
    expect(
      fallbackForModelSelection({
        model,
        variants: { low: {}, high: {} },
        rawFallback: { model: "mlx/old", variant: "xhigh" },
      }),
    ).toEqual({ model: "test/custom", variant: null })
    expect(
      fallbackForModelSelection({
        model,
        variants: { low: {}, high: {} },
        rawFallback: { model: "mlx/old", variant: "toString" },
      }),
    ).toEqual({ model: "test/custom", variant: null })
    expect(fallbackForModelSelection({ model, variants: { low: {} }, rawFallback: null })).toEqual({
      model: "test/custom",
      variant: null,
    })
  })

  test("constructs fallback config from a model pair", () => {
    const model = { providerID: "test", modelID: "primary" }
    const variants = { low: {}, high: {} }
    expect(fallbackForModelPair({ model, variants, variant: "low" })).toEqual({
      model: "test/primary",
      variant: "low",
    })
    expect(fallbackForModelPair({ model, variants, variant: null })).toEqual({
      model: "test/primary",
      variant: null,
    })
    expect(fallbackForModelPair({ model, variants, variant: undefined })).toEqual({
      model: "test/primary",
      variant: null,
    })
    expect(fallbackForModelPair({ model, variants, variant: "xhigh" })).toEqual({
      model: "test/primary",
      variant: null,
    })
    expect(fallbackForModelPair({ model, variants, variant: "toString" })).toEqual({
      model: "test/primary",
      variant: null,
    })
  })

  test("filters out the primary model", () => {
    const models = [
      { id: "one", provider: { id: "test" } },
      { id: "same", provider: { id: "mlx" } },
      { id: "other", provider: { id: "mlx" } },
    ]
    expect(filterFallbackModels(models, { providerID: "mlx", modelID: "same" })).toEqual([models[0], models[2]])
  })
})
