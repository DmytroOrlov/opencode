import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GenerationGate } from "@opencode-ai/core/session/generation-gate"
import { FallbackRuntimeIntent } from "../../src/session/fallback-runtime-intent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { Server } from "../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { InstanceStore } from "../../src/project/instance-store"
import * as Project from "../../src/project/project"
import { registerDisposer } from "../../src/effect/instance-registry"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Event as ServerEvent } from "../../src/server/event"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

type State = { username?: string; shell?: string; fallback?: ConfigV1.Info["fallback"] }
const instanceInput = (directory: string) => ({
  directory,
  worktree: `${directory}/worktree`,
  project: { id: "prj_phase_g" } as Project.Info,
})
type Harness = {
  readonly reserved: Queue.Queue<GenerationGate.Reservation>
  readonly transferWon: Queue.Queue<GenerationGate.Lease>
  readonly updateEntered: Queue.Queue<ConfigV1.Info>
  readonly completed: Ref.Ref<boolean>
  readonly transferCount: Ref.Ref<number>
  readonly failUpdate: Ref.Ref<boolean>
  readonly state: Ref.Ref<State>
  readonly transferRelease: Ref.Ref<Deferred.Deferred<void> | undefined>
  readonly gate: GenerationGate.Interface
  readonly fallbackRuntimeIntent: FallbackRuntimeIntent.Interface
}

class PhaseG extends Context.Service<PhaseG, Harness>()("@test/GlobalConfigPhaseG") {}

const harnessLayer = Layer.effect(
  PhaseG,
  Effect.gen(function* () {
    const actual = yield* GenerationGate.make
    const reserved = yield* Queue.unbounded<GenerationGate.Reservation>()
    const transferWon = yield* Queue.unbounded<GenerationGate.Lease>()
    const updateEntered = yield* Queue.unbounded<ConfigV1.Info>()
    const completed = yield* Ref.make(false)
    const transferCount = yield* Ref.make(0)
    const failUpdate = yield* Ref.make(false)
    const state = yield* Ref.make<State>({ username: "before" })
    const transferRelease = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined)
    const fallbackRuntimeIntent = yield* FallbackRuntimeIntent.make

    const reserveExclusive: GenerationGate.Interface["reserveExclusive"] = Effect.gen(function* () {
      const reservation = yield* actual.reserveExclusive
      const wrapped: GenerationGate.Reservation = {
        await: reservation.await,
        cancel: reservation.cancel,
        transfer: Effect.gen(function* () {
          const lease = yield* reservation.transfer
          if (lease === undefined) return undefined
          yield* Ref.update(transferCount, (count) => count + 1)
          yield* Queue.offer(transferWon, lease)
          const pause = yield* Ref.get(transferRelease)
          if (pause) yield* Deferred.await(pause)
          return lease
        }),
      }
      yield* Queue.offer(reserved, wrapped)
      return wrapped
    })
    const gate: GenerationGate.Interface = { ...actual, reserveExclusive }

    return PhaseG.of({
      reserved,
      transferWon,
      updateEntered,
      completed,
      transferCount,
      failUpdate,
      state,
      transferRelease,
      gate,
      fallbackRuntimeIntent,
    })
  }),
)

const configLayer = Layer.effect(
  Config.Service,
  Effect.gen(function* () {
    const harness = yield* PhaseG
    const updateGlobal = (patch: ConfigV1.Info) =>
      Effect.gen(function* () {
        if (yield* Ref.get(harness.failUpdate)) return yield* Effect.die("simulated config application defect")
        yield* Queue.offer(harness.updateEntered, patch)
        const previous = yield* Ref.get(harness.state)
        const next = { ...previous, ...patch }
        yield* Ref.set(harness.state, next)
        return { info: next as ConfigV1.Info, changed: JSON.stringify(previous) !== JSON.stringify(next) }
      })
    return Config.Service.of({
      get: () => Effect.succeed({} as ConfigV1.Info),
      getGlobal: () => Ref.get(harness.state).pipe(Effect.map((value) => value as ConfigV1.Info)),
      getConsoleState: () => Effect.die("unexpected getConsoleState"),
      update: () => Effect.die("unexpected update"),
      updateGlobal,
      invalidate: () => Effect.void,
      directories: () => Effect.succeed([]),
      waitForDependencies: () => Effect.void,
    })
  }),
)

