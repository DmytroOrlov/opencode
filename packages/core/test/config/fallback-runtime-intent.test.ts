import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FallbackRuntimeIntent } from "@opencode/core/config/fallback-runtime-intent"
import { ConfigFallback } from "@opencode/core/config/fallback"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("FallbackRuntimeIntent", () => {
  it.effect("distinguishes no override from explicit null and preserves the legacy default", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      expect((yield* intent.current()).override).toEqual({ type: "none" })
      expect(ConfigFallback.resolve(undefined)).toEqual(ConfigFallback.LEGACY_MODEL_FALLBACK)
      expect(ConfigFallback.resolve(null)).toBeNull()

      const revision = yield* intent.stage(null)
      expect(yield* intent.current()).toEqual({ revision, override: { type: "some", value: null } })
    }),
  )

  it.effect("clears only the matching revision", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      const first = yield* intent.stage(ConfigFallback.LEGACY_MODEL_FALLBACK)
      const second = yield* intent.stage(null)
      yield* intent.clearIfCurrent(first)
      expect((yield* intent.current()).override).toEqual({ type: "some", value: null })
      yield* intent.clearIfCurrent(second)
      expect(yield* intent.current()).toEqual({ revision: second, override: { type: "none" } })
    }),
  )
})
