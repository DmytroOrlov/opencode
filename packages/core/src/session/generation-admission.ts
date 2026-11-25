export * as SessionGenerationAdmission from "./generation-admission.js"

import { Context, Deferred, Effect, Exit, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Lease {
  readonly release: Effect.Effect<void>
}

export interface Interface {
  readonly acquireShared: Effect.Effect<Lease>
  readonly acquireExclusive: Effect.Effect<Lease>
   /**
   * Authoritative observation of THIS admission's own queue: live holders and waiters, plus how many acquisitions of
   * each mode have ENTERED this admission and how many have been granted, alongside the live holders and waiters.
   * A retired acquisition leaves the queue while its entry stays counted, so the difference is history rather than
   * a live wait count. Bookkeeping only — it never decides who is admitted or in which order — and it exists so a
   * caller can distinguish "waiting for the exclusive grant" from "has not reached the queue yet" instead of
   * inferring it from side effects such as zero renames.
   */
  readonly observation: Effect.Effect<Observation>
  /** Resolves once `count` acquisitions of `mode` have entered this admission's queue. */
  readonly awaitedEnqueued: (mode: Mode, count: number) => Effect.Effect<void>
}

export interface Observation {
  readonly sharedReaders: number
  readonly writer: boolean
  readonly queuedShared: number
  readonly queuedExclusive: number
  readonly enqueuedShared: number
  readonly enqueuedExclusive: number
  readonly grantedShared: number
  readonly grantedExclusive: number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGenerationAdmission") {}

type Mode = "shared" | "exclusive"
type Waiter = {
  readonly id: number
  readonly mode: Mode
  readonly ready: Deferred.Deferred<void>
}
type State = {
  readonly nextID: number
  readonly readers: number
  readonly writer: boolean
  readonly queue: readonly Waiter[]
  readonly ownership: ReadonlyMap<number, "queued" | "active">
}

const initial: State = { nextID: 0, readers: 0, writer: false, queue: [], ownership: new Map() }

const admit = (state: State): readonly [State, readonly Waiter[]] => {
  if (state.writer) return [state, []]

  const queue = [...state.queue]
  const ownership = new Map(state.ownership)
  const granted: Waiter[] = []
  let readers = state.readers
  let writer = false

  while (queue.length > 0) {
    const waiter = queue[0]
    if (waiter.mode === "shared") {
      queue.shift()
      ownership.set(waiter.id, "active")
      readers++
      granted.push(waiter)
      continue
    }
    if (readers !== 0) break
    queue.shift()
    ownership.set(waiter.id, "active")
    writer = true
    granted.push(waiter)
    break
  }

  return [{ nextID: state.nextID, readers, writer, queue, ownership }, granted]
}

const notify = (waiters: readonly Waiter[]) =>
  Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter.ready, undefined), { discard: true })

export const make = Effect.gen(function* () {
    const state = yield* SynchronizedRef.make(initial)

    // Observation only. Counters advance inside the same critical sections that change the queue, so an observation
    // can never disagree with an admission, and nothing here decides who is admitted or in which order.
    let enqueuedShared = 0
    let enqueuedExclusive = 0
    let grantedShared = 0
    let grantedExclusive = 0
    const enqueuedWaiters: Array<{
      readonly mode: Mode
      readonly target: number
      readonly waiter: Deferred.Deferred<void>
    }> = []
    const noteEnqueued = (mode: Mode) => {
      const enqueued = mode === "shared" ? ++enqueuedShared : ++enqueuedExclusive
      const ready = enqueuedWaiters.filter(
        ({ mode: waiterMode, target }) => waiterMode === mode && target <= enqueued,
      )
      ready.forEach(({ waiter }) => Deferred.doneUnsafe(waiter, Exit.succeed(undefined)))
      ready.forEach((entry) => {
        const index = enqueuedWaiters.indexOf(entry)
        if (index !== -1) enqueuedWaiters.splice(index, 1)
      })
    }
    const noteGranted = (granted: readonly Waiter[]) => {
      granted.forEach(({ mode }) => {
        if (mode === "shared") ++grantedShared
        else ++grantedExclusive
      })
    }

    const release = (waiter: Waiter) =>
      SynchronizedRef.modify(state, (current) => {
        const owner = current.ownership.get(waiter.id)
        if (owner === undefined) return [[], current] as const
        const ownership = new Map(current.ownership)
        ownership.delete(waiter.id)
        const released: State =
          owner === "queued"
            ? { ...current, queue: current.queue.filter((item) => item.id !== waiter.id), ownership }
            : waiter.mode === "shared"
              ? { ...current, readers: current.readers - 1, ownership }
              : { ...current, writer: false, ownership }
        const [next, granted] = admit(released)
        noteGranted(granted)
        return [granted, next] as const
      }).pipe(Effect.flatMap(notify))

    const acquire = (mode: Mode): Effect.Effect<Lease> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const waiter: Waiter = {
            id: 0,
            mode,
            ready: Deferred.makeUnsafe<void>(),
          }
          const queued = yield* SynchronizedRef.modify(state, (current) => {
            const ownership = new Map(current.ownership)
            const assigned = { ...waiter, id: current.nextID + 1 }
            ownership.set(assigned.id, "queued")
            const waiting: State = {
              ...current,
              nextID: assigned.id,
              queue: [...current.queue, assigned],
              ownership,
            }
            const [next, granted] = admit(waiting)
            // Observation: every acquisition is counted as it enters this admission, and every grant as it is handed
            // over. A retired acquisition leaves the queue while its entry stays counted, so the difference is
            // bookkeeping about this admission's history, not a live wait count. Neither counter decides ordering.
            noteEnqueued(mode)
            noteGranted(granted)
            return [{ waiter: assigned, granted }, next] as const
          })
          yield* notify(queued.granted)
          yield* restore(Deferred.await(queued.waiter.ready)).pipe(Effect.onInterrupt(() => release(queued.waiter)))
          return { release: release(queued.waiter) }
        }),
      )

    const observation: Effect.Effect<Observation> = Effect.map(SynchronizedRef.get(state), (current) => ({
      sharedReaders: current.readers,
      writer: current.writer,
      queuedShared: current.queue.filter((item) => item.mode === "shared").length,
      queuedExclusive: current.queue.filter((item) => item.mode === "exclusive").length,
      enqueuedShared,
      enqueuedExclusive,
      grantedShared,
      grantedExclusive,
    }))

    const awaitedEnqueued = (mode: Mode, count: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const waiting = Deferred.makeUnsafe<void>()

        const registered = yield* SynchronizedRef.modify(state, (current) => {
          const enqueued = mode === "shared" ? enqueuedShared : enqueuedExclusive

          if (enqueued >= count) return [false, current] as const

          enqueuedWaiters.push({
            mode,
            target: count,
            waiter: waiting,
          })

          return [true, current] as const
        })

        // Already reached: do not await a Deferred nobody will complete.
        if (!registered) return

        yield* Deferred.await(waiting).pipe(
          Effect.ensuring(
            SynchronizedRef.modify(state, (current) => {
              const index = enqueuedWaiters.findIndex(
                (entry) => entry.waiter === waiting,
              )

              if (index !== -1) enqueuedWaiters.splice(index, 1)

              return [undefined, current] as const
            }).pipe(Effect.asVoid),
          ),
        )
      })

    return {
      acquireShared: acquire("shared"),
      acquireExclusive: acquire("exclusive"),
      observation,
      awaitedEnqueued,
    } satisfies Interface
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