const instanceStoreLayer = LayerNode.compile(InstanceStore.node, [
  [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
])

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.effect(GenerationGate.Service, Effect.map(PhaseG, (harness) => harness.gate))),
  Layer.provide(
    Layer.effect(
      FallbackRuntimeIntent.Service,
      Effect.map(PhaseG, (harness) => harness.fallbackRuntimeIntent),
    ),
  ),
  Layer.provide(configLayer),
  Layer.provideMerge(instanceStoreLayer),
  Layer.provideMerge(harnessLayer),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const phaseG = testEffect(apiLayer)

const patch = (payload: ConfigV1.Info) =>
  HttpClientRequest.patch("/global/config").pipe(HttpClientRequest.bodyJsonUnsafe(payload), HttpClient.execute)

const startPatch = (harness: Harness, payload: ConfigV1.Info) =>
  patch(payload).pipe(Effect.tap(() => Ref.set(harness.completed, true)), Effect.forkChild)

const watchGlobalDisposed = () =>
  Effect.gen(function* () {
    const disposed = yield* Deferred.make<void>()
    const listener = (event: GlobalEvent) => {
      if (event.payload.type === ServerEvent.Disposed.type) Effect.runSync(Deferred.succeed(disposed, undefined))
    }
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    return disposed
  })

