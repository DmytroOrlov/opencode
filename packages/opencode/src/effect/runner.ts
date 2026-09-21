import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"
import { GenerationGate } from "@opencode-ai/core/session/generation-gate"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E | Cancelled>
  readonly ensureRunningAdmitted: (
    work: Effect.Effect<A, E>,
    reserve: () => Effect.Effect<GenerationGate.Reservation>,
    refresh: () => Effect.Effect<Runner<A, E>>,
  ) => Effect.Effect<A, E>
  readonly ensureRunningReserved: (
    work: Effect.Effect<A, E>,
    reservation: GenerationGate.Reservation,
  ) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly startShellAdmitted: (
    work: Effect.Effect<A, E>,
    ready: Latch.Latch | undefined,
    reserve: () => Effect.Effect<GenerationGate.Reservation>,
    refresh: () => Effect.Effect<Runner<A, E>>,
  ) => Effect.Effect<A, E | Busy>
  readonly startShellReserved: (
    work: Effect.Effect<A, E>,
    ready: Latch.Latch | undefined,
    reservation: GenerationGate.Reservation,
  ) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
  lease?: GenerationGate.Lease
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
  lease?: GenerationGate.Lease
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
  admission?: { readonly reservation: GenerationGate.Reservation }
}

interface StartingRun<A, E> {
  id: number
  ready: Deferred.Deferred<void>
  run: PendingHandle<A, E>
  cancelRequested: boolean
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }
  | { readonly _tag: "StartingRun"; readonly starting: StartingRun<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  const finishRun = (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
    lease?: GenerationGate.Lease,
  ) =>
    SynchronizedRef.modify(
      ref,
      (st) =>
        [
          Effect.gen(function* () {
            if (st._tag === "Running" && st.run.id === id) yield* idle
            yield* complete(done, exit)
            if (lease !== undefined) yield* lease.release
          }),
          st._tag === "Running" && st.run.id === id ? ({ _tag: "Idle" } as const) : st,
        ] as const,
    ).pipe(Effect.flatten)

  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
    lease?: GenerationGate.Lease,
  ) =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit, lease)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber, lease } satisfies RunHandle<A, E>
    })

  const cancelAdmission = (admission?: PendingHandle<A, E>["admission"]) => {
    if (admission?.reservation !== undefined) return admission.reservation.cancel.pipe(Effect.asVoid)
    return Effect.void
  }

  const startPendingRun = (starting: StartingRun<A, E>) => {
    let lease: GenerationGate.Lease | undefined
    const recoverFailure = SynchronizedRef.modify(ref, (st) => [
      Effect.gen(function* () {
        yield* Deferred.fail(starting.run.done, new Cancelled()).pipe(Effect.asVoid)
        yield* Deferred.succeed(starting.ready, undefined)
        if (lease !== undefined) yield* lease.release
      }),
      st._tag === "StartingRun" && st.starting.id === starting.id ? ({ _tag: "Idle" } as const) : st,
    ] as const).pipe(Effect.flatten)

    return Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const pending = starting.run
        const admission = pending.admission
        if (admission?.reservation !== undefined) yield* admission.reservation.await
        lease = admission?.reservation === undefined ? undefined : yield* admission.reservation.transfer

        const committed = yield* SynchronizedRef.modifyEffect(
          ref,
          Effect.fnUntraced(function* (st) {
            if (st._tag !== "StartingRun" || st.starting.id !== starting.id) {
              return [
                Effect.gen(function* () {
                  yield* Deferred.fail(pending.done, new Cancelled()).pipe(Effect.asVoid)
                  yield* Deferred.succeed(starting.ready, undefined)
                  return { release: lease }
                }),
                st,
              ] as const
            }
            if (st.starting.cancelRequested || (admission?.reservation !== undefined && lease === undefined)) {
              return [
                Effect.gen(function* () {
                  yield* Deferred.fail(pending.done, new Cancelled()).pipe(Effect.asVoid)
                  yield* Deferred.succeed(starting.ready, undefined)
                  return { release: lease }
                }),
                { _tag: "Idle" } as const,
              ] as const
            }

            const run = yield* startRun(pending.work, pending.done, lease)
            return [
              Effect.gen(function* () {
                yield* Deferred.succeed(starting.ready, undefined)
                return { release: undefined }
              }),
              { _tag: "Running", run } as const,
            ] as const
          }),
        ).pipe(Effect.flatten)

        if (committed.release !== undefined) yield* committed.release.release
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? recoverFailure : Effect.void))),
    )
  }

  const finishShell = (id: number, lease?: GenerationGate.Lease) =>
    SynchronizedRef.modify<State<A, E>, { readonly idle: boolean; readonly starting: StartingRun<A, E> | undefined }>(ref, (st) => {
      if (st._tag === "Shell" && st.shell.id === id) return [{ idle: true, starting: undefined }, { _tag: "Idle" }] as const
      if (st._tag === "ShellThenRun" && st.shell.id === id) {
        const starting: StartingRun<A, E> = {
          id,
          ready: Deferred.makeUnsafe<void>(),
          run: st.run,
          cancelRequested: false,
        }
        return [{ idle: false, starting }, { _tag: "StartingRun", starting }] as const
      }
      return [{ idle: false, starting: undefined }, st] as const
    }).pipe(
      Effect.flatMap(({ idle: becameIdle, starting }) =>
        Effect.gen(function* () {
          if (lease !== undefined) yield* lease.release
          if (becameIdle) yield* idle
          if (starting !== undefined) yield* startPendingRun(starting)
        }),
      ),
    )

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect<State<A, E>, Effect.Effect<A, E | Cancelled>, E | Cancelled, never>(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running":
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "StartingRun":
            return [awaitDone(st.starting.run.done), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const shellResult = (fiber: Fiber.Fiber<A, E>, cancelled: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      const exit = yield* Fiber.await(fiber)
      if (Exit.isSuccess(exit)) return exit.value
      if (
        Cause.hasInterruptsOnly(exit.cause) ||
        ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
      ) {
        if (onInterrupt) return yield* onInterrupt
        return yield* Effect.die(new Cancelled())
      }
      return yield* Effect.failCause(exit.cause)
    })

  const startShellCore = (
    work: Effect.Effect<A, E>,
    ready?: Latch.Latch,
    lease?: GenerationGate.Lease,
    restoreWait: (wait: Effect.Effect<A, E>) => Effect.Effect<A, E> = (wait) => wait,
  ): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const result: Effect.Effect<{ readonly busy: true } | { readonly busy: false; readonly wait: Effect.Effect<A, E> }> =
            Effect.succeed({ busy: true })
          return [result, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id, lease)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber, lease } satisfies ShellHandle<A, E>
        const result: Effect.Effect<{ readonly busy: true } | { readonly busy: false; readonly wait: Effect.Effect<A, E> }> =
          Effect.succeed({ busy: false, wait: shellResult(fiber, cancelled) })
        return [result, { _tag: "Shell", shell }] as const
      }),
    ).pipe(
      Effect.flatten,
      Effect.flatMap((result): Effect.Effect<A, E | Busy> =>
        result.busy
          ? (lease?.release ?? Effect.void).pipe(Effect.andThen(Effect.fail(new Busy())))
          : restoreWait(result.wait),
      ),
    )

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    startShellCore(work, ready)

  const ensureRunningAdmitted: Runner<A, E>["ensureRunningAdmitted"] = (work, reserve, refresh) =>
    Effect.uninterruptibleMask((restore) =>
      SynchronizedRef.modify<State<A, E>, Deferred.Deferred<A, E | Cancelled> | undefined>(ref, (st) => {
        if (st._tag === "Running") return [st.run.done, st] as const
        if (st._tag === "ShellThenRun") return [st.run.done, st] as const
        if (st._tag === "StartingRun") return [st.starting.run.done, st] as const
        return [undefined, st] as const
      }).pipe(
        Effect.flatMap((joined) => {
          if (joined !== undefined) return restore(awaitDone(joined))
          return Effect.gen(function* () {
            const reservation = yield* reserve()
            yield* restore(reservation.await)
            const fresh = yield* refresh()
            return yield* fresh.ensureRunningReserved(work, reservation)
          })
        }),
      ),
    )

  const ensureRunningReserved: Runner<A, E>["ensureRunningReserved"] = (work, reservation) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        type Decision =
          | { readonly kind: "join"; readonly done: Deferred.Deferred<A, E | Cancelled> }
          | { readonly kind: "pending"; readonly done: Deferred.Deferred<A, E | Cancelled> }
          | { readonly kind: "start"; readonly starting: StartingRun<A, E> }
        const decision = yield* SynchronizedRef.modify<State<A, E>, Decision>(ref, (st) => {
          if (st._tag === "Running") return [{ kind: "join" as const, done: st.run.done }, st] as const
          if (st._tag === "ShellThenRun") return [{ kind: "join" as const, done: st.run.done }, st] as const
          if (st._tag === "StartingRun") return [{ kind: "join" as const, done: st.starting.run.done }, st] as const
          if (st._tag === "Shell") {
            const run: PendingHandle<A, E> = {
              id: next(),
              done: Deferred.makeUnsafe<A, E | Cancelled>(),
              work,
              admission: { reservation },
            }
            return [{ kind: "pending" as const, done: run.done }, { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          const run: PendingHandle<A, E> = {
            id: next(),
            done: Deferred.makeUnsafe<A, E | Cancelled>(),
            work,
            admission: { reservation },
          }
          const starting: StartingRun<A, E> = {
            id: run.id,
            ready: Deferred.makeUnsafe<void>(),
            run,
            cancelRequested: false,
          }
          return [{ kind: "start" as const, starting }, { _tag: "StartingRun", starting }] as const
        })

        if (decision.kind === "join") {
          yield* reservation.cancel
          return yield* restore(awaitDone(decision.done))
        }
        if (decision.kind === "pending") return yield* restore(awaitDone(decision.done))
        yield* startPendingRun(decision.starting)
        return yield* restore(awaitDone(decision.starting.run.done))
      }),
    )

  const startShellAdmitted: Runner<A, E>["startShellAdmitted"] = (work, ready, reserve, refresh) =>
    Effect.uninterruptibleMask((restore) =>
      SynchronizedRef.modify(ref, (st) => [st._tag === "Idle", st] as const).pipe(
        Effect.flatMap((isIdle) => {
          if (!isIdle) return Effect.fail(new Busy())
          return Effect.gen(function* () {
            const reservation = yield* reserve()
            yield* restore(reservation.await)
            const fresh = yield* refresh()
            return yield* restore(fresh.startShellReserved(work, ready, reservation))
          })
        }),
      ),
    )

  const startShellReserved: Runner<A, E>["startShellReserved"] = (work, ready, reservation) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const lease = yield* reservation.transfer
        if (lease === undefined) return yield* Effect.fail(new Busy())
        return yield* startShellCore(work, ready, lease, restore)
      }),
    )

  const cancel = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* cancelAdmission(st.run.admission)
            yield* stopShell(st.shell)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "StartingRun":
        return [
          Effect.gen(function* () {
            yield* cancelAdmission(st.starting.run.admission)
            yield* Deferred.await(st.starting.ready)
          }),
          { _tag: "StartingRun", starting: { ...st.starting, cancelRequested: true } } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    ensureRunningAdmitted,
    ensureRunningReserved,
    startShell,
    startShellAdmitted,
    startShellReserved,
    cancel,
  }
}

export * as Runner from "./runner"
