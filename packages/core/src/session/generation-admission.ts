export * as SessionGenerationAdmission from "./generation-admission.js"

import { Context, Deferred, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Lease {
  readonly release: Effect.Effect<void>
}

export interface Interface {
  readonly acquireShared: Effect.Effect<Lease>
  readonly acquireExclusive: Effect.Effect<Lease>
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
            return [{ waiter: assigned, granted }, next] as const
          })
          yield* notify(queued.granted)
          yield* restore(Deferred.await(queued.waiter.ready)).pipe(Effect.onInterrupt(() => release(queued.waiter)))
          return { release: release(queued.waiter) }
        }),
      )

    return {
      acquireShared: acquire("shared"),
      acquireExclusive: acquire("exclusive"),
    } satisfies Interface
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