describe("ordinary global config update", () => {
  phaseG.live(
    "stages only an owned fallback before exclusive admission",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const intent = harness.fallbackRuntimeIntent
      const readerReservation = yield* harness.gate.reserveShared
      yield* readerReservation.await
      const reader = yield* readerReservation.transfer
      yield* Effect.addFinalizer(() => (reader ? reader.release : Effect.void))
      const fallback = { model: "test/model-b", variant: "raw" }

      const writer = yield* startPatch(harness, { fallback })
      yield* Queue.take(harness.reserved)

      expect(yield* intent.current()).toEqual({ revision: 1, override: { type: "some", value: fallback } })
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })
      expect(yield* Ref.get(harness.completed)).toBe(false)

      yield* reader!.release
      const response = yield* Fiber.join(writer)
      expect(response.status).toBe(200)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before", fallback })
      expect(yield* intent.current()).toEqual({ revision: 1, override: { type: "none" } })
    }),
  )

  phaseG.live(
    "keeps unrelated fields in a mixed patch behind writer admission",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const intent = harness.fallbackRuntimeIntent
      const readerReservation = yield* harness.gate.reserveShared
      yield* readerReservation.await
      const reader = yield* readerReservation.transfer
      yield* Effect.addFinalizer(() => (reader ? reader.release : Effect.void))
      const fallback = { model: "test/model-b", variant: null }

      const writer = yield* startPatch(harness, { fallback, username: "after" })
      yield* Queue.take(harness.reserved)

      expect(yield* intent.current()).toEqual({ revision: 1, override: { type: "some", value: fallback } })
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })
      expect(yield* Ref.get(harness.completed)).toBe(false)

      yield* reader!.release
      expect((yield* Fiber.join(writer)).status).toBe(200)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "after", fallback })
    }),
  )

  phaseG.live(
    "does not let cancelled stale cleanup erase a newer fallback intent",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const intent = harness.fallbackRuntimeIntent
      const readerReservation = yield* harness.gate.reserveShared
      yield* readerReservation.await
      const reader = yield* readerReservation.transfer
      yield* Effect.addFinalizer(() => (reader ? reader.release : Effect.void))
      const fallbackB = { model: "test/model-b", variant: null }
      const fallbackC = { model: "test/model-c", variant: "latest" }

      const first = yield* startPatch(harness, { fallback: fallbackB })
      yield* Queue.take(harness.reserved)
      const second = yield* startPatch(harness, { fallback: fallbackC })
      yield* Queue.take(harness.reserved)
      expect(yield* intent.current()).toEqual({ revision: 2, override: { type: "some", value: fallbackC } })

      yield* Fiber.interrupt(first)
      expect(yield* intent.current()).toEqual({ revision: 2, override: { type: "some", value: fallbackC } })
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })

      yield* reader!.release
      expect((yield* Fiber.join(second)).status).toBe(200)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before", fallback: fallbackC })
      expect(yield* intent.current()).toEqual({ revision: 2, override: { type: "none" } })
    }),
  )

  phaseG.live(
    "keeps a failed persistent fallback separate from temporary runtime intent",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const intent = harness.fallbackRuntimeIntent
      const readerReservation = yield* harness.gate.reserveShared
      yield* readerReservation.await
      const reader = yield* readerReservation.transfer
      yield* Effect.addFinalizer(() => (reader ? reader.release : Effect.void))
      const fallback = { model: "test/model-b", variant: null }
      yield* Ref.set(harness.failUpdate, true)

      const writer = yield* startPatch(harness, { fallback })
      yield* Queue.take(harness.reserved)
      expect(yield* intent.current()).toEqual({ revision: 1, override: { type: "some", value: fallback } })
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })

      yield* reader!.release
      expect((yield* Fiber.join(writer)).status).toBe(500)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })
      expect(yield* intent.current()).toEqual({ revision: 1, override: { type: "none" } })
    }),
  )

  phaseG.live(
    "waits for a shared reader before mutation and response",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const readerReservation = yield* harness.gate.reserveShared
      yield* readerReservation.await
      const reader = yield* readerReservation.transfer
      expect(reader).toBeDefined()

      const writer = yield* startPatch(harness, { username: "after" })
      const reservation = yield* Queue.take(harness.reserved)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })
      expect(yield* Ref.get(harness.completed)).toBe(false)
      expect(yield* Ref.get(harness.transferCount)).toBe(0)
      yield* reader!.release
      yield* awaitWithTimeout(Queue.take(harness.transferWon), "writer transfer never completed")
      yield* awaitWithTimeout(Queue.take(harness.updateEntered), "config application never started")
      const response = yield* Fiber.join(writer)
      expect(response.status).toBe(200)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "after" })
      expect(reservation).toBeDefined()
    }),
  )

  phaseG.live(
    "serializes a no-op writer and skips disposal",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const globalDisposed = yield* watchGlobalDisposed()
      const store = yield* InstanceStore.Service
      const input = instanceInput("/phase-g-noop")
      yield* store.load(input)
      const disposals = yield* Ref.make(0)
      const unregister = registerDisposer(async () => {
        await Effect.runPromise(Ref.update(disposals, (count) => count + 1))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      const readerReservation = yield* harness.gate.reserveShared
      yield* readerReservation.await
      const reader = yield* readerReservation.transfer
      const writer = yield* startPatch(harness, { username: "before" })
      yield* Queue.take(harness.reserved)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })
      expect(yield* Ref.get(harness.completed)).toBe(false)
      yield* reader!.release
      const response = yield* Fiber.join(writer)
      expect(response.status).toBe(200)
      expect(yield* Ref.get(disposals)).toBe(0)
      expect(yield* Deferred.isDone(globalDisposed)).toBe(false)
      const later = yield* harness.gate.reserveExclusive
      yield* later.await
      const lease = yield* later.transfer
      expect(lease).toBeDefined()
      yield* lease!.release
    }),
  )

  phaseG.live(
    "cancels a queued writer before grant without mutation or a retained reservation",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const globalDisposed = yield* watchGlobalDisposed()
      const store = yield* InstanceStore.Service
      const input = instanceInput("/phase-g-cancel")
      const oldEntry = yield* store.load(input)
      const disposals = yield* Ref.make(0)
      const unregister = registerDisposer(async (directory) => {
        if (directory === input.directory) await Effect.runPromise(Ref.update(disposals, (count) => count + 1))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      const readerReservation = yield* harness.gate.reserveShared
      yield* readerReservation.await
      const reader = yield* readerReservation.transfer
      const writer = yield* startPatch(harness, { username: "cancelled" })
      yield* Queue.take(harness.reserved)
      yield* Fiber.interrupt(writer)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "before" })
      expect(yield* Ref.get(disposals)).toBe(0)
      expect(yield* Deferred.isDone(globalDisposed)).toBe(false)

      yield* reader!.release
      const later = yield* harness.gate.reserveExclusive
      yield* later.await
      const lease = yield* later.transfer
      expect(lease).toBeDefined()
      yield* lease!.release
    }),
  )

  phaseG.live(
    "holds the writer and response through cleanup after commit",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const globalDisposed = yield* watchGlobalDisposed()
      const store = yield* InstanceStore.Service
      const input = instanceInput("/phase-g-cleanup")
      const oldEntry = yield* store.load(input)
      const cleanupRelease = yield* Deferred.make<void>()
      const cleanupEntered = yield* Deferred.make<void>()
      const unregister = registerDisposer(async (directory) => {
        if (directory !== input.directory) return
        await Effect.runPromise(Deferred.succeed(cleanupEntered, undefined))
        await Effect.runPromise(Deferred.await(cleanupRelease))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      const writer = yield* startPatch(harness, { username: "after" })
      yield* Deferred.await(cleanupEntered)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "after" })
      expect(yield* Ref.get(harness.completed)).toBe(false)

      const nextReader = yield* harness.gate.reserveShared
      const readerFiber = yield* Effect.gen(function* () {
        yield* nextReader.await
        const lease = yield* nextReader.transfer
        if (lease) yield* lease.release
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Ref.get(harness.completed)).toBe(false)

      yield* Deferred.succeed(cleanupRelease, undefined)
      const response = yield* Fiber.join(writer)
      expect(response.status).toBe(200)
      expect(yield* Fiber.join(readerFiber)).toBeUndefined()
      const replacement = yield* store.load(input)
      expect(replacement).not.toBe(oldEntry)
      expect(yield* Deferred.isDone(globalDisposed)).toBe(true)
    }),
  )

  phaseG.live(
    "continues after transfer wins even when the request fiber is interrupted",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const globalDisposed = yield* watchGlobalDisposed()
      const store = yield* InstanceStore.Service
      const input = instanceInput("/phase-g-transfer")
      yield* store.load(input)
      const transferRelease = yield* Deferred.make<void>()
      const cleanupRelease = yield* Deferred.make<void>()
      const cleanupEntered = yield* Deferred.make<void>()
      const unregister = registerDisposer(async (directory) => {
        if (directory !== input.directory) return
        await Effect.runPromise(Deferred.succeed(cleanupEntered, undefined))
        await Effect.runPromise(Deferred.await(cleanupRelease))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      yield* Ref.set(harness.transferRelease, transferRelease)
      const writer = yield* startPatch(harness, { username: "after" })
      yield* Queue.take(harness.reserved)
      yield* Queue.take(harness.transferWon)
      const interruption = yield* Fiber.interrupt(writer).pipe(Effect.forkChild)
      yield* Deferred.succeed(transferRelease, undefined)
      yield* Deferred.await(cleanupEntered)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "after" })
      yield* Queue.take(harness.updateEntered)
      // The server's protected application finishes before another writer grants.
      const next = yield* harness.gate.reserveExclusive
      const nextFiber = yield* Effect.gen(function* () {
        yield* next.await
        const lease = yield* next.transfer
        if (lease) yield* lease.release
      }).pipe(Effect.forkChild)
      expect(yield* Ref.get(harness.completed)).toBe(false)
      yield* Deferred.succeed(cleanupRelease, undefined)
      yield* Fiber.join(interruption)
      expect(yield* Deferred.isDone(globalDisposed)).toBe(true)
      yield* Fiber.join(nextFiber)
    }),
  )

  phaseG.live(
    "serializes two config writers FIFO and merges the second patch against the first commit",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const store = yield* InstanceStore.Service
      const input = instanceInput("/phase-g-writers")
      yield* store.load(input)
      const cleanupRelease = yield* Deferred.make<void>()
      const cleanupEntered = yield* Deferred.make<void>()
      const unregister = registerDisposer(async (directory) => {
        if (directory !== input.directory) return
        await Effect.runPromise(Deferred.succeed(cleanupEntered, undefined))
        await Effect.runPromise(Deferred.await(cleanupRelease))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
      const first = yield* startPatch(harness, { username: "first" })
      yield* Deferred.await(cleanupEntered)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "first" })

      const second = yield* startPatch(harness, { shell: "/bin/zsh" })
      yield* Queue.take(harness.reserved)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "first" })
      expect(yield* Ref.get(harness.completed)).toBe(false)

      yield* Deferred.succeed(cleanupRelease, undefined)
      expect((yield* Fiber.join(first)).status).toBe(200)
      expect((yield* Fiber.join(second)).status).toBe(200)
      expect(yield* Ref.get(harness.state)).toEqual({ username: "first", shell: "/bin/zsh" })
    }),
  )

  phaseG.live(
    "keeps explicit global dispose outside GenerationGate",
    Effect.gen(function* () {
      const harness = yield* PhaseG
      const globalDisposed = yield* watchGlobalDisposed()
      const store = yield* InstanceStore.Service
      const input = instanceInput("/phase-g-explicit-dispose")
      const oldEntry = yield* store.load(input)
      const disposals = yield* Ref.make(0)
      const unregister = registerDisposer(async (directory) => {
        if (directory === input.directory) await Effect.runPromise(Ref.update(disposals, (count) => count + 1))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unregister))

      const writer = yield* harness.gate.reserveExclusive
      yield* writer.await
      const writerLease = yield* writer.transfer
      expect(writerLease).toBeDefined()
      const response = yield* HttpClientRequest.post("/global/dispose").pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toBe(true)
      expect(yield* Ref.get(disposals)).toBe(1)
      expect(yield* Deferred.isDone(globalDisposed)).toBe(true)
      expect(yield* store.load(input)).not.toBe(oldEntry)
      yield* writerLease!.release
    }),
  )

  phaseG.live(
    "keeps invalid payloads on the validation path without returning conflict",
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch("/global/config")
        .pipe(HttpClientRequest.bodyJsonUnsafe({ share: "invalid" }), HttpClient.execute)
        .pipe(Effect.catch(() => Effect.die("request transport failed")))
      expect(response.status).toBe(400)
      expect(response.status).not.toBe(409)
      const harness = yield* PhaseG
      yield* Ref.set(harness.failUpdate, true)
      const defect = yield* patch({ username: "defect" })
      expect(defect.status).toBe(500)
      expect(defect.status).not.toBe(409)
    }),
  )
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const phaseHGlobalConfigFiles = ["opencode.jsonc", "opencode.json", "config.json"]

