export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"
import { GenerationGate } from "./generation-gate"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one ordered follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Admission = {
  readonly reservation: GenerationGate.Reservation
  state: "queued" | "granted" | "active" | "finished"
}

type PendingWake = {
  readonly ready: Deferred.Deferred<Admission | undefined>
  reservation?: GenerationGate.Reservation
  state: "reserving" | "queued" | "granted" | "active" | "cancelled"
  monitor?: Fiber.Fiber<void, never>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  admission?: Admission
  pendingWake?: PendingWake
  stopping: boolean
}

const openReservation: GenerationGate.Reservation = {
  await: Effect.void,
  transfer: Effect.succeed({ release: Effect.void }),
  cancel: Effect.succeed("finished"),
}

export const make = <Key, E>(options: {
  readonly gate?: GenerationGate.Interface
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const scope = yield* Scope.Scope

    const reserve = options.gate
      ? Effect.provideService(options.gate.reserveShared, Scope.Scope, scope)
      : Effect.succeed(openReservation)

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      stopping: false,
    })

    const markGranted = (_key: Key, entry: Entry<E>, pending: PendingWake, admission: Admission) =>
      admission.reservation.await.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (entry.pendingWake === pending && pending.state === "queued") pending.state = "granted"
          }),
        ),
        Effect.asVoid,
      )

    const settle = (key: Key, entry: Entry<E>, admission: Admission, exit: Exit.Exit<void, E>) =>
      Effect.gen(function* () {
        admission.state = "finished"
        if (entry.admission === admission) entry.admission = undefined

        while (entry.pendingWake !== undefined) {
          const pending = entry.pendingWake
          const successorAdmission = yield* Deferred.await(pending.ready)
          if (entry.pendingWake !== pending) {
            if (successorAdmission !== undefined) yield* successorAdmission.reservation.cancel
            continue
          }

          entry.pendingWake = undefined
          if (successorAdmission === undefined) {
            pending.state = "cancelled"
            continue
          }

          if (Exit.isSuccess(exit) && !entry.stopping) {
            entry.admission = successorAdmission
            start(key, entry, successorAdmission, false, true, pending)
            return
          }

          const successor = makeEntry()
          successor.admission = successorAdmission
          active.set(key, successor)
          start(key, successor, successorAdmission, false, true, pending)
          Deferred.doneUnsafe(entry.done, exit)
          return
        }

        if (active.get(key) === entry) active.delete(key)
        Deferred.doneUnsafe(entry.done, exit)
      })

    const start = (
      key: Key,
      entry: Entry<E>,
      admission: Admission,
      force: boolean,
      successor = false,
      pending?: PendingWake,
    ) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        Deferred.await(ready).pipe(
          Effect.andThen(successor ? Effect.yieldNow : Effect.void),
          Effect.andThen(
            Effect.uninterruptibleMask((restore) =>
              restore(admission.reservation.await).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    admission.state = "granted"
                  }),
                ),
                Effect.andThen(Effect.suspend(() => admission.reservation.transfer)),
                Effect.flatMap((lease) => {
                  if (lease === undefined) return Effect.void
                  admission.state = "active"
                  if (pending !== undefined) pending.state = "active"
                  entry.admission = admission
                  return restore(Effect.suspend(() => options.drain(key, force))).pipe(Effect.ensuring(lease.release))
                }),
              ),
            ),
          ),
          Effect.onExit((exit) => settle(key, entry, admission, exit)),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      Deferred.doneUnsafe(ready, Effect.void)
    }

    const makeAdmission = Effect.gen(function* () {
      return { reservation: yield* reserve, state: "queued" } satisfies Admission
    })

    const startIdle = (key: Key, force: boolean) =>
      Effect.gen(function* () {
        const entry = makeEntry()
        active.set(key, entry)
        const admission = yield* makeAdmission
        entry.admission = admission
        start(key, entry, admission, force)
        return entry
      })

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        return startIdle(key, true).pipe(Effect.flatMap((next) => restore(Deferred.await(next.done))))
      })

    const recordWake = (key: Key, entry: Entry<E>) =>
      Effect.gen(function* () {
        if (entry.pendingWake !== undefined) return

        const pending: PendingWake = {
          ready: Deferred.makeUnsafe<Admission | undefined>(),
          state: "reserving",
        }
        entry.pendingWake = pending
        const admission = yield* makeAdmission
        if (entry.pendingWake !== pending) {
          pending.state = "cancelled"
          Deferred.doneUnsafe(pending.ready, Effect.succeed(undefined))
          yield* admission.reservation.cancel
          return
        }

        pending.reservation = admission.reservation
        pending.state = "queued"
        Deferred.doneUnsafe(pending.ready, Effect.succeed(admission))
        pending.monitor = fork(markGranted(key, entry, pending, admission))
      })

    const wake = (key: Key) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const entry = active.get(key)
          if (entry !== undefined) {
            yield* recordWake(key, entry)
            return
          }
          yield* startIdle(key, false)
        }),
      )

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry === undefined) return Effect.void
        entry.stopping = true

        const pending = entry.pendingWake
        entry.pendingWake = undefined
        if (pending !== undefined) {
          pending.state = "cancelled"
          if (pending.reservation === undefined) Deferred.doneUnsafe(pending.ready, Effect.succeed(undefined))
        }
        const cancelPending = pending?.reservation?.cancel.pipe(Effect.asVoid) ?? Effect.void
        const current = entry.admission
        const cancelCurrent = current?.reservation.cancel.pipe(Effect.asVoid) ?? Effect.void
        const stopOwner = entry.owner === undefined ? Effect.void : Fiber.interrupt(entry.owner)
        return Effect.all([cancelPending, cancelCurrent, stopOwner], { concurrency: "unbounded", discard: true })
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt }
  })
