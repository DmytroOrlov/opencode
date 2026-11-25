import { describe, expect } from "bun:test"
import { Deferred, Exit, Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
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

  it.effect("a cancelled queued exclusive writer never blocks later readers or writers", () =>
    Effect.gen(function* () {
      const admission = yield* SessionGenerationAdmission.make
      const holder = yield* admission.acquireShared
      const blockedWriter = yield* admission.acquireExclusive.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(blockedWriter)
      expect(Exit.hasInterrupts(yield* Fiber.await(blockedWriter))).toBe(true)
      // The cancelled writer dropped its queue entry; after the holder releases, both a
      // reader and a fresh writer progress.
      yield* holder.release
      const reader = yield* admission.acquireShared
      yield* reader.release
      const writer = yield* admission.acquireExclusive
      yield* writer.release
    }),
  )

  it.effect("independently compiled graphs hold separate admission instances (negative control)", () =>
    Effect.gen(function* () {
      // CONTROL, not the production shape: two ARBITRARY separate `LayerNode.compile` calls remain independent BY
      // DESIGN (`compile` dedupes a node by implementation identity only within one call and builds its own wrapper
      // layers per call), so a lease taken in one of them cannot gate the other. The two admission owners are NOT
      // assembled that way in production: `AppNodeBuilder.build` (core/src/effect/app-node-builder.ts) creates ONE
      // admission value per application build and injects it through the same `bindings` path that reaches
      // `buildLocationServiceMap`, so `SessionExecution` (server graph) and `Config.configured()` (per-location
      // graph) stand on that one shared instance. That positive property is proven in
      // `test/effect/app-node-builder.test.ts`; nothing here may claim that separately compiled graphs share state,
      // and no process-wide scope is claimed for `build` either (independent `AppNodeBuilder.build` roots stay
      // isolated, per the boundary control in that file).
      const first = yield* Effect.gen(function* () {
        return yield* SessionGenerationAdmission.Service
      }).pipe(Effect.provide(LayerNode.compile(SessionGenerationAdmission.node)))
      const second = yield* Effect.gen(function* () {
        return yield* SessionGenerationAdmission.Service
      }).pipe(Effect.provide(LayerNode.compile(SessionGenerationAdmission.node)))
      expect(first === second).toBe(false)

      // Positive control inside ONE graph: a held shared lease withholds an exclusive owner of that instance.
      const lease = yield* first.acquireShared
      const blocked = yield* Deferred.make<void>()
      const sameGraph = yield* first.acquireExclusive.pipe(
        Effect.tap(() => Deferred.succeed(blocked, undefined)),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(blocked)).toBe(false)

      // Across those two independent instances the same exclusive acquisition is admitted at once while that shared
      // lease is still held: the lease is simply invisible to the other instance.
      const admitted = yield* Deferred.make<void>()
      const otherGraph = yield* second.acquireExclusive.pipe(
        Effect.tap(() => Deferred.succeed(admitted, undefined)),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* Deferred.await(admitted)
      const crossLease = yield* Fiber.join(otherGraph)

      // Releasing the shared lease admits the withheld writer of the FIRST graph, exactly once.
      yield* lease.release
      yield* Deferred.await(blocked)
      const blockedLease = yield* Fiber.join(sameGraph)
      yield* blockedLease.release
      yield* crossLease.release
    }),
  )


  // `awaitedEnqueued` is a caller's window onto THIS admission's queue. A count that is already reached must return
  // rather than wait on a Deferred nobody will ever resolve, and a waiter that is cancelled must retire its own
  // registration without touching the admission it was only observing.
  it.effect("completes an observation waiter whose count is already reached", () =>
    Effect.gen(function* () {
      const admission = yield* SessionGenerationAdmission.make
      const lease = yield* admission.acquireShared
      yield* admission.awaitedEnqueued("shared", 1).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die("an already-reached shared count never completed"),
        }),
      )
      // A count of zero is reached by definition, and one below the current count stays reached after the lease
      // releases: none of these may park a caller on a waiter nothing will complete.
      yield* admission.awaitedEnqueued("exclusive", 0).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die("a zero exclusive count never completed"),
        }),
      )
      yield* lease.release
      yield* admission.awaitedEnqueued("shared", 1).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die("a count reached earlier never completed"),
        }),
      )
      const observed = yield* admission.observation
      expect(observed.enqueuedShared).toBe(1)
      expect(observed.grantedShared).toBe(1)
      expect(observed.enqueuedExclusive).toBe(0)
      expect(observed.grantedExclusive).toBe(0)
    }),
  )

  it.effect("wakes an observation waiter when the requested acquisition enters the queue", () =>
    Effect.gen(function* () {
      const admission = yield* SessionGenerationAdmission.make
      const holder = yield* admission.acquireShared
      const woke = yield* Deferred.make<void>()
      const waiter = yield* admission
        .awaitedEnqueued("exclusive", 1)
        .pipe(Effect.tap(() => Deferred.succeed(woke, undefined)), Effect.forkChild)
      yield* Effect.yieldNow
      // Registered, and nothing to be satisfied by yet: the exclusive queue has no entry of any kind.
      expect(yield* Deferred.isDone(woke)).toBe(false)
      const before = yield* admission.observation
      expect(before.enqueuedExclusive).toBe(0)
      expect(before.grantedExclusive).toBe(0)
      expect(before.queuedExclusive).toBe(0)

      const withheld = yield* admission.acquireExclusive.pipe(Effect.forkChild)
      // The waiter resolves on the acquisition ENTERING the queue, which is strictly earlier than its grant: A's
      // lease still withholds it, so the waiter woke while the acquisition is still waiting.
      yield* Deferred.await(woke)
      const parked = yield* admission.observation
      expect(parked.enqueuedExclusive).toBe(1)
      expect(parked.grantedExclusive).toBe(0)
      expect(parked.queuedExclusive).toBe(1)
      expect(parked.sharedReaders).toBe(1)
      expect(yield* Deferred.isDone(woke)).toBe(true)

      // The withheld acquisition then completes on its own, and the waiter completed exactly once.
      yield* holder.release
      const granted = yield* Fiber.join(withheld)
      yield* granted.release
      yield* Fiber.join(waiter)
      const settled = yield* admission.observation
      expect(settled.grantedExclusive).toBe(1)
      expect(settled.queuedExclusive).toBe(0)
    }),
  )

  it.effect("cancelling an observation waiter changes no ownership, grant or counter", () =>
    Effect.gen(function* () {
      const admission = yield* SessionGenerationAdmission.make
      const holder = yield* admission.acquireShared
      const doomedWake = yield* Deferred.make<void>()
      const survivorWake = yield* Deferred.make<void>()
      const doomed = yield* admission
        .awaitedEnqueued("exclusive", 1)
        .pipe(Effect.tap(() => Deferred.succeed(doomedWake, undefined)), Effect.forkChild)
      const survivor = yield* admission
        .awaitedEnqueued("exclusive", 1)
        .pipe(Effect.tap(() => Deferred.succeed(survivorWake, undefined)), Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(doomedWake)).toBe(false)
      expect(yield* Deferred.isDone(survivorWake)).toBe(false)
      const before = yield* admission.observation

      yield* Fiber.interrupt(doomed)
      expect(Exit.hasInterrupts(yield* Fiber.await(doomed))).toBe(true)
      // An observation waiter is not an acquisition: cancelling it neither enters the queue, retires a holder
      // nor hands out a grant, and the live state is exactly what it was.
      expect(yield* admission.observation).toEqual(before)

      // The survivor stays registered, so the real enqueue still wakes it, and the cancelled waiter is not
      // resurrected by that enqueue: it stays an interruption rather than becoming a completion.
      const withheld = yield* admission.acquireExclusive.pipe(Effect.forkChild)
      yield* Deferred.await(survivorWake)
      yield* Fiber.interrupt(doomed)
      expect(Exit.hasInterrupts(yield* Fiber.await(doomed))).toBe(true)
      const after = yield* admission.observation
      expect(after.enqueuedExclusive).toBe(1)
      expect(after.grantedExclusive).toBe(0)
      expect(after.queuedExclusive).toBe(1)
      expect(after.sharedReaders).toBe(1)
      expect(after.writer).toBe(false)

      // Cancelling the survivor behaves the same way: the acquisition it was observing is untouched.
      yield* Fiber.interrupt(survivor)
      expect(Exit.hasInterrupts(yield* Fiber.await(survivor))).toBe(true)
      expect(yield* admission.observation).toEqual(after)

      yield* holder.release
      const granted = yield* Fiber.join(withheld)
      yield* granted.release
    }),
  )

  it.effect("a queued writer interrupted in the release window still releases correctly", () =>
    Effect.gen(function* () {
      // Cancel WINS the window: the interruption retires the queued position before the holder's release can
      // hand anything over, so the release admits nobody spurious and the next writer is admitted at once.
      const cancelled = yield* SessionGenerationAdmission.make
      const firstHolder = yield* cancelled.acquireShared
      const doomed = yield* cancelled.acquireExclusive.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(doomed)
      expect(Exit.hasInterrupts(yield* Fiber.await(doomed))).toBe(true)
      yield* firstHolder.release
      const afterCancel = yield* cancelled.observation
      expect(afterCancel.enqueuedExclusive).toBe(1)
      expect(afterCancel.grantedExclusive).toBe(0)
      expect(afterCancel.queuedExclusive).toBe(0)
      expect(afterCancel.writer).toBe(false)
      expect(afterCancel.sharedReaders).toBe(0)
      const afterDoomed = yield* cancelled.acquireExclusive
      yield* afterDoomed.release

      // The GRANT wins the window: the handoff finishes inside the uninterruptible region, so an interruption
      // arriving afterwards cannot leave a half-handed lease — the writer state is live and is retired by the
      // grant's own release rather than stranded by the interrupted caller.
      const granted = yield* SessionGenerationAdmission.make
      const secondHolder = yield* granted.acquireShared
      const acquirer = yield* granted.acquireExclusive.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* secondHolder.release
      yield* Fiber.interrupt(acquirer)
      // The acquisition completed and its grant is in force: nothing about it is half-applied.
      const active = yield* granted.observation
      expect(active.enqueuedExclusive).toBe(1)
      expect(active.grantedExclusive).toBe(1)
      expect(active.writer).toBe(true)
      expect(Exit.hasInterrupts(yield* Fiber.await(acquirer))).toBe(false)
      // Retiring that grant through the release the acquirer was handed unblocks the queue completely.
      const lease = yield* Fiber.join(acquirer)
      yield* lease.release
      const drained = yield* granted.observation
      expect(drained.writer).toBe(false)
      expect(drained.queuedExclusive).toBe(0)
      expect(drained.sharedReaders).toBe(0)
      const nextWriter = yield* granted.acquireExclusive
      yield* nextWriter.release
    }),
  )

  it.effect("releasing one lease twice grants a queued writer exactly once", () =>
    Effect.gen(function* () {
      const admission = yield* SessionGenerationAdmission.make
      const first = yield* admission.acquireShared
      const second = yield* admission.acquireShared
      const started = yield* Deferred.make<void>()
      const exclusiveFiber = yield* admission.acquireExclusive.pipe(
        Effect.tap(() => Deferred.succeed(started, undefined)),
        Effect.forkChild,
      )
      yield* first.release
      // Double release of the same lease must not also drop the reader count for `second`.
      yield* first.release
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(started)).toBe(false)
      yield* second.release
      yield* Deferred.await(started)
      const exclusive = yield* Fiber.join(exclusiveFiber)
      yield* exclusive.release
    }),
  )
})
