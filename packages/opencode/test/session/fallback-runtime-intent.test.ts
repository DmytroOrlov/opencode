import { describe, expect } from "bun:test"
import type { ModelFallbackConfig } from "@opencode-ai/core/model-fallback"
import { Effect } from "effect"
import { FallbackRuntimeIntent } from "../../src/session/fallback-runtime-intent"
import { testEffect } from "../lib/effect"

const it = testEffect(FallbackRuntimeIntent.layer)

describe("FallbackRuntimeIntent", () => {
  it.effect("distinguishes no override from an explicit clear", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.Service

      expect(yield* intent.current()).toEqual({ revision: 0, override: { type: "none" } })

      const revision = yield* intent.stage(null)
      expect(yield* intent.current()).toEqual({ revision, override: { type: "some", value: null } })
    }),
  )

  it.effect("preserves the raw value and assigns increasing revisions", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.Service
      const first: ModelFallbackConfig = { model: "provider/model-b", variant: "raw-variant" }
      const second: ModelFallbackConfig = { model: "provider/model-c", variant: null }

      const firstRevision = yield* intent.stage(first)
      const firstSnapshot = yield* intent.current()
      const secondRevision = yield* intent.stage(second)
      const secondSnapshot = yield* intent.current()

      expect(secondRevision).toBeGreaterThan(firstRevision)
      expect(firstSnapshot.override).toEqual({ type: "some", value: first })
      expect(secondSnapshot.override).toEqual({ type: "some", value: second })
    }),
  )

  it.effect("does not let stale cleanup clear a newer stage", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.Service
      const oldRevision = yield* intent.stage({ model: "provider/model-b", variant: null })
      const currentRevision = yield* intent.stage({ model: "provider/model-c", variant: "latest" })

      yield* intent.clearIfCurrent(oldRevision)

      expect(yield* intent.current()).toEqual({
        revision: currentRevision,
        override: { type: "some", value: { model: "provider/model-c", variant: "latest" } },
      })
    }),
  )

  it.effect("clears the current revision without resetting the revision counter", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.Service
      const first = yield* intent.stage(null)
      yield* intent.clearIfCurrent(first)
      const cleared = yield* intent.current()
      const second = yield* intent.stage({ model: "provider/model-b", variant: null })

      expect(cleared).toEqual({ revision: first, override: { type: "none" } })
      expect(second).toBeGreaterThan(first)
    }),
  )
})
