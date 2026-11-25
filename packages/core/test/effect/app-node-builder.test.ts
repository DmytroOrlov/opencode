import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Exit, Effect, FileSystem, Fiber, Layer, PlatformError, Ref, Stream } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Config } from "@opencode/core/config"
import { Event } from "@opencode/schema/config"
import { FallbackRuntimeIntent } from "@opencode/core/config/fallback-runtime-intent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Global } from "@opencode/util/global"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionGenerationAdmission } from "@opencode/core/session/generation-admission"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { filesystem as platformFilesystem } from "@opencode/util/effect/app-node-platform"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// Records the real filesystem operations at the FileSystem owner BOTH graphs share (`platformFilesystem.replace`
// reaches the server graph and every location instance build). Reads prove a writer's pre-admission validation ran;
// writes and renames are its durable commit, and a single-use rename barrier parks the commit inside the exclusive
// lease window. Fault switches make exactly one recorded operation fail (a rename that never committed, or a
// reload read of a document that is already durable), so a precommit failure can be separated from a commit that
// failed to publish. Every other operation passes through untouched, so the location instance boots normally.
function filesystemRecorder() {
  const calls = {
    writes: [] as Array<{ path: string; content: string }>,
    renames: [] as Array<[string, string]>,
    removes: [] as Array<string>,
    reads: [] as Array<string>,
  }
  const faults = {
    rename: false,
  }
  let renameGate: Deferred.Deferred<void> | undefined
  const readGates = new Map<string, Deferred.Deferred<void>>()
  type AfterReadGate = {
    readonly release: Deferred.Deferred<void>
    reached: boolean
    snapshot?: string
  }

  const afterReadGates = new Map<string, AfterReadGate>()
  // Read fault: every read of ONE target fails while armed. It is armed on a path only ONE location's graph reads,
  // so that location cannot quietly catch up (its reload attempts fail and are reported) while the other location
  // and every durable operation stay untouched.
  let readFaultTarget: string | undefined
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem
      return {
        ...real,
        readFileString: (target: string, encoding?: string) => {
          calls.reads.push(target)
          const failed = target === readFaultTarget
          const gate = failed ? undefined : readGates.get(target)
          if (gate !== undefined) {
            readGates.delete(target)
            return Effect.yieldNow.pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(real.readFileString(target, encoding)),
            )
          }
          const afterRead = failed ? undefined : afterReadGates.get(target)

          if (afterRead !== undefined) {
            afterReadGates.delete(target)

            // Capture actual filesystem bytes first. Park only AFTER the read succeeds, so a competing atomic
            // rename cannot change this already-read snapshot.
            return real.readFileString(target, encoding).pipe(
              Effect.tap((snapshot) =>
                Effect.sync(() => {
                  afterRead.snapshot = snapshot
                  afterRead.reached = true
                }),
              ),
              Effect.flatMap((snapshot) =>
                Deferred.await(afterRead.release).pipe(Effect.as(snapshot)),
              ),
            )
          }
          return failed ? Effect.fail(ioFault("readFileString", target)) : real.readFileString(target, encoding)
        },
        writeFileString: (target: string, content: string) => {
          calls.writes.push({ path: target, content })
          return real.writeFileString(target, content)
        },
        rename: (from: string, to: string) => {
          calls.renames.push([from, to])
          const gate = renameGate
          if (gate !== undefined) {
            renameGate = undefined
            return Effect.yieldNow.pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(
                faults.rename ? Effect.fail(ioFault("rename", from)) : real.rename(from, to),
              ),
            )
          }
          return faults.rename
            ? Effect.fail(ioFault("rename", from))
            : real.rename(from, to)
        },
        remove: (target: string, options?: { force?: boolean; recursive?: boolean }) => {
          calls.removes.push(target)
          return real.remove(target, options)
        },
      }
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))
  return {
    calls,
    faults,
    layer,
    armRenameGate: (gate: Deferred.Deferred<void>) => (renameGate = gate),
    armReadGate: (target: string, gate: Deferred.Deferred<void>) => (readGates.set(target, gate), undefined),
    armAfterReadGate: (target: string, release: Deferred.Deferred<void>) => {
      const gate: AfterReadGate = { release, reached: false }
      afterReadGates.set(target, gate)
      return gate
    },
    armReadFault: (target: string) => ((readFaultTarget = target), undefined),
    clearReadFault: () => ((readFaultTarget = undefined), undefined),
  }
}

// A filesystem fault at the recorded boundary: the real error shape the platform layer would return, so the
// classification code below cannot be fooled by a test-only shape.
const ioFault = (method: string, target: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
    cause: Object.assign(new Error("EIO"), { code: "EIO" }),
  })

// The effective committed fallback a location's protected read currently serves.
const servedFallback = (config: Config.Interface) =>
  Effect.gen(function* () {
    const fallbackNow = Config.latest(yield* config.entries(), "fallback")
    return fallbackNow === null || fallbackNow === undefined
      ? undefined
      : String(fallbackNow.model)
  })

// ONE application build over TWO location graphs, with the build's own committed-revision owner observable from
// outside both graphs, plus a second independent build for the boundary control. Shared by the cross-location
// freshness cases: the intent owner they read is the SAME owner both location configs reserve and commit through,
// which is what makes a committed-revision check meaningful.
const crossLocationHarness = (root: string, initial: string) =>
  Effect.gen(function* () {
    const globalDirectory = path.join(root, "global")
    const projectA = path.join(root, "a")
    const projectB = path.join(root, "b")
    const file = path.join(globalDirectory, "opencode.jsonc")
    yield* Effect.promise(async () => {
      await fs.mkdir(projectA)
      await fs.mkdir(projectB)
      await fs.mkdir(globalDirectory)
      await fs.writeFile(file, initial)
    })
    const record = filesystemRecorder()
    const build = () =>
      Layer.mergeAll(
        AppNodeBuilder.build(
          LayerNode.group([Database.node, Bus.node, LocationServiceMap.node, FallbackRuntimeIntent.node]),
          [
            Global.node.replace(
              Global.layerWith({
                data: path.join(root, "data"),
                cache: path.join(root, "cache"),
                config: globalDirectory,
                state: path.join(root, "state"),
                tmp: path.join(root, "tmp"),
                home: path.join(globalDirectory, "home"),
              }),
            ),
            offlineModels,
            platformFilesystem.replace(record.layer),
            // The watcher is pinned only so watch delivery stays deterministic: it never invents events, so a stale
            // cross-location read cannot be raced away by a real filesystem event.
            Watcher.node.replace(Watcher.testLayer),
          ],
        ),
        // Merged by reference so `Watcher.Test` resolves to the instance the built graph subscribes through.
        Watcher.testLayer,
      )
    return {
      globalDirectory,
      projectA,
      projectB,
      file,
      record,
      build,
      layer: build(),
      readsOfConfig: () => Effect.succeed(record.calls.reads.filter((target) => target === file).length),
      committedText: () => Effect.promise(() => fs.readFile(file, "utf8")),
    }
  })

