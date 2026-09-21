export * as GenerationGate from "./generation-gate"

import { Context, Deferred, Effect, Layer, SynchronizedRef } from "effect"
import type * as Scope from "effect/Scope"
import { makeGlobalNode } from "../effect/app-node"
import { memoMap } from "../effect/memo-map"

export interface Lease {
  /** Releases a transferred shared or exclusive lease. Safe to call more than once. */
  readonly release: Effect.Effect<void>
}

export type CancelResult = "cancelled" | "granted" | "transferred" | "finished"

export interface Reservation {
  /** Waits until the reservation is granted or cancelled. */
  readonly await: Effect.Effect<void>
  /** Transfers a granted lease to work. Returns undefined if cancellation won. */
  readonly transfer: Effect.Effect<Lease | undefined>
  /** Cancels a queued reservation or releases a granted reservation-owned lease. */
  readonly cancel: Effect.Effect<CancelResult>
}

export interface Interface {
  readonly reserveShared: Effect.Effect<Reservation, never, Scope.Scope>
  readonly reserveExclusive: Effect.Effect<Reservation, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GenerationGate") {}

type Mode = "shared" | "exclusive"
type Ownership = "queued" | "reservation" | "work"

type Waiter = {
  readonly id: number
  readonly mode: Mode
  readonly ready: Deferred.Deferred<void>
}

type State = {
  readonly activeReaders: number
  readonly exclusiveActive: boolean
  readonly queue: readonly Waiter[]
  readonly ownership: ReadonlyMap<number, Ownership>
}

type Transition = {
  readonly granted: readonly Waiter[]
  readonly cancelled: readonly Waiter[]
}

type CancelOutcome = {
  readonly result: CancelResult
  readonly transition: Transition | undefined
}

const initial: State = {
  activeReaders: 0,
  exclusiveActive: false,
  queue: [],
  ownership: new Map(),
}

const admit = (state: State): readonly [State, readonly Waiter[]] => {
  if (state.exclusiveActive) return [state, []]

  const queue = [...state.queue]
  const ownership = new Map(state.ownership)
  const granted: Waiter[] = []
  let activeReaders = state.activeReaders
  let exclusiveActive: boolean = state.exclusiveActive

  while (queue.length > 0) {
    const head = queue[0]
    if (head.mode === "shared") {
      queue.shift()
      ownership.set(head.id, "reservation")
      activeReaders++
      granted.push(head)
      continue
    }

    if (activeReaders !== 0) break
    queue.shift()
    ownership.set(head.id, "reservation")
    exclusiveActive = true
    granted.push(head)
    break
  }

  return [{ activeReaders, exclusiveActive, queue, ownership }, granted]
}

const notify = (transition: Transition) =>
  Effect.forEach(
    [...transition.granted, ...transition.cancelled],
    (waiter) => Deferred.succeed(waiter.ready, undefined),
    { discard: true },
  )

export const make = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make(initial)
  let nextId = 0

  const release = (id: number, mode: Mode) =>
    SynchronizedRef.modify(state, (current) => {
      const owner = current.ownership.get(id)
      if (owner !== "reservation" && owner !== "work") return [undefined, current] as const

      const ownership = new Map(current.ownership)
      ownership.delete(id)
      const released: State =
        mode === "shared"
          ? { ...current, activeReaders: current.activeReaders - 1, ownership }
          : { ...current, exclusiveActive: false, ownership }
      const [next, granted] = admit(released)
      return [{ granted, cancelled: [] } satisfies Transition, next] as const
    }).pipe(
      Effect.flatMap((transition) => (transition === undefined ? Effect.void : notify(transition))),
    )

  const makeReservation = (waiter: Waiter): Reservation => {
    const cancel: Effect.Effect<CancelResult> = SynchronizedRef.modify(state, (current): readonly [CancelOutcome, State] => {
      const owner = current.ownership.get(waiter.id)
      if (owner === "queued") {
        const ownership = new Map(current.ownership)
        ownership.delete(waiter.id)
        const withoutWaiter: State = {
          ...current,
          queue: current.queue.filter((item) => item.id !== waiter.id),
          ownership,
        }
        const [next, granted] = admit(withoutWaiter)
        return [{ result: "cancelled" as const, transition: { granted, cancelled: [waiter] } }, next] as const
      }

      if (owner === "reservation") {
        const ownership = new Map(current.ownership)
        ownership.delete(waiter.id)
        const released: State =
          waiter.mode === "shared"
            ? { ...current, activeReaders: current.activeReaders - 1, ownership }
            : { ...current, exclusiveActive: false, ownership }
        const [next, granted] = admit(released)
        return [{ result: "granted" as const, transition: { granted, cancelled: [] } }, next] as const
      }

      if (owner === "work") return [{ result: "transferred" as const, transition: undefined }, current] as const
      return [{ result: "finished" as const, transition: undefined }, current] as const
    }).pipe(
      Effect.flatMap(({ result, transition }) =>
        transition === undefined ? Effect.succeed(result) : notify(transition).pipe(Effect.as(result)),
      ),
    )

    return {
      await: Deferred.await(waiter.ready).pipe(Effect.onInterrupt(() => cancel.pipe(Effect.asVoid))),
      transfer: SynchronizedRef.modify(state, (current) => {
        if (current.ownership.get(waiter.id) !== "reservation") return [undefined, current] as const
        const ownership = new Map(current.ownership)
        ownership.set(waiter.id, "work")
        const lease: Lease = {
          release: release(waiter.id, waiter.mode),
        }
        return [lease, { ...current, ownership }] as const
      }),
      cancel,
    }
  }

  const reserve = (mode: Mode): Effect.Effect<Reservation, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const waiter: Waiter = {
          id: ++nextId,
          mode,
          ready: Deferred.makeUnsafe<void>(),
        }
        const transition = yield* SynchronizedRef.modify(state, (current) => {
          const ownership = new Map(current.ownership)
          ownership.set(waiter.id, "queued")
          const queued = { ...current, queue: [...current.queue, waiter], ownership }
          const [next, granted] = admit(queued)
          return [{ granted, cancelled: [] } satisfies Transition, next] as const
        })
        yield* notify(transition)
        return makeReservation(waiter)
      }),
      (reservation) => reservation.cancel.pipe(Effect.asVoid),
    )

  return {
    reserveShared: reserve("shared"),
    reserveExclusive: reserve("exclusive"),
  } satisfies Interface
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [],
})

export const acquireProcess = (scope: Scope.Scope) =>
  Layer.buildWithMemoMap(layer, memoMap, scope).pipe(Effect.map((context) => Context.get(context, Service)))
