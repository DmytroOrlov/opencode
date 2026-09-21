import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionGenerationAdmission } from "@opencode/core/session/generation-admission"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SessionGenerationAdmission", () => {
  it.effect("allows concurrent shared leases and admits queued work in FIFO mode order", () =>
    Effect.gen(function* () {
      const admission = yield* SessionGenerationAdmission.make
      const first = yield* admission.acquireShared
      const second = yield* admission.acquireShared
      const exclusiveStarted = yield* Deferred.make<void>()
      const sharedStarted = yield* Deferred.make<void>()
      const exclusiveFiber = yield* admission.acquireExclusive.pipe(
        Effect.tap(() => Deferred.succeed(exclusiveStarted, undefined)),
        Effect.forkChild,
      )
      const sharedFiber = yield* admission.acquireShared.pipe(
        Effect.tap(() => Deferred.succeed(sharedStarted, undefined)),
        Effect.forkChild,
      )

      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(exclusiveStarted)).toBe(false)
      expect(yield* Deferred.isDone(sharedStarted)).toBe(false)

      yield* first.release
      yield* second.release
      yield* Deferred.await(exclusiveStarted)
      expect(yield* Deferred.isDone(sharedStarted)).toBe(false)
      const exclusive = yield* Fiber.join(exclusiveFiber)
      yield* exclusive.release
      yield* Deferred.await(sharedStarted)
      const shared = yield* Fiber.join(sharedFiber)
      yield* shared.release
    }),
  )

  it.effect("cancels an interrupted queued lease without blocking the next owner", () =>
    Effect.gen(function* () {
      const admission = yield* SessionGenerationAdmission.make
      const exclusive = yield* admission.acquireExclusive
      const waiting = yield* admission.acquireShared.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      yield* exclusive.release

      const next = yield* admission.acquireExclusive
      yield* next.release
    }),
  )
})