async function snapshotGlobalConfig() {
  return Promise.all(
    phaseHGlobalConfigFiles.map(async (name) => {
      const file = path.join(Global.Path.config, name)
      try {
        return { file, content: await fs.readFile(file) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        return { file, content: undefined }
      }
    }),
  )
}

async function restoreGlobalConfig(snapshot: Awaited<ReturnType<typeof snapshotGlobalConfig>>) {
  for (const item of snapshot) {
    if (item.content) {
      await fs.mkdir(path.dirname(item.file), { recursive: true })
      await fs.writeFile(item.file, item.content)
    } else {
      await fs.rm(item.file, { force: true })
    }
  }
  await AppRuntime.runPromise(Config.Service.use((config) => config.invalidate()))
}

function observeExclusiveReservations(gate: GenerationGate.Interface) {
  const original = gate.reserveExclusive
  // The production service object remains the owner; this property replacement only observes
  // reservations and delegates each one to its original Effect.
  const queue = Effect.runSync(Queue.unbounded<GenerationGate.Reservation>())
  const transferCount = Effect.runSync(Ref.make(0))
  const effect = original.pipe(
    Effect.map((reservation): GenerationGate.Reservation => ({
      ...reservation,
      transfer: reservation.transfer.pipe(
        Effect.tap((lease) => (lease ? Ref.update(transferCount, (count) => count + 1) : Effect.void)),
      ),
    })),
    Effect.tap((reservation) => Queue.offer(queue, reservation)),
  )
  Object.defineProperty(gate, "reserveExclusive", { configurable: true, value: effect })
  return {
    queue,
    transferCount,
    restore: () => Object.defineProperty(gate, "reserveExclusive", { configurable: true, value: original }),
  }
}

function observeRuntimeIntentClears(intent: FallbackRuntimeIntent.Interface) {
  const original = intent.clearIfCurrent
  // Same observation seam as the gate observer: the production service object stays the
  // owner, and each revision-conditional cleanup call is recorded before delegating.
  const cleared = Effect.runSync(Queue.unbounded<number>())
  const effect = (revision: number) =>
    original(revision).pipe(Effect.tap(() => Queue.offer(cleared, revision).pipe(Effect.asVoid)))
  Object.defineProperty(intent, "clearIfCurrent", { configurable: true, value: effect })
  return {
    cleared,
    restore: () => Object.defineProperty(intent, "clearIfCurrent", { configurable: true, value: original }),
  }
}

async function startPhaseHListener() {
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

async function getGlobalConfig(listener: Awaited<ReturnType<typeof startPhaseHListener>>) {
  const response = await fetch(new URL("/global/config", listener.url))
  expect(response.status).toBe(200)
  return (await response.json()) as { autoupdate?: boolean; fallback?: ConfigV1.Info["fallback"] }
}

async function patchGlobalConfig(
  listener: Awaited<ReturnType<typeof startPhaseHListener>>,
  autoupdate: boolean,
) {
  return fetch(new URL("/global/config", listener.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoupdate }),
  })
}

