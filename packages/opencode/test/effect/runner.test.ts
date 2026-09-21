import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Ref, Scope } from "effect"
import { GenerationGate } from "@opencode-ai/core/session/generation-gate"
import { Runner } from "@/effect/runner"
import { it } from "../lib/effect"

const waitForState = <A, E>(runner: Runner.Runner<A, E>, tag: Runner.State<A, E>["_tag"]) =>
  Effect.gen(function* () {
    while (runner.state._tag !== tag) yield* Effect.yieldNow
  }).pipe(Effect.timeout("1 second"))

describe("Runner", () => {
  // --- ensureRunning semantics ---

  it.live(
    "ensureRunning starts work and returns result",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.ensureRunning(Effect.succeed("hello"))
      expect(result).toBe("hello")
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "ensureRunning propagates work failures",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const exit = yield* runner.ensureRunning(Effect.fail("boom")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "concurrent callers share the same run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        yield* Effect.sleep("10 millis")
        return "shared"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(work), runner.ensureRunning(work)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("shared")
      expect(b).toBe("shared")
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "concurrent callers all receive same error",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const work = Effect.gen(function* () {
        yield* Effect.sleep("10 millis")
        return yield* Effect.fail("boom")
      })

      const [a, b] = yield* Effect.all(
        [runner.ensureRunning(work).pipe(Effect.exit), runner.ensureRunning(work).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      )

      expect(Exit.isFailure(a)).toBe(true)
      expect(Exit.isFailure(b)).toBe(true)
    }),
  )

  it.live(
    "ensureRunning can be called again after previous run completes",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      expect(yield* runner.ensureRunning(Effect.succeed("first"))).toBe("first")
      expect(yield* runner.ensureRunning(Effect.succeed("second"))).toBe("second")
    }),
  )

  it.live(
    "second ensureRunning ignores new work if already running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const ran = yield* Ref.make<string[]>([])

      const first = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "first"])
        yield* Effect.sleep("50 millis")
        return "first-result"
      })
      const second = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "second"])
        return "second-result"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(first), runner.ensureRunning(second)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("first-result")
      expect(b).toBe("first-result")
      expect(yield* Ref.get(ran)).toEqual(["first"])
    }),
  )

  // --- cancel semantics ---

  it.live(
    "cancel interrupts running work",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0)
            return yield* Effect.never.pipe(Effect.as("never"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(runner.busy).toBe(true)
      expect(runner.state._tag).toBe("Running")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live(
    "cancel on idle is a no-op",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      yield* runner.cancel
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "cancel with onInterrupt resolves callers gracefully",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("never"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      yield* runner.cancel

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("fallback")
    }),
  )

  it.live(
    "cancel with queued callers resolves all",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })

      const a = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      const b = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* runner.cancel

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA)) expect(exitA.value).toBe("fallback")
      if (Exit.isSuccess(exitB)) expect(exitB.value).toBe("fallback")
    }),
  )

  it.live(
    "work can be started after cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      yield* runner.cancel
      yield* Fiber.await(fiber)

      const result = yield* runner.ensureRunning(Effect.succeed("after-cancel"))
      expect(result).toBe("after-cancel")
    }),
  )

  it.live(
    "cancel does not deadlock when replacement work starts before interrupted run exits",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const hit = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const runner = Runner.make<string>(s)
        const first = Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(hit, undefined)),
          Effect.ensuring(Deferred.await(hold)),
          Effect.as("first"),
        )

        const a = yield* runner.ensureRunning(first).pipe(Effect.exit, Effect.forkChild)
        yield* waitForState(runner, "Running")

        const stop = yield* runner.cancel.pipe(Effect.forkChild)
        yield* Deferred.await(hit).pipe(Effect.timeout("250 millis"))

        const b = yield* runner.ensureRunning(Deferred.await(done).pipe(Effect.as("second"))).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(runner.busy).toBe(true)

        yield* Deferred.succeed(hold, undefined)
        const stopExit = yield* Fiber.await(stop).pipe(Effect.timeout("250 millis"))
        expect(Exit.isSuccess(stopExit)).toBe(true)

        expect(runner.busy).toBe(true)
        yield* Deferred.succeed(done, undefined)
        expect(yield* Fiber.join(b).pipe(Effect.timeout("250 millis"))).toBe("second")
        expect(runner.busy).toBe(false)

        const exit = yield* Fiber.join(a)
        expect(Exit.isFailure(exit)).toBe(true)
      }).pipe(
        Effect.ensuring(
          Effect.all([Deferred.succeed(hold, undefined), Deferred.succeed(done, undefined)], { discard: true }).pipe(
            Effect.ignore,
          ),
        ),
      )
    }),
  )

  // --- shell semantics ---

  it.live(
    "shell runs exclusively",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.startShell(Effect.succeed("shell-done"))
      expect(result).toBe("shell-done")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "shell rejects when run is active",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never.pipe(Effect.as("x"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started).pipe(Effect.timeout("250 millis"))
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Running") yield* Effect.yieldNow
      }).pipe(Effect.timeout("250 millis"))

      const exit = yield* runner.startShell(Effect.succeed("nope")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      yield* runner.cancel
      yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
    }),
  )

  it.live(
    "shell rejects when another shell is running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("first"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const exit = yield* runner.startShell(Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Busy)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
    }),
  )

  it.live(
    "cancel interrupts shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ignored"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const stop = yield* runner.cancel.pipe(Effect.forkChild)
      const stopExit = yield* Fiber.await(stop).pipe(Effect.timeout("250 millis"))
      expect(Exit.isSuccess(stopExit)).toBe(true)
      expect(runner.busy).toBe(false)

      const shellExit = yield* Fiber.await(sh)
      expect(Exit.isFailure(shellExit)).toBe(true)

      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "cancel does not mask shell defects",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("interrupted") })
      const ready = yield* Latch.make()

      const sh = yield* runner
        .startShell(
          Effect.gen(function* () {
            yield* ready.open
            return yield* Effect.never.pipe(Effect.as("ignored"))
          }).pipe(Effect.ensuring(Effect.die("boom"))),
          ready,
        )
        .pipe(Effect.forkChild)
      yield* ready.await.pipe(Effect.timeout("250 millis"))

      yield* runner.cancel
      expect(Exit.isFailure(yield* Fiber.await(sh))).toBe(true)
    }),
  )

  // --- shell→run handoff ---

  it.live(
    "ensureRunning queues behind shell then runs after",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell-result"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")
      expect(runner.state._tag).toBe("Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("run-result")).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("run-result")
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "multiple ensureRunning callers share the queued run behind shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        return "run"
      })
      const a = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      const b = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "cancel during shell_then_run cancels both",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)

      const sh = yield* runner.startShell(Effect.never.pipe(Effect.as("aborted"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live(
    "holds RunHandle admission through cleanup and lets joiners finish ahead of a queued writer",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const reserve = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const refresh = () => Effect.succeed(runner)
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()
      let runs = 0

      const first = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++runs).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(finish)),
            Effect.ensuring(Deferred.succeed(cleaned, undefined)),
            Effect.as("done"),
          ),
          reserve,
          refresh,
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const writer = yield* gate.reserveExclusive
      const writerWaiting = yield* Deferred.make<void>()
      const writerStarted = yield* Deferred.make<void>()
      const finishWriter = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(writerWaiting, undefined)
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        expect(runner.state._tag).toBe("Idle")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* Deferred.await(finishWriter)
        yield* lease.release
      }).pipe(Effect.forkChild)
      yield* Deferred.await(writerWaiting)

      const joiner = yield* runner.ensureRunningAdmitted(Effect.succeed("ignored"), reserve, refresh).pipe(Effect.forkChild)
      // Give the joiner its deterministic scheduler turn while the run is held.
      yield* Effect.yieldNow
      yield* Deferred.succeed(finish, undefined)
      expect(yield* Fiber.join(first)).toBe("done")
      expect(yield* Fiber.join(joiner)).toBe("done")
      yield* Deferred.await(cleaned)
      yield* Deferred.await(writerStarted)
      expect(runs).toBe(1)
      yield* Deferred.succeed(finishWriter, undefined)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "holds ShellHandle admission through shell cleanup",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const reserve = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const refresh = () => Effect.succeed(runner)
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()

      const shell = yield* runner
        .startShellAdmitted(
          Deferred.succeed(started, undefined)
            .pipe(Effect.andThen(Deferred.await(finish)), Effect.ensuring(Deferred.succeed(cleaned, undefined)), Effect.as("shell")),
          undefined,
          reserve,
          refresh,
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const writer = yield* gate.reserveExclusive
      const writerStarted = yield* Deferred.make<void>()
      const finishWriter = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        expect(runner.state._tag).toBe("Idle")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* Deferred.await(finishWriter)
        yield* lease.release
      }).pipe(Effect.forkChild)
      expect(yield* Deferred.isDone(writerStarted)).toBeFalse()

      yield* Deferred.succeed(finish, undefined)
      expect(yield* Fiber.join(shell)).toBe("shell")
      yield* Deferred.await(cleaned)
      yield* Deferred.await(writerStarted)
      yield* Deferred.succeed(finishWriter, undefined)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "runs ShellThenRun admitted before a writer ahead of that writer",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const reserve = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const refresh = () => Effect.succeed(runner)
      const shellStarted = yield* Deferred.make<void>()
      const finishShellWork = yield* Deferred.make<void>()
      const runStarted = yield* Deferred.make<void>()
      const finishRun = yield* Deferred.make<void>()
      const requestReserved = yield* Deferred.make<void>()
      let runs = 0

      const shell = yield* runner
        .startShellAdmitted(
          Deferred.succeed(shellStarted, undefined).pipe(Effect.andThen(Deferred.await(finishShellWork)), Effect.as("shell")),
          undefined,
          reserve,
          refresh,
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(shellStarted)
      const reserveFollowUp = () =>
        Effect.gen(function* () {
          const reservation = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          yield* Deferred.succeed(requestReserved, undefined)
          return reservation
        })
      const run = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++runs).pipe(
            Effect.andThen(Deferred.succeed(runStarted, undefined)),
            Effect.andThen(Deferred.await(finishRun)),
            Effect.as("run"),
          ),
          reserveFollowUp,
          refresh,
        )
        .pipe(Effect.forkChild)
      // The reservation is already granted while the shell reader is active.
      // This latch establishes that it entered the FIFO before the writer.
      yield* Deferred.await(requestReserved)

      const writer = yield* gate.reserveExclusive
      const writerStarted = yield* Deferred.make<void>()
      const finishWriter = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* Deferred.await(finishWriter)
        yield* lease.release
      }).pipe(Effect.forkChild)

      yield* Deferred.succeed(finishShellWork, undefined)
      yield* Fiber.join(shell)
      yield* Deferred.await(runStarted)
      expect(yield* Deferred.isDone(writerStarted)).toBeFalse()
      yield* Deferred.succeed(finishRun, undefined)
      expect(yield* Fiber.join(run)).toBe("run")
      yield* Deferred.await(writerStarted)
      expect(runs).toBe(1)
      yield* Deferred.succeed(finishWriter, undefined)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "queues ShellThenRun behind an earlier writer and releases it when pending work is cancelled",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const reserve = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const refresh = () => Effect.succeed(runner)
      const shellStarted = yield* Deferred.make<void>()
      const finishShellWork = yield* Deferred.make<void>()
      const requestReserved = yield* Deferred.make<void>()
      let runs = 0

      const shell = yield* runner
        .startShellAdmitted(
          Deferred.succeed(shellStarted, undefined).pipe(Effect.andThen(Deferred.await(finishShellWork)), Effect.as("shell")),
          undefined,
          reserve,
          refresh,
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(shellStarted)
      const writer = yield* gate.reserveExclusive
      const writerStarted = yield* Deferred.make<void>()
      const finishWriter = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* Deferred.await(finishWriter)
        yield* lease.release
      }).pipe(Effect.forkChild)

      const reserveFollowUp = () =>
        Effect.gen(function* () {
          const reservation = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          yield* Deferred.succeed(requestReserved, undefined)
          return reservation
        })
      const run = yield* runner
        .ensureRunningAdmitted(Effect.sync(() => ++runs).pipe(Effect.as("run")), reserveFollowUp, refresh)
        .pipe(Effect.forkChild)
      // The request reservation is queued behind the writer, so this latch
      // confirms the stale Runner has observed the request without admitting it.
      yield* Deferred.await(requestReserved)
      expect(runner.state._tag).toBe("Shell")
      expect(yield* Deferred.isDone(writerStarted)).toBeFalse()

      yield* Fiber.interrupt(run)
      expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)
      yield* runner.cancel
      yield* Deferred.await(writerStarted)
      expect(runs).toBe(0)
      yield* Deferred.succeed(finishWriter, undefined)
      yield* Fiber.join(writerFiber)
      yield* Deferred.succeed(finishShellWork, undefined)
    }),
  )

  it.live(
    "re-resolves the Runner after a writer before admitting Shell follow-up work",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const oldRunner = Runner.make<string>(scope)
      const newRunner = Runner.make<string>(scope)
      const currentRunner = yield* Ref.make(oldRunner)
      const shellStarted = yield* Deferred.make<void>()
      const finishShell = yield* Deferred.make<void>()
      const requestReserved = yield* Deferred.make<void>()
      const refreshed = yield* Deferred.make<void>()
      const runStarted = yield* Deferred.make<void>()
      const finishRun = yield* Deferred.make<void>()
      const reserveShell = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const shell = yield* oldRunner
        .startShellAdmitted(
          Deferred.succeed(shellStarted, undefined).pipe(Effect.andThen(Deferred.await(finishShell)), Effect.as("shell")),
          undefined,
          reserveShell,
          () => Effect.succeed(oldRunner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(shellStarted)

      const writer = yield* gate.reserveExclusive
      const writerStarted = yield* Deferred.make<void>()
      const finishWriter = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* Deferred.await(finishWriter)
        yield* lease.release
      }).pipe(Effect.forkChild)

      let runs = 0
      const reserveFollowUp = () =>
        Effect.gen(function* () {
          const reservation = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          yield* Deferred.succeed(requestReserved, undefined)
          return reservation
        })
      const refresh = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(refreshed, undefined)
          return yield* Ref.get(currentRunner)
        })
      const request = yield* oldRunner
        .ensureRunningAdmitted(
          Effect.sync(() => ++runs).pipe(
            Effect.andThen(Deferred.succeed(runStarted, undefined)),
            Effect.andThen(Deferred.await(finishRun)),
            Effect.as("run"),
          ),
          reserveFollowUp,
          refresh,
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(requestReserved)
      expect(oldRunner.state._tag).toBe("Shell")
      expect(yield* Deferred.isDone(refreshed)).toBe(false)

      yield* Deferred.succeed(finishShell, undefined)
      expect(yield* Fiber.join(shell)).toBe("shell")
      yield* Deferred.await(writerStarted)
      expect(oldRunner.state._tag).toBe("Idle")
      yield* Ref.set(currentRunner, newRunner)
      expect(yield* Deferred.isDone(refreshed)).toBe(false)
      yield* Deferred.succeed(finishWriter, undefined)
      yield* Fiber.join(writerFiber)

      yield* Deferred.await(refreshed)
      yield* Deferred.await(runStarted)
      expect(oldRunner.state._tag).toBe("Idle")
      expect(newRunner.state._tag).toBe("Running")
      expect(runs).toBe(1)
      yield* Deferred.succeed(finishRun, undefined)
      expect(yield* Fiber.join(request)).toBe("run")

      const finalWriter = yield* gate.reserveExclusive
      yield* finalWriter.await
      const finalLease = yield* finalWriter.transfer
      expect(finalLease).toBeDefined()
      yield* finalLease!.release
    }),
  )

  it.live(
    "releases a redundant admitted run and joins work committed before its Runner recheck",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const aAtRefresh = yield* Deferred.make<void>()
      const allowARefresh = yield* Deferred.make<void>()
      const aCancelled = yield* Deferred.make<void>()
      const bStarted = yield* Deferred.make<void>()
      const finishB = yield* Deferred.make<void>()
      const writerAwaitEntered = yield* Deferred.make<void>()
      const writerStarted = yield* Deferred.make<void>()
      let aRuns = 0
      let bRuns = 0
      let aCancelCalls = 0

      const reserveA = () =>
        Effect.gen(function* () {
          const actual = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          return {
            await: actual.await,
            transfer: actual.transfer,
            cancel: Effect.gen(function* () {
              const result = yield* actual.cancel
              aCancelCalls += 1
              yield* Deferred.succeed(aCancelled, undefined)
              return result
            }),
          } satisfies GenerationGate.Reservation
        })
      const reserveB = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)

      const requestA = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++aRuns).pipe(Effect.as("A")),
          reserveA,
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(aAtRefresh, undefined)
              yield* Deferred.await(allowARefresh)
              return runner
            }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(aAtRefresh)

      const requestB = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++bRuns).pipe(
            Effect.andThen(Deferred.succeed(bStarted, undefined)),
            Effect.andThen(Deferred.await(finishB)),
            Effect.as("B"),
          ),
          reserveB,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(bStarted)
      expect(runner.state._tag).toBe("Running")

      const writer = yield* Effect.provideService(gate.reserveExclusive, Scope.Scope, scope)
      const writerFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(writerAwaitEntered, undefined)
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer reservation was cancelled")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)
      yield* Deferred.await(writerAwaitEntered)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)

      yield* Deferred.succeed(allowARefresh, undefined)
      yield* Deferred.await(aCancelled)
      expect(aCancelCalls).toBe(1)
      expect(aRuns).toBe(0)
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)

      yield* Deferred.succeed(finishB, undefined)
      expect(yield* Fiber.join(requestB)).toBe("B")
      expect(yield* Fiber.join(requestA)).toBe("B")
      yield* Deferred.await(writerStarted)
      expect(bRuns).toBe(1)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "preserves Busy and releases a shell lease when admitted work commits before ShellHandle",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const transferWon = yield* Deferred.make<void>()
      const allowTransferReturn = yield* Deferred.make<void>()
      const runStarted = yield* Deferred.make<void>()
      const finishRun = yield* Deferred.make<void>()
      const writerAwaitEntered = yield* Deferred.make<void>()
      const writerStarted = yield* Deferred.make<void>()
      let shellRuns = 0
      let runCount = 0
      let shellLeaseReleases = 0

      const reserveShell = () =>
        Effect.gen(function* () {
          const actual = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          return {
            await: actual.await,
            transfer: Effect.gen(function* () {
              const lease = yield* actual.transfer
              if (lease === undefined) return undefined
              yield* Deferred.succeed(transferWon, undefined)
              yield* Deferred.await(allowTransferReturn)
              return {
                release: Effect.gen(function* () {
                  shellLeaseReleases += 1
                  yield* lease.release
                }),
              }
            }),
            cancel: actual.cancel,
          } satisfies GenerationGate.Reservation
        })
      const reserveRun = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const shell = yield* runner
        .startShellAdmitted(
          Effect.sync(() => ++shellRuns).pipe(Effect.as("shell")),
          undefined,
          reserveShell,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.succeed("busy" as const)), Effect.forkChild)
      yield* Deferred.await(transferWon)

      const run = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++runCount).pipe(
            Effect.andThen(Deferred.succeed(runStarted, undefined)),
            Effect.andThen(Deferred.await(finishRun)),
            Effect.as("run"),
          ),
          reserveRun,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(runStarted)
      expect(runner.state._tag).toBe("Running")

      const writer = yield* Effect.provideService(gate.reserveExclusive, Scope.Scope, scope)
      const writerFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(writerAwaitEntered, undefined)
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer reservation was cancelled")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)
      yield* Deferred.await(writerAwaitEntered)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)

      yield* Deferred.succeed(allowTransferReturn, undefined)
      expect(yield* Fiber.join(shell)).toBe("busy")
      expect(runner.state._tag).toBe("Running")
      expect(shellRuns).toBe(0)
      expect(shellLeaseReleases).toBe(1)
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)

      yield* Deferred.succeed(finishRun, undefined)
      expect(yield* Fiber.join(run)).toBe("run")
      yield* Deferred.await(writerStarted)
      expect(runCount).toBe(1)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "cancels a granted shell reservation before ShellHandle ownership without leaking a reader",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const reservationGranted = yield* Deferred.make<void>()
      const allowShellToContinue = yield* Deferred.make<void>()
      const writerAwaitEntered = yield* Deferred.make<void>()
      const writerStarted = yield* Deferred.make<void>()
      let shellRuns = 0
      let cancellationResult: GenerationGate.CancelResult | undefined

      const reserveShell = () =>
        Effect.gen(function* () {
          const actual = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          return {
            await: actual.await.pipe(
              Effect.andThen(Deferred.succeed(reservationGranted, undefined)),
              Effect.andThen(Deferred.await(allowShellToContinue)),
              Effect.onInterrupt(() =>
                actual.cancel.pipe(
                  Effect.tap((result) => Effect.sync(() => (cancellationResult = result))),
                  Effect.asVoid,
                ),
              ),
            ),
            transfer: actual.transfer,
            cancel: actual.cancel,
          } satisfies GenerationGate.Reservation
        })
      const shell = yield* runner
        .startShellAdmitted(
          Effect.sync(() => ++shellRuns).pipe(Effect.as("shell")),
          undefined,
          reserveShell,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(reservationGranted)

      const writer = yield* Effect.provideService(gate.reserveExclusive, Scope.Scope, scope)
      const writerFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(writerAwaitEntered, undefined)
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer reservation was cancelled")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)
      yield* Deferred.await(writerAwaitEntered)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)

      yield* Fiber.interrupt(shell)
      expect(Exit.isFailure(yield* Fiber.await(shell))).toBe(true)
      expect(cancellationResult).toBe("granted")
      expect(shellRuns).toBe(0)
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
      yield* Deferred.await(writerStarted)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "StartingRun cancellation wins before Gate transfer after admission",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const shellStarted = yield* Deferred.make<void>()
      const finishShell = yield* Deferred.make<void>()
      const transferEntered = yield* Deferred.make<void>()
      const allowTransfer = yield* Deferred.make<void>()
      const cancelEntered = yield* Deferred.make<void>()
      const runStarted = yield* Deferred.make<void>()
      let cancelCalls = 0
      const reserve = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const shell = yield* runner
        .startShellAdmitted(
          Deferred.succeed(shellStarted, undefined).pipe(Effect.andThen(Deferred.await(finishShell)), Effect.as("shell")),
          undefined,
          reserve,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(shellStarted)

      const requestReserved = yield* Deferred.make<void>()
      const requestReserve = () =>
        Effect.gen(function* () {
          const actual = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          const reservation: GenerationGate.Reservation = {
            await: actual.await,
            transfer: Effect.gen(function* () {
              yield* Deferred.succeed(transferEntered, undefined)
              yield* Deferred.await(allowTransfer)
              return yield* actual.transfer
            }),
            cancel: actual.cancel.pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  cancelCalls += 1
                  yield* Deferred.succeed(cancelEntered, undefined)
                }),
              ),
            ),
          }
          yield* Deferred.succeed(requestReserved, undefined)
          return reservation
        })
      let runs = 0
      const request = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++runs).pipe(Effect.andThen(Deferred.succeed(runStarted, undefined)), Effect.as("run")),
          requestReserve,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(requestReserved)
      yield* Effect.yieldNow
      expect(runner.state._tag).toBe("ShellThenRun")

      const writer = yield* gate.reserveExclusive
      const writerStarted = yield* Deferred.make<void>()
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)
      const writerFiber = yield* Effect.gen(function* () {
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)

      yield* Deferred.succeed(finishShell, undefined)
      yield* Deferred.await(transferEntered)
      const cancelFiber = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Deferred.await(cancelEntered)
      yield* Deferred.succeed(allowTransfer, undefined)

      expect(yield* Fiber.join(shell)).toBe("shell")
      yield* Fiber.join(cancelFiber)
      expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true)
      yield* Deferred.await(writerStarted)
      expect(runner.state._tag).toBe("Idle")
      expect(yield* Deferred.isDone(runStarted)).toBe(false)
      expect(runs).toBe(0)
      expect(cancelCalls).toBe(1)
      yield* Fiber.join(writerFiber)

      const finalReader = yield* gate.reserveShared
      yield* finalReader.await
      const finalLease = yield* finalReader.transfer
      expect(finalLease).toBeDefined()
      yield* finalLease!.release
    }),
  )

  it.live(
    "RunHandle owns admission when start wins before cancellation",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const started = yield* Deferred.make<void>()
      const keepRunning = yield* Deferred.make<void>()
      const cleanupEntered = yield* Deferred.make<void>()
      const allowCleanup = yield* Deferred.make<void>()
      let leaseReleases = 0
      const reserve = () =>
        Effect.gen(function* () {
          const actual = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          return {
            await: actual.await,
            cancel: actual.cancel,
            transfer: actual.transfer.pipe(
              Effect.map((lease) =>
                lease === undefined
                  ? undefined
                  : {
                      release: Effect.gen(function* () {
                        leaseReleases += 1
                        yield* lease.release
                      }),
                    },
              ),
            ),
          } satisfies GenerationGate.Reservation
        })
      let runs = 0
      const run = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++runs)
            .pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(keepRunning)),
              Effect.onInterrupt(() => Deferred.succeed(cleanupEntered, undefined).pipe(Effect.andThen(Deferred.await(allowCleanup)))),
              Effect.as("run"),
            ),
          reserve,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const writer = yield* gate.reserveExclusive
      const writerStarted = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)

      const cancelFiber = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Deferred.await(cleanupEntered)
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)
      yield* Deferred.succeed(allowCleanup, undefined)
      yield* Fiber.join(cancelFiber)
      expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)
      yield* Deferred.await(writerStarted)
      expect(runs).toBe(1)
      expect(leaseReleases).toBe(1)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "StartingRun releases a transferred lease when cancellation wins before RunHandle commit",
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* GenerationGate.make
      const runner = Runner.make<string>(scope)
      const shellStarted = yield* Deferred.make<void>()
      const finishShell = yield* Deferred.make<void>()
      const transferWon = yield* Deferred.make<void>()
      const allowTransferReturn = yield* Deferred.make<void>()
      const cancelReturned = yield* Deferred.make<void>()
      const requestReserved = yield* Deferred.make<void>()
      let leaseReleases = 0
      let runs = 0
      const reserveShell = () => Effect.provideService(gate.reserveShared, Scope.Scope, scope)
      const shell = yield* runner
        .startShellAdmitted(
          Deferred.succeed(shellStarted, undefined).pipe(Effect.andThen(Deferred.await(finishShell)), Effect.as("shell")),
          undefined,
          reserveShell,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(shellStarted)

      const requestReserve = () =>
        Effect.gen(function* () {
          const actual = yield* Effect.provideService(gate.reserveShared, Scope.Scope, scope)
          yield* Deferred.succeed(requestReserved, undefined)
          return {
            await: actual.await,
            transfer: Effect.gen(function* () {
              const lease = yield* actual.transfer
              if (lease === undefined) return undefined
              yield* Deferred.succeed(transferWon, undefined)
              yield* Deferred.await(allowTransferReturn)
              return {
                release: Effect.gen(function* () {
                  leaseReleases += 1
                  yield* lease.release
                }),
              }
            }),
            cancel: actual.cancel.pipe(Effect.tap(() => Deferred.succeed(cancelReturned, undefined))),
          } satisfies GenerationGate.Reservation
        })
      const request = yield* runner
        .ensureRunningAdmitted(
          Effect.sync(() => ++runs).pipe(Effect.as("run")),
          requestReserve,
          () => Effect.succeed(runner),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(requestReserved)
      yield* Effect.yieldNow
      expect(runner.state._tag).toBe("ShellThenRun")

      const writer = yield* gate.reserveExclusive
      const writerStarted = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer was not granted")
        yield* Deferred.succeed(writerStarted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)

      yield* Deferred.succeed(finishShell, undefined)
      yield* Deferred.await(transferWon)
      const cancelFiber = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Deferred.await(cancelReturned)
      expect(yield* Deferred.isDone(writerStarted)).toBe(false)
      yield* Deferred.succeed(allowTransferReturn, undefined)

      expect(yield* Fiber.join(shell)).toBe("shell")
      yield* Fiber.join(cancelFiber)
      expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true)
      yield* Deferred.await(writerStarted)
      expect(runs).toBe(0)
      expect(leaseReleases).toBe(1)
      expect(runner.state._tag).toBe("Idle")
      yield* Fiber.join(writerFiber)
    }),
  )

  // --- lifecycle callbacks ---

  it.live(
    "onIdle fires when returning to idle from running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      yield* runner.ensureRunning(Effect.succeed("ok"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  it.live(
    "onIdle fires on cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      yield* runner.cancel
      yield* Fiber.await(fiber)
      expect(yield* Ref.get(count)).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live(
    "onBusy fires when shell starts",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onBusy: Ref.update(count, (n) => n + 1),
      })
      yield* runner.startShell(Effect.succeed("done"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  // --- busy flag ---

  it.live(
    "busy is true during run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.ensureRunning(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "busy is true during shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )
})