// The per-location side of the build: the real `Config.Service` a location instance boots, with its update entry
// point kept separately so both locations stay distinguishable in the assertions below.
const locationGraph = (directory: string) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    if (!config.update) throw new Error("Config updates are unavailable")
    return { config, update: config.update }
  }).pipe(
    Effect.provide(
      LocationServiceMap.Service.get({ directory: AbsolutePath.make(directory) }),
    ),
  )

// Synchronization on observable state (a staged revision, a recorded validation read, a rename count, a drain that
// entered its gate), never a fixed sleep: it proceeds the moment the boundary is reached and fails loudly if it never
// is.
const awaitUntil = (predicate: () => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    let spins = 0
    while (true) {
      if (yield* predicate()) return
      if (spins++ > 20_000) return yield* Effect.die(new Error("barrier wait was never reached"))
      yield* Effect.yieldNow
    }
  })

// The protected generation is a REAL busy period: the production `SessionExecution.layer` builds its
// `SessionRunCoordinator`, which takes `admission.acquireShared` from the admission value ITS graph resolves and
// holds it across started -> drains -> settled. Only the runner leaf (owner of the model attempt) is parked; it records
// the Session whose drain it entered, so "reached the lease gate" is observable, and the park is re-armed per busy
// period.
const stalledRunner = (entered: Array<string>, stalls: { gate: Deferred.Deferred<void> }) =>
  Layer.succeed(
    SessionRunner.Service,
    SessionRunner.Service.of({
      drain: (input) =>
        Effect.sync(() => {
          entered.push(input.sessionID)
        }).pipe(
          Effect.andThen(Deferred.await(stalls.gate)),
          Effect.andThen(Effect.succeed(SessionRunner.DrainResult.Complete())),
        ),
    }),
  )

const fallback = (model: string) => ({
  providerID: Provider.ID.make("openai"),
  model: Model.ID.make(model),
})

const stagedModel = (intent: FallbackRuntimeIntent.Interface) =>
  intent.current().pipe(
    Effect.map((snapshot) =>
      snapshot.override.type === "some" && snapshot.override.value !== null
        ? String(snapshot.override.value.model)
        : undefined,
    ),
  )