type FetchOutcome =
  | { readonly type: "response"; readonly status: number }
  | { readonly type: "rejected"; readonly errorName: string }

function sendFallbackPatch(
  listener: Awaited<ReturnType<typeof startPhaseHListener>>,
  fallback: { readonly model: string; readonly variant: string | null },
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  return fetch(new URL("/global/config", listener.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fallback }),
    ...(signal === undefined ? {} : { signal }),
  })
    .then((response) => ({ type: "response" as const, status: response.status }))
    .catch((error) => ({
      type: "rejected" as const,
      errorName: error instanceof Error ? error.name : String(error),
    }))
}

test("Default AppRuntime generation holds the real gate while Server.listen global config waits", async () => {
  const snapshot = await snapshotGlobalConfig()
  const tmp = await tmpdir({ config: { formatter: false, lsp: false } })
  const listener = await startPhaseHListener()
  const processScope = await Effect.runPromise(Scope.make())
  const gate = await Effect.runPromise(GenerationGate.acquireProcess(processScope))
  const writerObserver = observeExclusiveReservations(gate)
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const settled = Deferred.makeUnsafe<void>()
  const sessionID = SessionID.make("ses_phase_h_default_runtime")
  const result: SessionV1.WithParts = {
    info: SessionV1.Assistant.make({
      id: SessionV1.MessageID.make("msg_phase_h_default_runtime"),
      sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID: SessionV1.MessageID.make("msg_phase_h_default_runtime_parent"),
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test-provider"),
      mode: "build",
      agent: "build",
      path: { cwd: tmp.path, root: tmp.path },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    parts: [],
  }
  const instance = await InstanceRuntime.load({ directory: tmp.path })
  let configCompleted = false
  try {
    const generation = AppRuntime.runPromise(
      Effect.scoped(
        SessionRunState.Service.use((run) =>
          run.ensureRunning(
            sessionID,
            Effect.succeed(result),
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return result
            }),
          ),
        ).pipe(
          Effect.provideService(InstanceRef, instance),
          Effect.tap(() => Deferred.succeed(settled, undefined)),
          Effect.ensuring(Deferred.succeed(settled, undefined)),
        ),
      ),
    )
    await Effect.runPromise(Deferred.await(entered))

    const current = await getGlobalConfig(listener)
    const nextAutoupdate = current.autoupdate === false
    const configRequest = patchGlobalConfig(listener, nextAutoupdate).then((response) => {
      configCompleted = true
      return response
    })
    await Effect.runPromise(Queue.take(writerObserver.queue))

    expect(configCompleted).toBe(false)
    expect(await Effect.runPromise(Deferred.isDone(settled))).toBe(false)

    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect(await generation).toEqual(result)
    const response = await configRequest
    expect(response.status).toBe(200)
    expect((await response.json() as { autoupdate?: boolean }).autoupdate).toBe(nextAutoupdate)
  } finally {
    writerObserver.restore()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await InstanceRuntime.disposeInstance(instance)
    await listener.stop(true)
    await Effect.runPromise(Scope.close(processScope, Exit.void))
    await restoreGlobalConfig(snapshot)
    await tmp[Symbol.asyncDispose]()
  }
})

