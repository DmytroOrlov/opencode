import { describe, expect } from "bun:test"
import { Deferred, Exit, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigModel } from "@opencode/schema/config/model"
import { FallbackRuntimeIntent } from "@opencode/core/config/fallback-runtime-intent"
import { ConfigFallback } from "@opencode/core/config/fallback"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const selection = (model: string) =>
  Schema.decodeUnknownSync(ConfigModel.Selection)({ providerID: "openai", model })

const forkTracked = <E>(effect: Effect.Effect<E>) =>
  Effect.gen(function* () {
    const done = Deferred.makeUnsafe<boolean>()
    const fiber = yield* Effect.forkChild(effect.pipe(Effect.andThen(Deferred.succeed(done, true))))
    return { done, fiber }
  })

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

  // --- S2: entry positions, out-of-order validation, retirement ---

  it.effect("reserves entry positions so a late older validation cannot supersede a newer intent", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      const earlier = yield* intent.reserve()
      const later = yield* intent.reserve()
      // The later owner validates first.
      expect(yield* intent.stageValidated(later, selection("model-c"))).toBe(true)
      expect((yield* intent.current()).override).toEqual({
        type: "some",
        value: Schema.decodeUnknownSync(ConfigModel.Selection)({ providerID: "openai", model: "model-c" }),
      })
      // The earlier owner validates late: its older position is ignored, never overwritten.
      expect(yield* intent.stageValidated(earlier, selection("model-b"))).toBe(false)
      expect((yield* intent.current()).override.type).toBe("some")
      expect(yield* intent.stageValidated(earlier, null)).toBe(false)
    }),
  )

  it.effect("holds a later entry position until the earlier one retires, then releases it", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      const earlier = yield* intent.reserve()
      const later = yield* intent.reserve()
      const waiting = yield* forkTracked(intent.awaitPredecessors(later))
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      // Negative: the commit boundary was reached and is blocked by the open position.
      expect(yield* Deferred.isDone(waiting.done)).toBe(false)
      yield* intent.retire(earlier)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(waiting.done)).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.await(waiting.fiber))).toBe(true)
    }),
  )

  it.effect("lets a waiter go when its own owner retires even if others stay open, and a cancelled waiter stays clean", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      const first = yield* intent.reserve()
      const second = yield* intent.reserve()
      const third = yield* intent.reserve()
      // Cancellation at the boundary is safe: the waiter is interruptible, and the owner
      // retiring its own position (exit cleanup) is what releases everyone later.
      const cancelled = yield* forkTracked(intent.awaitPredecessors(third))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(cancelled.fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(cancelled.fiber))).toBe(true)
      // Retiring only the third position still leaves the SECOND open blocking waiters for
      // later revisions; a waiter for a revision after third stays blocked by first/second.
      yield* intent.retire(third)
      const blocked = yield* forkTracked(intent.awaitPredecessors(third))
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(blocked.done)).toBe(false)
      yield* intent.retire(second)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(blocked.done)).toBe(false)
      yield* intent.retire(first)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(blocked.done)).toBe(true)
    }),
  )

  it.effect("an older or unrelated revision cannot clear the current staged intent", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      const b = yield* intent.reserve()
      const c = yield* intent.reserve()
      const d = yield* intent.reserve()
      expect(yield* intent.stageValidated(b, selection("model-b"))).toBe(true)
      expect(yield* intent.stageValidated(c, selection("model-c"))).toBe(true)
      expect(yield* intent.stageValidated(d, selection("model-d"))).toBe(true)
      // C's exit must not erase D; B's exit likewise.
      yield* intent.clearIfCurrent(c)
      yield* intent.clearIfCurrent(b)
      expect((yield* intent.current()).override).toEqual({
        type: "some",
        value: Schema.decodeUnknownSync(ConfigModel.Selection)({ providerID: "openai", model: "model-d" }),
      })
      // D's own exit clears exactly its revision.
      yield* intent.clearIfCurrent(d)
      const cleared = yield* intent.current()
      expect(cleared.revision).toBe(d)
      expect(cleared.override).toEqual({ type: "none" })
    }),
  )

  it.effect("direct staging takes a position and retires it immediately", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      const staged = yield* intent.stage(selection("model-s"))
      // No durable commit is ordered against a direct stage, so a later reservation is never
      // blocked by it.
      const later = yield* intent.reserve()
      const waiter = yield* forkTracked(intent.awaitPredecessors(later))
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(waiter.done)).toBe(true)
      // And the staged value stays current until cleared by its own revision.
      expect((yield* intent.current()).revision).toBe(staged)
      yield* intent.clearIfCurrent(later)
      expect((yield* intent.current()).override.type).toBe("some")
    }),
  )

  // --- S2 correction: the durable committed revision is its own monotonic line ---

  it.effect("advances the committed revision only for a recorded commit, never for a reservation or stage", () =>
    Effect.gen(function* () {
      const intent = yield* FallbackRuntimeIntent.make
      expect(yield* intent.committedRevision()).toBe(0)
      // Nothing below replaced a document: an entry position, a validated stage, its revision-safe clear, a direct
      // stage and a retirement must all leave the durable marker where it was, or another location's protected
      // read would reload bytes that were never written.
      const earlier = yield* intent.reserve()
      expect(yield* intent.committedRevision()).toBe(0)
      expect(yield* intent.stageValidated(earlier, selection("model-b"))).toBe(true)
      expect(yield* intent.committedRevision()).toBe(0)
      yield* intent.clearIfCurrent(earlier)
      expect(yield* intent.committedRevision()).toBe(0)
      const direct = yield* intent.stage(selection("model-s"))
      expect(yield* intent.committedRevision()).toBe(0)
      const open = yield* intent.reserve()
      yield* intent.retire(open)
      expect(yield* intent.committedRevision()).toBe(0)
      // Only a recorded successful rename advances it, and it never moves backward, so an older or repeated
      // commit cannot send a reader back to a document it has already seen.
      yield* intent.recordCommit(earlier)
      expect(yield* intent.committedRevision()).toBe(earlier)
      yield* intent.recordCommit(direct)
      expect(yield* intent.committedRevision()).toBe(direct)
      yield* intent.recordCommit(earlier)
      expect(yield* intent.committedRevision()).toBe(direct)
      // The staged line and the durable line stay separate: a newer stage advances the entry order with no
      // durable commit, so a later revision can be staged while the marker stays where the recorded renames left it.
      const newer = yield* intent.stage(selection("model-new"))
      expect((yield* intent.current()).revision).toBe(newer)
      expect(newer).toBeGreaterThan(direct)
      expect(yield* intent.committedRevision()).toBe(direct)
    }),
  )
})
