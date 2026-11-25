export * as SessionRunCoordinator from "./run-coordinator.js"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"
import type { Promotable } from "./inbox.js"
import { SessionGenerationAdmission } from "./generation-admission.js"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, Reason = never> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Snapshots keys genuinely draining: owned and not stopping. Settlement windows are excluded. */
  readonly draining: Effect.Effect<ReadonlySet<Key>>
  /** Checks ownership for one key, including cleanup and terminal settlement. */
  readonly isActive: (key: Key) => Effect.Effect<boolean>
  /** Starts an execution while idle, or joins the active execution and returns its exit. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Rings the doorbell: an idle key starts an execution; an active one drains again before settling. */
  readonly wake: (key: Key, scope?: Promotable) => Effect.Effect<void>
  /**
   * Stops the active execution and clears its doorbell. No-op when idle. Resolves once the
   * interruption is accepted, not when cleanup settles: the execution fiber finishes its
   * finalizers and settled hook on its own time. Returns whether an active execution was
   * interrupted.
   */
  readonly interrupt: (key: Key, reason?: Reason) => Effect.Effect<boolean>
  /** Why the key's execution is being stopped, once `interrupt` stopped it; undefined for teardown or when running. */
  readonly interruption: (key: Key) => Reason | undefined
  /** Resolves once no execution is active for the key. Returns immediately when already idle and never starts work. */
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

/**
 * One execution is a busy period for one key: one fiber that drains from the first wake
 * until the key would stay idle. `pendingWake` is the doorbell: work recorded during the
 * execution rings it with the scope that work needs, and the execution loop drains again
 * instead of ending. The doorbell closes the gap between a drain's last eligibility check
 * and the idle transition, since those cannot be one atomic step. `done` resolves joiners
 * with this execution's exit.
 */
type Execution<E, Reason> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void>
  scope: Promotable
  pendingWake?: Promotable
  stopping: boolean
  interruptionReason?: Reason
}

/** Used when a coordinator has no generation admission to hold. */
const noLease: SessionGenerationAdmission.Lease = { release: Effect.void }
const acquireNoLease: Effect.Effect<SessionGenerationAdmission.Lease> = Effect.succeed(noLease)

/**
 * ```text
 *              wake | run
 *      idle ──────────────▶ execution (one fiber)
 *                             drain ⟲ doorbell rung mid-drain
 *                             │ exit (settled hook runs)
 *      doorbell quiet ◀───────┴───────▶ doorbell rung
 *      idle, waiters get exit          successor execution,
 *                                      waiters get this exit
 * ```
 */
