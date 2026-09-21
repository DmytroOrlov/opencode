import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, SynchronizedRef } from "effect"
import { GenerationGate } from "@opencode-ai/core/session/generation-gate"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("GenerationGate", () => {
  it.effect("admits queued readers before a writer and blocks readers behind it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* GenerationGate.make
        const first = yield* gate.reserveShared
        const second = yield* gate.reserveShared
        yield* first.await
        const firstLease = yield* first.transfer
        yield* second.await
        const secondLease = yield* second.transfer

        const writer = yield* gate.reserveExclusive
        const afterWriter = yield* gate.reserveShared
        const writerStarted = yield* Deferred.make<void>()
        const finishWriter = yield* Deferred.make<void>()
        const readerStarted = yield* Deferred.make<void>()
        const writerFiber = yield* Effect.gen(function* () {
          yield* writer.await
          const lease = yield* writer.transfer
          if (lease === undefined) return yield* Effect.die("writer was not granted")
          yield* Deferred.succeed(writerStarted, undefined)
          yield* Deferred.await(finishWriter)
          yield* lease.release
        }).pipe(Effect.forkChild)
        const readerFiber = yield* Effect.gen(function* () {
          yield* afterWriter.await
          const lease = yield* afterWriter.transfer
          if (lease === undefined) return yield* Effect.die("reader was not granted")
          yield* Deferred.succeed(readerStarted, undefined)
          yield* lease.release
        }).pipe(Effect.forkChild)

        yield* firstLease!.release
        yield* secondLease!.release
        yield* Deferred.await(writerStarted)
        expect(yield* Deferred.isDone(readerStarted)).toBeFalse()

        yield* Deferred.succeed(finishWriter, undefined)
        yield* Deferred.await(readerStarted)
        yield* Effect.all([Fiber.join(writerFiber), Fiber.join(readerFiber)])
      }),
    ),
  )

  it.effect("keeps multiple writers FIFO ahead of later readers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* GenerationGate.make
        const reader = yield* gate.reserveShared
        yield* reader.await
        const readerLease = yield* reader.transfer
        const first = yield* gate.reserveExclusive
        const second = yield* gate.reserveExclusive
        const laterReader = yield* gate.reserveShared
        const order = yield* SynchronizedRef.make<string[]>([])
        const run = (reservation: GenerationGate.Reservation, label: string) =>
          reservation.await.pipe(
            Effect.andThen(reservation.transfer),
            Effect.flatMap((lease) =>
              lease === undefined
                ? Effect.die(`${label} reservation was not granted`)
                : SynchronizedRef.update(order, (current) => [...current, label]).pipe(
                    Effect.andThen(lease.release),
                  ),
            ),
          )

        const firstFiber = yield* run(first, "first").pipe(Effect.forkChild)
        const secondFiber = yield* run(second, "second").pipe(Effect.forkChild)
        const readerFiber = yield* run(laterReader, "reader").pipe(Effect.forkChild)
        yield* readerLease!.release
        yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber), Fiber.join(readerFiber)])

        expect(yield* SynchronizedRef.get(order)).toEqual(["first", "second", "reader"])
      }),
    ),
  )

  it.effect("cancels queued readers and writers without leaving queue entries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* GenerationGate.make
        const active = yield* gate.reserveShared
        yield* active.await
        const activeLease = yield* active.transfer
        const writer = yield* gate.reserveExclusive
        const cancelledReader = yield* gate.reserveShared
        const laterWriter = yield* gate.reserveExclusive

        expect(yield* cancelledReader.cancel).toBe("cancelled")
        expect(yield* writer.cancel).toBe("cancelled")
        yield* activeLease!.release

        yield* laterWriter.await
        const laterLease = yield* laterWriter.transfer
        expect(laterLease).toBeDefined()
        yield* laterLease!.release
      }),
    ),
  )

  it.effect("makes cancellation and grant mutually exclusive and releases a granted reservation once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* GenerationGate.make
        const held = yield* gate.reserveExclusive
        yield* held.await
        const heldLease = yield* held.transfer
        const cancelled = yield* gate.reserveShared

        expect(yield* cancelled.cancel).toBe("cancelled")
        yield* heldLease!.release
        yield* cancelled.await
        expect(yield* cancelled.transfer).toBeUndefined()

        const blocker = yield* gate.reserveExclusive
        yield* blocker.await
        const blockerLease = yield* blocker.transfer
        const queued = yield* Deferred.make<void>()
        const grantedReached = yield* Deferred.make<void>()
        const grantedFiber = yield* Effect.gen(function* () {
          const granted = yield* gate.reserveShared
          yield* Deferred.succeed(queued, undefined)
          yield* granted.await
          yield* Deferred.succeed(grantedReached, undefined)
          yield* Effect.never
        }).pipe(Effect.scoped, Effect.forkChild)

        yield* Deferred.await(queued)
        const waitingWriter = yield* gate.reserveExclusive
        yield* blockerLease!.release
        yield* Deferred.await(grantedReached)
        yield* Fiber.interrupt(grantedFiber)

        yield* waitingWriter.await
        const writerLease = yield* waitingWriter.transfer
        expect(writerLease).toBeDefined()
        yield* writerLease!.release
      }),
    ),
  )

  it.effect("transfers ownership so reservation cleanup cannot release active work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* GenerationGate.make
        const reservation = yield* gate.reserveShared
        yield* reservation.await
        const lease = yield* reservation.transfer
        expect(lease).toBeDefined()
        expect(yield* reservation.cancel).toBe("transferred")

        const writer = yield* gate.reserveExclusive
        const writerStarted = yield* Deferred.make<void>()
        const finishWriter = yield* Deferred.make<void>()
        const writerFiber = yield* Effect.gen(function* () {
          yield* writer.await
          const granted = yield* writer.transfer
          if (granted === undefined) return yield* Effect.die("writer was not granted")
          yield* Deferred.succeed(writerStarted, undefined)
          yield* Deferred.await(finishWriter)
          yield* granted.release
        }).pipe(Effect.forkChild)
        expect(yield* Deferred.isDone(writerStarted)).toBeFalse()

        yield* lease!.release
        yield* Deferred.await(writerStarted)
        yield* Deferred.succeed(finishWriter, undefined)
        yield* Fiber.join(writerFiber)
      }),
    ),
  )
})