describe("AppNodeBuilder cross-graph admission", () => {
  it.live(
    "shares one admission value between the SERVER generation owner and the LOCATION config owner",
    () =>
      tmpdirScoped().pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const globalDirectory = path.join(tmp.path, "global")
            const project = path.join(tmp.path, "project")
            const file = path.join(globalDirectory, "opencode.jsonc")
            const initial = '{\n  "username": "kept"\n}\n'
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await fs.mkdir(globalDirectory)
              await fs.writeFile(file, initial)
            })
            const record = filesystemRecorder()
            const sessionID = Session.ID.make("ses_cross_graph_a")
            const otherSessionID = Session.ID.make("ses_cross_graph_b")
            const entered: Array<string> = []
            const stalls = { gate: Deferred.makeUnsafe<void>() }
            // The intent service is pinned to one value ONLY so the test can observe staging: a compiled graph publishes
            // just its roots' services, so `Config.node`'s staging would otherwise be unobservable from outside the
            // location graph. The admission service is deliberately NOT pinned and NOT exported by either graph: sharing
            // it through `AppNodeBuilder.build` is exactly what this test must prove.
            const intent = yield* FallbackRuntimeIntent.make
            // ONE application build. SERVER owner: `SessionExecution.node`, the production layer unreplaced, with the
            // nodes it acquires. LOCATION owner: the real per-location instance the real `LocationServiceMap` boots
            // (`buildLocationServiceMap(bindings)`), i.e. the graph a generation drains through `Instance.provide(session)`
            // and a handler resolves Config from `locations.get(ref)`.
            const layer = AppNodeBuilder.build(
              LayerNode.group([
                Database.node,
                Bus.node,
                KV.node,
                Job.node,
                SessionStore.node,
                SessionInbox.node,
                SessionExecution.node,
                LocationServiceMap.node,
              ]),
              [
                Global.node.replace(
                  Global.layerWith({
                    data: path.join(tmp.path, "data"),
                    cache: path.join(tmp.path, "cache"),
                    config: globalDirectory,
                    state: path.join(tmp.path, "state"),
                    tmp: path.join(tmp.path, "tmp"),
                    home: path.join(globalDirectory, "home"),
                  }),
                ),
                offlineModels,
                platformFilesystem.replace(record.layer),
                FallbackRuntimeIntent.node.replace(
                  Layer.succeed(FallbackRuntimeIntent.Service, intent),
                ),
                SessionRunnerLLM.node.replace(stalledRunner(entered, stalls)),
              ],
            )
            return yield* Effect.gen(function* () {
              const db = (yield* Database.Service).db
              yield* db
                .insert(ProjectTable)
                .values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
              yield* db
                .insert(SessionTable)
                .values(
                  [sessionID, otherSessionID].map((id) => ({
                    id,
                    project_id: Project.ID.global,
                    slug: id,
                    directory: project,
                    title: id,
                    version: "test",
                  })),
                )
                .run()
                .pipe(Effect.orDie)
              const execution = yield* SessionExecution.Service
              const session = yield* (yield* SessionStore.Service).get(sessionID)
              if (!session) throw new Error("the seeded Session is missing")
              // The actual LOCATION side: the real `Config.Service` of the per-location instance the generation drains
              // through (`session.location`). Neither graph publishes its admission service, so the sharing is proven by
              // lease interference observed at BOTH production owners, in BOTH directions.
              const location = yield* Effect.gen(function* () {
                const config = yield* Config.Service
                if (!config.update) throw new Error("Config updates are unavailable")
                return { config, update: config.update }
              }).pipe(Effect.provide(LocationServiceMap.Service.get(session.location)))
              const enteredFor = (id: Session.ID) => Effect.succeed(entered.filter((x) => x === id).length)
              const readsOfConfig = () =>
                Effect.succeed(record.calls.reads.filter((target) => target === file).length)
              const committed = () => Effect.promise(() => fs.readFile(file, "utf8"))
              const activeHas = (id: Session.ID) =>
                execution.active.pipe(Effect.map((ids) => ids.has(id)))

              // Fixture control: with no lease held, the real writer reaches its durable commit, so the deferral asserted
              // below cannot be an artifact of the fixture instead of a lease.
              yield* location.update({ fallback: fallback("model-baseline") })
              expect(record.calls.renames.length).toBe(1)
              expect(record.calls.writes.length).toBe(1)
              expect(yield* committed()).toContain('"model": "model-baseline"')
              const validationReads = yield* readsOfConfig()
              const committedBeforeHold = yield* committed()

              // (A) A real generation takes the shared lease on the SERVER side.
              const generation = yield* Effect.forkChild(execution.resume(sessionID))
              yield* awaitUntil(() => enteredFor(sessionID).pipe(Effect.map((count) => count > 0)))

              // The LOCATION writer on the matching location enters (its pre-admission validation read is recorded),
              // stages its validated intent, and then waits: no temp write, no rename, bytes untouched. WITHOUT a shared
              // admission value this writer commits at once and `renames` is already 2 here, which is the decisive
              // negative for this regression.
              const writer = yield* Effect.forkChild(location.update({ fallback: fallback("model-held") }))
              yield* awaitUntil(() => stagedModel(intent).pipe(Effect.map((model) => model === "model-held")))
              expect(yield* readsOfConfig()).toBeGreaterThan(validationReads)
              expect(record.calls.writes.length).toBe(1)
              expect(record.calls.renames.length).toBe(1)
              expect(yield* committed()).toBe(committedBeforeHold)

              // A queued owner cancelled mid-window drops its queue entry and clears only its own revision, and cannot
              // strand the writer that entered earlier.
              const cancelled = yield* Effect.forkChild(location.update({ fallback: fallback("model-cancelled") }))
              yield* awaitUntil(() =>
                stagedModel(intent).pipe(Effect.map((model) => model === "model-cancelled")),
              )
              expect(record.calls.renames.length).toBe(1)
              yield* Fiber.interrupt(cancelled)
              expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true)
              expect(yield* stagedModel(intent)).toBeUndefined()
              expect(record.calls.renames.length).toBe(1)

              // (B) Production releases the lease when the busy period settles (`Effect.ensuring(lease.release)` after
              // the settled hook): the queued writer is admitted exactly once and publishes through exactly one temp write
              // and one durable rename.
              yield* Deferred.succeed(stalls.gate, undefined)
              expect(Exit.isSuccess(yield* Fiber.await(generation))).toBe(true)
              yield* awaitUntil(() => Effect.succeed(record.calls.renames.length >= 2))
              expect(Exit.isSuccess(yield* Fiber.await(writer))).toBe(true)
              expect(record.calls.renames.length).toBe(2)
              expect(record.calls.writes.length).toBe(2)
              const committedNow = yield* committed()
              expect(committedNow).toContain('"model": "model-held"')
              expect(committedNow).not.toContain('"model": "model-cancelled"')
              expect(committedNow).toContain('"username": "kept"')
              expect(yield* stagedModel(intent)).toBeUndefined()
              expect(yield* activeHas(sessionID)).toBe(false)

              // (C) The same state machine seen from the other owner: while the LOCATION writer holds its exclusive lease
              // inside the commit window (rename parked), a SERVER-side generation is withheld at its shared acquisition —
              // active in the coordinator, never entered its drain. Separate per-graph instances would admit it at once.
              const gate = Deferred.makeUnsafe<void>()
              record.armRenameGate(gate)
              const committing = yield* Effect.forkChild(location.update({ fallback: fallback("model-committing") }))
              yield* awaitUntil(() => stagedModel(intent).pipe(Effect.map((model) => model === "model-committing")))
              yield* awaitUntil(() => Effect.succeed(record.calls.renames.length === 3))
              expect(yield* committed()).toContain('"model": "model-held"')
              stalls.gate = Deferred.makeUnsafe<void>()
              const otherGeneration = yield* Effect.forkChild(execution.resume(otherSessionID))
              yield* awaitUntil(() => activeHas(otherSessionID))
              yield* Effect.yieldNow
              yield* Effect.yieldNow
              expect(yield* enteredFor(otherSessionID)).toBe(0)
              yield* Deferred.succeed(gate, undefined)
              expect(Exit.isSuccess(yield* Fiber.await(committing))).toBe(true)
              yield* awaitUntil(() => enteredFor(otherSessionID).pipe(Effect.map((count) => count > 0)))
              yield* Deferred.succeed(stalls.gate, undefined)
              expect(Exit.isSuccess(yield* Fiber.await(otherGeneration))).toBe(true)
              expect(record.calls.renames.length).toBe(3)
              expect(record.calls.writes.length).toBe(3)
              expect(yield* committed()).toContain('"model": "model-committing"')

              // (D) Nothing is stranded afterwards: fresh work from both owners still progresses, and the generation's
              // release happened exactly once (a new busy period starts and drains, a new update commits with one further
              // rename).
              const thirdGeneration = yield* Effect.forkChild(execution.resume(otherSessionID))
              yield* awaitUntil(() => enteredFor(otherSessionID).pipe(Effect.map((count) => count > 1)))
              stalls.gate = Deferred.makeUnsafe<void>()
              yield* Deferred.succeed(stalls.gate, undefined)
              expect(Exit.isSuccess(yield* Fiber.await(thirdGeneration))).toBe(true)
              yield* location.update({ fallback: fallback("model-after") })
              expect(record.calls.renames.length).toBe(4)
              expect(yield* committed()).toContain('"model": "model-after"')
              const entries = yield* location.config.entries()
              expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-after" })
              expect(yield* stagedModel(intent)).toBeUndefined()
              expect(yield* activeHas(sessionID)).toBe(false)
              expect(yield* activeHas(otherSessionID)).toBe(false)
            }).pipe(Effect.provide(layer))
          }),
        ),
      ),
    )

  it.effect(
    "keeps one entry-order sequence for writers reached from two location graphs of one build",
    () =>
      tmpdirScoped().pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const globalDirectory = path.join(tmp.path, "global")
            const projectA = path.join(tmp.path, "a")
            const projectB = path.join(tmp.path, "b")
            const file = path.join(globalDirectory, "opencode.jsonc")
            yield* Effect.promise(async () => {
              await fs.mkdir(projectA)
              await fs.mkdir(projectB)
              await fs.mkdir(globalDirectory)
              await fs.writeFile(file, '{\n  "username": "kept"\n}\n')
            })
            const record = filesystemRecorder()
            // The intent owner and the admission value are NOT pinned in this build: each location graph boots with its
            // own wiring, so this is the unassisted question of whether their `FallbackRuntimeIntent` reservations share
            // ONE entry order for the SAME global document (both writers target `config/opencode.jsonc`). `FallbackRuntimeIntent.node`
            // is listed as a ROOT so the build's own owner is observable from OUTSIDE the location graphs (they keep their
            // dependencies private); it is not replaced, so whatever those graphs use must come from production wiring.
            // The watcher is the one node pinned here, and only to make watch delivery deterministic: the test watcher never
            // invents events, so a stale cross-location read below cannot be raced away by a real filesystem event, and its
            // recorded subscriptions/`emit` prove the production Config watch plan rather than trusting it. Merged by
            // reference so `Watcher.Test` resolves to the same instance the built graph subscribes through.
            const watcherLayer = Watcher.testLayer
            const layer = AppNodeBuilder.build(
              LayerNode.group([Database.node, Bus.node, LocationServiceMap.node, FallbackRuntimeIntent.node]),
              [
                Global.node.replace(
                  Global.layerWith({
                    data: path.join(tmp.path, "data"),
                    cache: path.join(tmp.path, "cache"),
                    config: globalDirectory,
                    state: path.join(tmp.path, "state"),
                    tmp: path.join(tmp.path, "tmp"),
                    home: path.join(globalDirectory, "home"),
                  }),
                ),
                offlineModels,
                platformFilesystem.replace(record.layer),
                Watcher.node.replace(watcherLayer),
              ],
            )
            return yield* Effect.gen(function* () {
              const locationGraph = (directory: string) =>
                Effect.gen(function* () {
                  const config = yield* Config.Service
                  if (!config.update) throw new Error("Config updates are unavailable")
                  return { config, update: config.update }
                }).pipe(
                  Effect.provide(
                    LocationServiceMap.Service.get({ directory: AbsolutePath.make(directory) }),
                  ),
                )
              const a = yield* locationGraph(projectA)
              const b = yield* locationGraph(projectB)
              // ONE application build publishes ONE intent owner at its root; the writers below enter through two DIFFERENT
              // location graphs of that build, so every revision and every staged value they publish must land on this
              // owner's single line. `appIntent` is the un-replaced root, so identity or state agreement here is production
              // wiring, not a test pin.
              const appIntent = yield* FallbackRuntimeIntent.Service
              const staged = () => appIntent.current()
              const watcher = yield* Watcher.Test
              const readsOfConfig = () =>
                Effect.succeed(record.calls.reads.filter((target) => target === file).length)
              // Fixture control: an unobstructed update commits, so the ordering asserted below cannot be an artifact.
              const controlIntent = yield* staged()
              expect(controlIntent.override.type).toBe("none")
              expect(controlIntent.revision).toBe(0)
              yield* a.update({ fallback: fallback("model-control") })
              expect(record.calls.renames.length).toBe(1)
              // The control writer's position came from the root owner's line: it reserved 1, staged there, and its exit
              // cleared exactly that still-current revision.
              const afterControl = yield* staged()
              expect(afterControl.revision).toBe(1)
              expect(afterControl.override.type).toBe("none")
              const baseReads = yield* readsOfConfig()
              // A enters first and parks inside its pre-admission validation read; B enters behind it from the other
              // location graph.
              const park = Deferred.makeUnsafe<void>()
              record.armReadGate(file, park)
              const writerA = yield* Effect.forkChild(a.update({ fallback: fallback("model-first") }))
              yield* awaitUntil(() => readsOfConfig().pipe(Effect.map((count) => count >= baseReads + 1)))
              const writerB = yield* Effect.forkChild(b.update({ fallback: fallback("model-second") }))
              yield* awaitUntil(() =>
                staged().pipe(Effect.map((snapshot) => snapshot.revision >= 3)),
              )
              // ONE entry sequence, seen at the root: the control consumed 1, A (parked before its own validation finished,
              // so it has staged NOTHING yet) took 2, and B - which entered from the OTHER location graph - took 3 and is
              // the current staged value. Two per-location owners would leave this root at revision 0 with no override,
              // and B's staging would be invisible here; that is the decisive negative for shared intent state.
              const window = yield* staged()
              expect(window.revision).toBe(3)
              expect(window.override).toMatchObject({
                type: "some",
                value: { model: "model-second" },
              })
              // B cannot pass the entry-order gate while A's earlier position is still open: no temp write, no rename.
              // Separate per-location order sequences would let B commit here, which is the decisive negative.
              expect(record.calls.renames.length).toBe(1)
              expect(record.calls.writes.length).toBe(1)
              expect(yield* staged()).toMatchObject(window)
              // A retires first; B then applies its sparse patch on top of A's committed document.
              yield* Deferred.succeed(park, undefined)
              expect(Exit.isSuccess(yield* Fiber.await(writerA))).toBe(true)
              expect(Exit.isSuccess(yield* Fiber.await(writerB))).toBe(true)
              expect(record.calls.renames.length).toBe(3)
              expect(record.calls.writes.length).toBe(3)
              // Exact durable write sequence: temp1 = control, temp2 = A's entry position 2, temp3 = B's entry position 3,
              // each renamed onto the same global target in that order.
              expect(record.calls.writes[1]!.content).toContain('"model": "model-first"')
              expect(record.calls.writes[2]!.content).toContain('"model": "model-second"')
              expect(record.calls.renames.every(([, target]) => target === file)).toBe(true)
              const saved = yield* Effect.promise(() => fs.readFile(file, "utf8"))
              expect(saved).toContain('"model": "model-second"')
              expect(saved).not.toContain('"model": "model-first"')
              expect(saved).toContain('"username": "kept"')
              // Both positions retired and only their own still-current revision was cleared: the shared line advanced to
              // 3 and holds no override, so recovery now falls through to the committed document.
              const settled = yield* staged()
              expect(settled.revision).toBe(3)
              expect(settled.override.type).toBe("none")
              // Cross-location committed freshness (S2 correction): the shared INTENT owner is fresh (asserted
              // above), and location A's LOCAL flags are clear - its own commit published its own document - so only
              // the shared COMMITTED revision tells A that another location replaced the durable document. A's
              // protected read therefore reconciles from disk instead of returning its cached document, and B's
              // read stays served from its own coherent cache. No watcher event and no extra write is required first.
              expect(yield* servedFallback(a.config)).toBe("model-second")
              expect(yield* servedFallback(b.config)).toBe("model-second")
              // The reconciliation only reads: B's commit stays the last durable replacement, and A's repair
              // performs no temp write and no rename.
              expect(record.calls.renames.length).toBe(3)
              expect(record.calls.writes.length).toBe(3)
              // The durable marker advanced exactly to the entry position B renamed through, and it is distinct
              // from the staged line: recovery still sees no override, so it falls through to the committed
              // document that both readers just returned.
              expect(yield* appIntent.committedRevision()).toBe(3)
              expect(yield* staged()).toMatchObject({ revision: 3, override: { type: "none" } })
              // The watch wiring is proven reachable rather than trusted: A's own Config owner subscribed a watch covering
              // the shared global document, and B's durable replacement is delivered into A's watch stream (which is what
              // arms A's debounced reload worker at config.ts `requestReload`). Ordinary reloads still work; they are
              // separate evidence, not the mechanism that closed the read above.
              const subscriptions = yield* watcher.subscriptions()
              expect(
                subscriptions.some((watch) => watch.path === globalDirectory && watch.type === "directory"),
              ).toBe(true)
              const delivered = yield* Effect.forkScoped(
                a.config.changes().pipe(Stream.take(1), Stream.runCollect),
                { startImmediately: true },
              )
              yield* Effect.yieldNow
              yield* watcher.emit({ path: file, type: "update" })
              const update = yield* Fiber.join(delivered)
              expect(Array.from(update)).toEqual([{ path: file, type: "update" }])
              // Negative: a byte-equal PATCH is inert durably. It takes a NEW entry position (4) and retires it,
              // writes nothing and renames nothing, so it must NOT manufacture a committed revision: the durable
              // marker stays 3 while the staged line advanced to 4. Conflating the two would let a no-op claim a
              // durable commit it never made.
              yield* a.update({ fallback: fallback("model-second") })
              expect(record.calls.renames.length).toBe(3)
              expect(record.calls.writes.length).toBe(3)
              expect(yield* appIntent.committedRevision()).toBe(3)
              expect(yield* staged()).toMatchObject({ revision: 4, override: { type: "none" } })
              expect(yield* servedFallback(a.config)).toBe("model-second")
              expect(yield* servedFallback(b.config)).toBe("model-second")
            }).pipe(Effect.provide(Layer.mergeAll(layer, watcherLayer)))
          }),
        ),
      ),
    )

  it.effect(
    "keeps a precommit failure from advancing the shared committed revision",
    () =>
      tmpdirScoped().pipe(
        Effect.flatMap((tmp) =>
          crossLocationHarness(tmp.path, '{\n  "username": "kept"\n}\n').pipe(
            Effect.flatMap((harness) =>
              Effect.gen(function* () {
                const a = yield* locationGraph(harness.projectA)
                const b = yield* locationGraph(harness.projectB)
                const intent = yield* FallbackRuntimeIntent.Service
                yield* a.update({ fallback: fallback("model-keep") })
                expect(harness.record.calls.renames.length).toBe(1)
                const durable = yield* harness.committedText()
                const revisionBefore = yield* intent.committedRevision()
                expect(revisionBefore).toBe(1)
                // A rename that never replaced the document is a precommit failure, so it must never be recorded
                // as a durable replacement: the shared marker would otherwise let every other location claim it
                // had to reload bytes that were never written.
                harness.record.faults.rename = true
                const renameFailure = yield* b.update({ fallback: fallback("model-fault") }).pipe(Effect.flip)
                harness.record.faults.rename = false
                // The actual precommit identity, with no committed-state marker invented. The recorder counts the
                // rename ATTEMPT, so one extra attempt plus its temp cleanup is expected while the durable bytes
                // and the shared marker stay exactly where A left them.
                expect(renameFailure._tag).toBe("FileSystemError")
                expect(harness.record.calls.renames.length).toBe(2)
                expect(harness.record.calls.renames[1]).toEqual([harness.record.calls.writes[1]!.path, harness.file])
                expect(harness.record.calls.writes.length).toBe(2)
                expect(harness.record.calls.removes.at(-1)).toBe(harness.record.calls.writes[1]!.path)
                expect(yield* harness.committedText()).toBe(durable)
                expect(yield* intent.committedRevision()).toBe(revisionBefore)
                // Its reserved position retired and only its own still-current revision was cleared; nothing committed.
                expect(yield* intent.current()).toMatchObject({ revision: 2, override: { type: "none" } })
                // Neither location is forced through a reload by a failure that changed no bytes, and neither serves
                // the faulted candidate.
                const readsBefore = yield* harness.readsOfConfig()
                expect(yield* servedFallback(a.config)).toBe("model-keep")
                expect(yield* servedFallback(b.config)).toBe("model-keep")
                expect(yield* harness.readsOfConfig()).toBe(readsBefore)
                // A rejected candidate is the same boundary: the document is still sparsely editable, so validation
                // itself rejects it before anything is staged or attempted.
                yield* Effect.promise(() => fs.writeFile(harness.file, '{\n  "username": "kept",\n  "shell": \n}\n'))
                const rejectedAttempts = harness.record.calls.renames.length
                const rejectedWrites = harness.record.calls.writes.length
                const rejected = yield* b.update({ shell: "/bin/bash" }).pipe(Effect.flip)
                expect(rejected._tag).toBe("Config.CandidateRejected")
                expect(harness.record.calls.renames.length).toBe(rejectedAttempts)
                expect(harness.record.calls.writes.length).toBe(rejectedWrites)
                expect(yield* intent.committedRevision()).toBe(revisionBefore)
                // Recovery stays available: once the document is valid again a later writer commits, its own
                // entry position becoming the durable marker, and BOTH locations' next protected read follows it.
                yield* Effect.promise(() => fs.writeFile(harness.file, durable))
                yield* b.update({ fallback: fallback("model-committed") })
                const recovered = yield* intent.committedRevision()
                expect(recovered).toBeGreaterThan(revisionBefore)
                expect((yield* intent.current()).revision).toBe(recovered)
                expect(harness.record.calls.renames.length).toBe(rejectedAttempts + 1)
                expect(harness.record.calls.writes.length).toBe(rejectedWrites + 1)
                expect(yield* servedFallback(a.config)).toBe("model-committed")
                expect(yield* servedFallback(b.config)).toBe("model-committed")
              }).pipe(Effect.provide(harness.layer)),
            ),
          ),
        ),
      ),
  )

  it.effect(
    "advances the shared committed revision for a shell-only commit and shows it to the other location",
    () =>
      tmpdirScoped().pipe(
        Effect.flatMap((tmp) =>
          crossLocationHarness(tmp.path, '{\n  "username": "kept"\n}\n').pipe(
            Effect.flatMap((harness) =>
              Effect.gen(function* () {
                const a = yield* locationGraph(harness.projectA)
                const b = yield* locationGraph(harness.projectB)
                const intent = yield* FallbackRuntimeIntent.Service
                yield* a.update({ fallback: fallback("model-base") })
                expect(yield* intent.current()).toMatchObject({ revision: 1, override: { type: "none" } })
                expect(yield* intent.committedRevision()).toBe(1)
                // B replaces the durable document through a patch that touches no fallback field at all, so it
                // stages no intent: a reader keyed only on the staged line would keep serving stale bytes here.
                yield* b.update({ shell: "/bin/bash" })
                expect(harness.record.calls.renames.length).toBe(2)
                expect(yield* intent.current()).toMatchObject({ revision: 1, override: { type: "none" } })
                expect(yield* intent.committedRevision()).toBe(2)
                // A's next protected read is therefore a real reconciliation: it returns the other location's
                // shell change while its own committed fallback survives untouched, and the unrelated JSONC
                // content is still there.
                const entries = yield* a.config.entries()
                expect(Config.latest(entries, "shell")).toBe("/bin/bash")
                expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-base" })
                expect(yield* harness.committedText()).toContain('"username": "kept"')
                // A's reconciliation is read-only, and its marker is now current, so the following read is cached.
                const readsBefore = yield* harness.readsOfConfig()
                expect(Config.latest(yield* a.config.entries(), "shell")).toBe("/bin/bash")
                expect(yield* harness.readsOfConfig()).toBe(readsBefore)
                const bReadsBefore = yield* harness.readsOfConfig()
                expect(yield* servedFallback(b.config)).toBe("model-base")
                expect(yield* harness.readsOfConfig()).toBe(bReadsBefore)
                expect(harness.record.calls.renames.length).toBe(2)
                expect(harness.record.calls.writes.length).toBe(2)
              }).pipe(Effect.provide(harness.layer)),
            ),
          ),
        ),
      ),
  )

  it.effect(
    "fails a cross-location read whose reconciliation cannot read the durable document",
    () =>
      tmpdirScoped().pipe(
        Effect.flatMap((tmp) =>
          crossLocationHarness(tmp.path, '{\n  "username": "kept"\n}\n').pipe(
            Effect.flatMap((harness) =>
              Effect.gen(function* () {
                const a = yield* locationGraph(harness.projectA)
                const b = yield* locationGraph(harness.projectB)
                const intent = yield* FallbackRuntimeIntent.Service
                yield* a.update({ fallback: fallback("model-first") })
                yield* b.update({ fallback: fallback("model-second") })
                expect(harness.record.calls.renames.length).toBe(2)
                expect(yield* intent.committedRevision()).toBe(2)
                // Decisive negative: A has not seen B's replacement, so its next protected read must reconcile. Arm a
                // read fault on a candidate ONLY A's graph reads, so A cannot quietly catch up beforehand (its reload
                // attempts fail and are reported) while B's durable operations and reads stay untouched.
                harness.record.armReadFault(path.join(harness.projectA, "opencode.jsonc"))
                const attemptsBefore = harness.record.calls.reads.length
                const faultedRead = yield* Effect.exit(servedFallback(a.config))
                // The read never presents the older document as current: it fails with the real filesystem cause
                // re-raised unchanged, after actually attempting the reload, and A's observed marker is NOT advanced
                // past bytes it could not read, so the revision it missed stays pending.
                expect(Exit.isSuccess(faultedRead)).toBe(false)
                expect(Exit.hasDies(faultedRead)).toBe(true)
                expect(harness.record.calls.reads.length).toBeGreaterThan(attemptsBefore)
                // Nothing was written, renamed or committed by the failed read, and the durable marker still records
                // exactly B's one replacement.
                expect(harness.record.calls.renames.length).toBe(2)
                expect(harness.record.calls.writes.length).toBe(2)
                expect(yield* intent.committedRevision()).toBe(2)
                // The revision A missed is not lost: once the fault is cleared its next protected read reconciles
                // forward instead of permanently presenting the document it still holds, and the other location
                // is unaffected by A's failed reconciliation.
                harness.record.clearReadFault()
                expect(yield* servedFallback(a.config)).toBe("model-second")
                expect(yield* servedFallback(b.config)).toBe("model-second")
              }).pipe(Effect.provide(harness.layer)),
            ),
          ),
        ),
      ),
  )

  it.effect(
    "retries one protected read when a newer revision lands during its physical refresh load",
    () =>
      tmpdirScoped().pipe(
        Effect.flatMap((tmp) =>
          crossLocationHarness(
            tmp.path,
            '{\n  "username": "kept",\n  "fallback": {\n    "providerID": "openai",\n    "model": "model-race-base"\n  }\n}\n',
          ).pipe(
            Effect.flatMap((harness) =>
              Effect.gen(function* () {
                const a = yield* locationGraph(harness.projectA)
                const intent = yield* FallbackRuntimeIntent.Service
                const bus = yield* Bus.Service

                // Each durable revision below is committed at the shared owner (reserve, real bytes on disk,
                // recordCommit, retire), which is exactly the state a writer leaves after its rename: no second
                // location graph is booted and no announcement is published, so the racing reconciliation
                // below is the only reader of those bytes.
                const commitRevision = (model: string) =>
                  Effect.gen(function* () {
                    const reservation = yield* intent.reserve()
                    yield* Effect.promise(async () =>
                      await fs.writeFile(
                        harness.file,
                        `{\n  "username": "kept",\n  "fallback": {\n    "providerID": "openai",\n    "model": "${model}"\n  }\n}\n`,
                      )
                    )
                    yield* intent.recordCommit(reservation)
                    yield* intent.retire(reservation)
                  })

                // A boots with revision 0 recorded and reads the on-disk document coherently.
                expect(yield* servedFallback(a.config)).toBe("model-race-base")
                expect(yield* intent.committedRevision()).toBe(0)

                // A newer revision is durable while A still holds the older one, so its next protected
                // read must reconcile from disk.
                yield* commitRevision("model-race-mid")
                expect(yield* intent.committedRevision()).toBe(1)

                // The reconciliation physically reads revision 1 and parks BEFORE those bytes reach
                // Config.load(); the after-read barrier means a competing replacement cannot change the
                // snapshot this read already captured.
                const release = Deferred.makeUnsafe<void>()
                const hold = harness.record.armAfterReadGate(harness.file, release)
                // Announcements are counted so a retry cannot be bought by publishing a KNOWN-stale document
                // first: the mandatory notification runs at most once for this read, and only after the
                // document installed under the reload lock is coherent.
                const announced = yield* Ref.make(0)
                yield* bus.subscribe(Event.Updated).pipe(
                  Stream.runForEach(() => Ref.update(announced, (count) => count + 1)),
                  Effect.forkScoped,
                )
                const pending = yield* Effect.forkChild(
                  servedFallback(a.config),
                )
                yield* awaitUntil(() => Effect.succeed(hold.reached))
                expect(hold.reached).toBe(true)
                expect(hold.snapshot).toContain('"model": "model-race-mid"')
                expect(yield* harness.committedText()).toContain('"model": "model-race-mid"')

                // A second revision is published while that read is in flight.
                yield* commitRevision("model-race-new")
                expect(yield* intent.committedRevision()).toBe(2)
                expect(yield* harness.committedText()).toContain('"model": "model-race-new"')
                const readsBeforeRelease = yield* harness.readsOfConfig()

                // The suspended physical read returns the revision-1 bytes now.
                yield* Deferred.succeed(release, undefined)

                // Decisive negative: the SAME entries() call must detect that its snapshot was
                // overtaken and physically reload rather than publish revision 1.
                expect(yield* Fiber.join(pending)).toBe("model-race-new")
                expect(yield* harness.readsOfConfig()).toBeGreaterThan(
                  readsBeforeRelease,
                )
                // Coherence is not bought by publishing a KNOWN-stale document first: the retrying read
                // announces its reconciliation exactly once, after the newest committed bytes were installed.
                expect(yield* Ref.get(announced)).toBe(1)

                // Reconciliation is read-only: it manufactures no durable revision and no staging
                // override, and the marker stays exactly where the writers left it.
                expect(harness.record.calls.renames.length).toBe(0)
                expect(harness.record.calls.writes.length).toBe(0)
                expect(yield* intent.committedRevision()).toBe(2)
                expect((yield* intent.current()).override.type).toBe("none")

                // The location is now coherent: its NEXT cached read does not cause another physical
                // disk reload. Capturing the marker after the load would mark revision 2 observed while
                // installing the revision-1 bytes this read actually captured, and this cached read would
                // expose that.
                const settledReads = yield* harness.readsOfConfig()
                expect(yield* servedFallback(a.config)).toBe("model-race-new")
                expect(yield* harness.readsOfConfig()).toBe(settledReads)
              }).pipe(Effect.provide(harness.layer)),
            ),
          ),
        ),
      ),
  )

  it.effect(
    "returns the newer committed document to a booting location whose initial load raced a commit",
    () =>
      tmpdirScoped().pipe(
        Effect.flatMap((tmp) =>
          crossLocationHarness(tmp.path, '{\n  "username": "kept"\n}\n').pipe(
            Effect.flatMap((harness) =>
              Effect.gen(function* () {
                const intent = yield* FallbackRuntimeIntent.Service

                // The OLD document is committed durably at the shared owner before A boots, so the
                // racing commit can land while A's INITIAL load is parked without a second location
                // graph being booted (which would otherwise race the barrier with its own reads).
                const bootOld = yield* intent.reserve()
                yield* Effect.promise(async () =>
                  await fs.writeFile(
                    harness.file,
                    '{\n  "username": "kept",\n  "fallback": {\n    "providerID": "openai",\n    "model": "model-boot-old"\n  }\n}\n',
                  )
                )
                yield* intent.recordCommit(bootOld)
                yield* intent.retire(bootOld)
                expect(yield* intent.committedRevision()).toBe(1)
                expect(yield* harness.committedText()).toContain('"model": "model-boot-old"')

                // A boots now: the after-read gate parks INSIDE its initial load, AFTER the OLD bytes were read.
                const release = Deferred.makeUnsafe<void>()
                const hold = harness.record.armAfterReadGate(harness.file, release)
                const booting = yield* Effect.forkChild(locationGraph(harness.projectA))

                yield* awaitUntil(() => Effect.succeed(hold.reached))
                expect(hold.reached).toBe(true)

                // A newer durable revision lands while A's initial load is parked: the shared marker is
                // 2 and the actual disk bytes are the NEW ones.
                const bootNew = yield* intent.reserve()
                yield* Effect.promise(async () =>
                  await fs.writeFile(
                    harness.file,
                    '{\n  "username": "kept",\n  "fallback": {\n    "providerID": "openai",\n    "model": "model-boot-new"\n  }\n}\n',
                  )
                )
                yield* intent.recordCommit(bootNew)
                yield* intent.retire(bootNew)
                expect(yield* intent.committedRevision()).toBe(2)
                expect(yield* harness.committedText()).toContain('"model": "model-boot-new"')

                const readsBeforeRelease = yield* harness.readsOfConfig()

                // A's initial load installs the OLD bytes it captured, so its boot marker (taken BEFORE that
                // physical read) stays behind revision 2. Moving that capture after load(initial) would mark
                // revision 2 observed while installing bytes that never contained it.
                yield* Deferred.succeed(release, undefined)
                const a = yield* Fiber.join(booting)

                // Decisive: A's FIRST protected read is still a reconciliation, not the stale boot bytes.
                expect(yield* servedFallback(a.config)).toBe("model-boot-new")
                expect(yield* harness.readsOfConfig()).toBeGreaterThan(readsBeforeRelease)

                // Coherence without new durable state: reconciliation is read-only.
                expect(harness.record.calls.renames.length).toBe(0)
                expect(harness.record.calls.writes.length).toBe(0)
                expect(yield* intent.committedRevision()).toBe(2)
                // The location is coherent, so its NEXT read is cached.
                const settledReads = yield* harness.readsOfConfig()
                expect(yield* servedFallback(a.config)).toBe("model-boot-new")
                expect(yield* harness.readsOfConfig()).toBe(settledReads)
              }).pipe(Effect.provide(harness.layer)),
            ),
          ),
        ),
      ),
  )

  it.effect("starts each application build from its own zero committed revision", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        crossLocationHarness(tmp.path, '{\n  "username": "kept"\n}\n').pipe(
          Effect.flatMap((harness) =>
            Effect.gen(function* () {
              const first = yield* Effect.gen(function* () {
                const a = yield* locationGraph(harness.projectA)
                const intent = yield* FallbackRuntimeIntent.Service
                yield* a.update({ fallback: fallback("model-durable") })
                return { intent, revision: yield* intent.committedRevision() }
              }).pipe(Effect.provide(harness.layer))
              expect(first.revision).toBe(1)
              // A SECOND build over the SAME on-disk document, so this is the boundary control: the shared marker
              // belongs to one build, and nothing in the new build can see the first build's revision.
              const second = yield* Effect.gen(function* () {
                const readsBefore = yield* harness.readsOfConfig()
                const b = yield* locationGraph(harness.projectB)
                const intent = yield* FallbackRuntimeIntent.Service
                const fresh = {
                  intent,
                  diskReads: (yield* harness.readsOfConfig()) - readsBefore,
                  committedAtBoot: yield* intent.committedRevision(),
                  entries: yield* b.config.entries(),
                }
                // The new build commits on its own line, so its first durable replacement is revision 1 for it.
                yield* b.update({ fallback: fallback("model-new-build") })
                return { ...fresh, committedAfter: yield* intent.committedRevision() }
              }).pipe(Effect.provide(harness.build()))
              // Two owners, proven by identity and by the numbers: the new build's committed line started at zero.
              expect(first.intent === second.intent).toBe(false)
              expect(second.committedAtBoot).toBe(0)
              // Its config owner loaded the durable document from disk itself - a real read happened at boot - so
              // no cross-build document cache or singleton is introduced, and a fresh location does not need the
              // other build's marker to see bytes already on disk.
              expect(second.diskReads).toBeGreaterThan(0)
              expect(Config.latest(second.entries, "fallback")).toMatchObject({ model: "model-durable" })
              expect(second.committedAfter).toBe(1)
              // The other build's marker is untouched by that commit.
              expect(yield* first.intent.committedRevision()).toBe(1)
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("leaves leases unshared across independent application builds (T011 boundary control)", () =>
    Effect.gen(function* () {
      // One `AppNodeBuilder.build` root shares one admission value (the case above). Two SEPARATE builds — the shape a
      // second application root would give a session/config lifecycle — stay isolated: the shared value is scoped to one
      // build, so no process-wide claim is made here.
      const first = yield* Effect.gen(function* () {
        return yield* SessionGenerationAdmission.Service
      }).pipe(Effect.provide(AppNodeBuilder.build(SessionGenerationAdmission.node)))
      const second = yield* Effect.gen(function* () {
        return yield* SessionGenerationAdmission.Service
      }).pipe(Effect.provide(AppNodeBuilder.build(SessionGenerationAdmission.node)))
      expect(first === second).toBe(false)

      const lease = yield* first.acquireShared
      const admitted = Deferred.makeUnsafe<void>()
      const otherBuild = yield* Effect.forkChild(
        second.acquireExclusive.pipe(Effect.tap(() => Deferred.succeed(admitted, undefined))),
      )
      yield* Effect.yieldNow
      yield* Deferred.await(admitted)
      const crossLease = yield* Fiber.join(otherBuild)
      yield* crossLease.release
      yield* lease.release
    }))

  it.live(
    "leaves entry order unshared across independent application builds (entry-order boundary control)",
    () =>
      Effect.gen(function* () {
        // The negative for the cross-location case above: the entry-order gate only serializes writers that share ONE
        // build's intent owner. Two `AppNodeBuilder.build` calls own TWO revision lines, so an open position in one
        // cannot withhold a later entry in the other, and that writer's durable commit lands FIRST - exactly the
        // out-of-order commit the case above forbids inside one build.
        const first = yield* Effect.gen(function* () {
          return yield* FallbackRuntimeIntent.Service
        }).pipe(Effect.provide(AppNodeBuilder.build(FallbackRuntimeIntent.node)))
        const second = yield* Effect.gen(function* () {
          return yield* FallbackRuntimeIntent.Service
        }).pipe(Effect.provide(AppNodeBuilder.build(FallbackRuntimeIntent.node)))
        expect(first === second).toBe(false)

        const open = yield* first.reserve()
        expect(open).toBe(1)
        // Control: the owner that holds an open position withholds a later entry of its OWN line (the gate times out).
        const withheld = yield* first.awaitPredecessors(open + 1).pipe(Effect.timeout("50 millis"), Effect.exit)
        expect(Exit.isSuccess(withheld)).toBe(false)
        // Negative: the other owner's gate cannot see that position, so its writer passes the gate immediately.
        const admitted = yield* second.awaitPredecessors(open + 1).pipe(Effect.timeout("50 millis"), Effect.exit)
        expect(Exit.isSuccess(admitted)).toBe(true)
        // Two independent lines, proven by the numbers: the second owner stages at revision 1 while the first owner is
        // still at revision 0 with no override, so neither writer's intent is visible to the other's recovery.
        const stagedInSecond = yield* second.stage(fallback("out-of-order"))
        expect(stagedInSecond).toBe(1)
        expect(yield* first.current()).toMatchObject({ revision: 0, override: { type: "none" } })
        // Released so nothing is stranded in the first owner.
        yield* first.retire(open)
        expect(yield* first.awaitPredecessors(open + 1)).toBeUndefined()
      }),
  )
})