export const make = <Key, E, Reason = never>(options: {
  readonly drain: (key: Key, force: boolean, scope: Promotable) => Effect.Effect<void, E>
  /** Holds shared generation admission for this complete busy period, including settlement. */
  readonly admission?: { readonly acquireShared: Effect.Effect<SessionGenerationAdmission.Lease> }
  /** Runs once when a process-local busy period begins, before its first drain. */
  readonly started?: (key: Key) => Effect.Effect<void>
  /**
   * Runs in the execution fiber for every exit, including interruption, after the final
   * drain and before the execution settles (waiters resolve after it completes).
   */
  readonly settled?: (key: Key, exit: Exit.Exit<void, E>, reason?: Reason) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E, Reason>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const executions = new Map<Key, Execution<E, Reason>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const loop = (key: Key, execution: Execution<E, Reason>, force: boolean): Effect.Effect<void, E> =>
      Effect.suspend(() => options.drain(key, force, execution.scope)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (execution.stopping || execution.pendingWake === undefined) return Effect.void
            execution.scope = execution.pendingWake
            execution.pendingWake = undefined
            // Trampoline so drains that complete synchronously cannot grow the stack.
            return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, false)))
          }),
        ),
      )

    const start = (key: Key, force: boolean, scope: Promotable) => {
      const execution: Execution<E, Reason> = {
        done: Deferred.makeUnsafe<void, E>(),
        scope,
        stopping: false,
      }
      executions.set(key, execution)
      // One terminal observation per busy period. It stays inside the shared lease, so an exclusive
      // acquisition (a fallback-config update, for instance) cannot slip in between the last drain and
      // the durable terminal. A period cancelled while parked at admission never took the lease, so it
      // observes its exit below the acquisition instead; the guard keeps that report to exactly once.
      let observed = false
      const observe = (exit: Exit.Exit<void, E>) =>
        observed
          ? Effect.void
          : Effect.sync(() => {
              observed = true
              execution.owner = undefined
            }).pipe(Effect.andThen(options.settled?.(key, exit, execution.interruptionReason) ?? Effect.void))
      // The leading yield lets `owner` be assigned before the drain can settle, and keeps
      // failing self-waking executions from growing the stack across successor starts.
      // Drains start one tick after wake; callers observe progress through events or run.
      execution.owner = fork(
        Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.suspend(() =>
              (options.admission?.acquireShared ?? acquireNoLease).pipe(
                Effect.flatMap((lease) =>
                  Effect.uninterruptible(options.started?.(key) ?? Effect.void)
                    .pipe(Effect.andThen(loop(key, execution, force)))
                    .pipe(Effect.onExit(observe))
                    // The lease is released only after the terminal observation, so an exclusive
                    // acquisition cannot slip between the last drain and the durable terminal.
                    .pipe(Effect.ensuring(lease.release)),
                ),
                // A period cancelled while parked at admission never took the lease, so it observes
                // below the acquisition instead; the guard above keeps that to one observation.
                Effect.onExit(observe),
              ),
            ),
          ),
          // A period cancelled at its leading yield, or while parked at admission before the lease was
          // taken, never reaches the observations above; this is where it observes its exit.
          Effect.onExit(observe),
          Effect.onExit((exit) => Effect.sync(() => settle(key, execution, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      return execution
    }

    // A doorbell that survives the execution loop (rung after the loop decided to end, or
    // during failure or interruption cleanup) starts a fresh execution for the remaining work.
    const settle = (key: Key, execution: Execution<E, Reason>, exit: Exit.Exit<void, E>) => {
      if (execution.pendingWake) start(key, false, execution.pendingWake)
      else executions.delete(key)
      Deferred.doneUnsafe(execution.done, exit)
    }

    const isActive = (key: Key) => Effect.sync(() => executions.has(key))

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        const execution = executions.get(key)
        if (execution !== undefined) {
          // A stopping execution refuses joiners: wait out its cleanup, then run fresh.
          if (execution.stopping)
            return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(run(key)))
          return Deferred.await(execution.done)
        }
        return Deferred.await(start(key, true, "input").done)
      })

    const wake = (key: Key, scope: Promotable = "input") =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution !== undefined) {
          // Coalesced wakes keep the widest scope: "input" subsumes "steer".
          execution.pendingWake = execution.pendingWake === "input" ? "input" : scope
          return
        }
        start(key, false, scope)
      })

    const interrupt = (key: Key, reason?: Reason): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution === undefined || execution.stopping) return false
        if (execution.owner === undefined) {
          // Settlement window: the owner exited but the settled hook has not finished. The
          // terminal outcome is already decided, so no reason attaches — but the interrupt
          // still claims the recorded wakes so settle does not start a dead-intent successor.
          execution.pendingWake = undefined
          return false
        }
        execution.stopping = true
        // Wakes recorded so far belong to the interrupted intent; the interrupt claims them.
        // Wakes arriving during cleanup are new admissions and restart normally at settle.
        execution.pendingWake = undefined
        execution.interruptionReason = reason
        // Fire and forget: nobody benefits from waiting out cleanup here, and callers like
        // the interrupt endpoint must acknowledge immediately even when finalizers are slow.
        fork(Fiber.interrupt(execution.owner))
        return true
      })

    // One execution's `done` already spans coalesced continuations; re-check after it
    // settles to cover a successor execution started by a late doorbell.
    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const execution = executions.get(key)
        if (execution === undefined) return Effect.void
        return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(awaitIdle(key)))
      })

    const interruption = (key: Key) => executions.get(key)?.interruptionReason

    const draining = Effect.sync(
      () =>
        new Set(
          [...executions.entries()].flatMap(([key, execution]) =>
            execution.owner !== undefined && !execution.stopping ? [key] : [],
          ),
        ),
    )

    return {
      active: Effect.sync(() => new Set(executions.keys())),
      draining,
      isActive,
      run,
      wake,
      interrupt,
      interruption,
      awaitIdle,
    }
  })