test("real HTTP AbortSignal frees the local caller while superseded and newer writers converge under FIFO", async () => {
  const snapshot = await snapshotGlobalConfig()
  const listener = await startPhaseHListener()
  const processScope = await Effect.runPromise(Scope.make())
  const gate = await Effect.runPromise(GenerationGate.acquireProcess(processScope))
  const intent = await Effect.runPromise(FallbackRuntimeIntent.acquireProcess(processScope))
  const writerObserver = observeExclusiveReservations(gate)
  const intentObserver = observeRuntimeIntentClears(intent)
  let reader: GenerationGate.Lease | undefined
  let controller: AbortController | undefined
  let requestB: Promise<FetchOutcome> | undefined
  let requestC: Promise<FetchOutcome> | undefined
  let bStaged = false
  let bCleanupObserved = false

  const g2Queued = Deferred.makeUnsafe<void>()
  const g2Transferred = Deferred.makeUnsafe<GenerationGate.Lease>()
  const g2Release = Deferred.makeUnsafe<void>()
  let g2Run: Promise<void> | undefined

  try {
    // Step 1 — hold a real shared GenerationGate lease A for the whole first half.
    reader = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reservation = yield* gate.reserveShared
          yield* reservation.await
          const lease = yield* reservation.transfer
          if (lease === undefined) return yield* Effect.die("shared admission did not transfer")
          return lease
        }),
      ),
    )

    const before = await getGlobalConfig(listener)
    const beforeIntent = await Effect.runPromise(intent.current())
    expect(beforeIntent.override).toEqual({ type: "none" })
    const revisionB = beforeIntent.revision + 1
    const revisionC = beforeIntent.revision + 2
    const fallbackB = { model: "test/model-b", variant: "raw" }
    const fallbackC = { model: "test/model-c", variant: "latest" }

    // Step 2 — send real fallback B through the listener with an abortable client fetch.
    controller = new AbortController()
    const bPromise = sendFallbackPatch(listener, fallbackB, controller.signal)
    requestB = bPromise
    const bReservation = await Effect.runPromise(
      awaitWithTimeout(Queue.take(writerObserver.queue), "writer B never reserved"),
    )
    expect(bReservation).toBeDefined()
    bStaged = true
    expect(await Effect.runPromise(intent.current())).toEqual({
      revision: revisionB,
      override: { type: "some", value: fallbackB },
    })
    expect(await Effect.runPromise(Ref.get(writerObserver.transferCount))).toBe(0)
    expect((await getGlobalConfig(listener)).fallback).toEqual(before.fallback)

    // Step 3 — abort only the B client. The local caller settles; the server writer is untouched.
    controller.abort()
    expect(controller.signal.aborted).toBe(true)
    const settledB = await Effect.runPromise(
      awaitWithTimeout(Effect.promise(() => bPromise), "aborted B client request did not settle promptly"),
    )
    expect(settledB).toEqual({ type: "rejected", errorName: "AbortError" })
    expect(await Effect.runPromise(Ref.get(writerObserver.transferCount))).toBe(0)
    expect(await Effect.runPromise(intent.current())).toEqual({
      revision: revisionB,
      override: { type: "some", value: fallbackB },
    })
    expect((await getGlobalConfig(listener)).fallback).toEqual(before.fallback)

    // Step 4 — queue a second shared reader G2 behind writer B as the ordering barrier.
    g2Run = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reservation = yield* gate.reserveShared
          yield* Deferred.succeed(g2Queued, undefined)
          yield* reservation.await
          const lease = yield* reservation.transfer
          if (lease === undefined) {
            yield* Effect.die("G2 shared admission did not transfer")
            return
          }
          yield* Deferred.succeed(g2Transferred, lease)
          yield* Deferred.await(g2Release)
          yield* lease.release
          return
        }),
      ),
    ).catch(() => undefined)
    await Effect.runPromise(awaitWithTimeout(Deferred.await(g2Queued), "G2 shared reservation never queued"))
    expect(await Effect.runPromise(Deferred.isDone(g2Transferred))).toBe(false)

    // Step 5 — send newer fallback C while A still holds; do not abort C.
    const cPromise = sendFallbackPatch(listener, fallbackC)
    requestC = cPromise
    await Effect.runPromise(awaitWithTimeout(Queue.take(writerObserver.queue), "writer C never reserved"))
    expect(await Effect.runPromise(intent.current())).toEqual({
      revision: revisionC,
      override: { type: "some", value: fallbackC },
    })
    expect(await Effect.runPromise(Ref.get(writerObserver.transferCount))).toBe(0)
    expect((await getGlobalConfig(listener)).fallback).toEqual(before.fallback)
    expect(await Effect.runPromise(Deferred.isDone(g2Transferred))).toBe(false)

    // Step 6 — release A: B becomes the queue head and persists, then G2 is admitted and holds C.
    await Effect.runPromise(reader.release)
    reader = undefined
    await Effect.runPromise(
      awaitWithTimeout(Deferred.await(g2Transferred), "G2 was never admitted behind writer B"),
    )
    expect(await Effect.runPromise(Ref.get(writerObserver.transferCount))).toBe(1)
    expect((await getGlobalConfig(listener)).fallback).toEqual(fallbackB)
    const clearedRevision = await Effect.runPromise(
      awaitWithTimeout(Queue.take(intentObserver.cleared), "writer B cleanup never ran"),
    )
    expect(clearedRevision).toBe(revisionB)
    bCleanupObserved = true
    // Intermediate durable window: B is durable while C is still the live recovery authority.
    expect(await Effect.runPromise(intent.current())).toEqual({
      revision: revisionC,
      override: { type: "some", value: fallbackC },
    })
    expect(await Effect.runPromise(Ref.get(writerObserver.transferCount))).toBe(1)
    expect(await Effect.runPromise(Deferred.isDone(g2Release))).toBe(false)

    // Step 7 — release G2: C transfers and completes normally.
    await Effect.runPromise(Deferred.succeed(g2Release, undefined))
    await Effect.runPromise(awaitWithTimeout(Effect.promise(() => g2Run!), "G2 shared lease never finished"))
    const settledC = await Effect.runPromise(
      awaitWithTimeout(Effect.promise(() => cPromise), "C request never settled"),
    )
    expect(settledC).toEqual({ type: "response", status: 200 })
    expect((await getGlobalConfig(listener)).fallback).toEqual(fallbackC)
    expect(await Effect.runPromise(intent.current())).toEqual({
      revision: revisionC,
      override: { type: "none" },
    })
    expect(await Effect.runPromise(Ref.get(writerObserver.transferCount))).toBe(2)

    // Step 8 — no lease/token leak: a later exclusive writer still reserves, transfers, releases.
    const later = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reservation = yield* gate.reserveExclusive
          yield* awaitWithTimeout(reservation.await, "gate never granted a later exclusive writer")
          const lease = yield* reservation.transfer
          if (lease === undefined) return yield* Effect.die("later exclusive writer did not transfer")
          yield* lease.release
          return true
        }),
      ),
    )
    expect(later).toBe(true)
    expect(await Effect.runPromise(Ref.get(writerObserver.transferCount))).toBe(3)
  } finally {
    controller?.abort()
    if (reader) await Effect.runPromise(reader.release)
    await Effect.runPromise(Deferred.succeed(g2Release, undefined))
    if (requestB) await requestB
    if (g2Run) await g2Run
    if (requestC) await requestC
    if (bStaged && !bCleanupObserved) {
      try {
        await Effect.runPromise(
          awaitWithTimeout(Queue.take(intentObserver.cleared), "writer B cleanup never ran during teardown"),
        )
      } catch {
        // The test already failed; teardown only tries to leave no accepted writer behind.
      }
    }
    intentObserver.restore()
    writerObserver.restore()
    await listener.stop(true)
    await Effect.runPromise(Scope.close(processScope, Exit.void))
    await restoreGlobalConfig(snapshot)
  }
})
