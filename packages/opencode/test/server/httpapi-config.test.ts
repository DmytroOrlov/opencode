import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as Scope from "effect/Scope"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { GenerationGate } from "@opencode-ai/core/session/generation-gate"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunState } from "../../src/session/run-state"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

class GateProbeA extends Context.Service<GateProbeA, GenerationGate.Interface>()("@test/GenerationGateProbeA") {}
class GateProbeB extends Context.Service<GateProbeB, GenerationGate.Interface>()("@test/GenerationGateProbeB") {}
class LocalProbe extends Context.Service<LocalProbe, { readonly token: symbol }>()("@test/GenerationGateLocalProbe") {}

const gateProbeANode = LayerNode.make({
  service: GateProbeA,
  layer: Layer.effect(GateProbeA, Effect.map(GenerationGate.Service, GateProbeA.of)),
  deps: [GenerationGate.node],
})
const gateProbeBNode = LayerNode.make({
  service: GateProbeB,
  layer: Layer.effect(GateProbeB, Effect.map(GenerationGate.Service, GateProbeB.of)),
  deps: [GenerationGate.node],
})
const localProbeNode = LayerNode.make({
  service: LocalProbe,
  layer: Layer.effect(LocalProbe, Effect.sync(() => LocalProbe.of({ token: Symbol() }))),
  deps: [],
})

const gateReplacement = (gate: GenerationGate.Interface) =>
  makeGlobalNode({
    service: GenerationGate.Service,
    layer: Layer.succeed(GenerationGate.Service, gate),
    deps: [],
  })

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.effect(
    "shares GenerationGate state across separately compiled graphs in the common memoMap",
    Effect.gen(function* () {
      expect(SessionRunState.node.dependencies).toContain(GenerationGate.node)
      expect(SessionExecutionLocal.node.dependencies).toContain(GenerationGate.node)

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const graphA = AppNodeBuilder.build(gateProbeANode)
      const graphB = AppNodeBuilder.build(gateProbeBNode)
      const contextA = yield* Layer.buildWithMemoMap(graphA, memoMap, scope)
      const contextB = yield* Layer.buildWithMemoMap(graphB, memoMap, scope)
      const gateA = Context.get(contextA, GateProbeA)
      const gateB = Context.get(contextB, GateProbeB)

      const reader = yield* Effect.provideService(gateA.reserveShared, Scope.Scope, scope)
      yield* reader.await
      const readerLease = yield* reader.transfer
      expect(readerLease).toBeDefined()

      const writer = yield* Effect.provideService(gateB.reserveExclusive, Scope.Scope, scope)
      const writerAwaitEntered = yield* Deferred.make<void>()
      const writerGranted = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(writerAwaitEntered, undefined)
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer reservation was cancelled")
        yield* Deferred.succeed(writerGranted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)

      yield* Deferred.await(writerAwaitEntered)
      // Let the writer fiber continue from the readiness latch into its actual await.
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writerGranted)).toBe(false)
      yield* readerLease!.release
      yield* Deferred.await(writerGranted)
      yield* Fiber.join(writerFiber)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect(
    "acquires the process gate through the stable layer across distinct live scopes",
    Effect.gen(function* () {
      const scopeA = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scopeA, Exit.void))
      const scopeB = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scopeB, Exit.void))

      const gateA = yield* GenerationGate.acquireProcess(scopeA)
      const gateB = yield* GenerationGate.acquireProcess(scopeB)
      expect(gateA).toBe(gateB)

      const reader = yield* Effect.provideService(gateA.reserveShared, Scope.Scope, scopeA)
      yield* reader.await
      const readerLease = yield* reader.transfer
      expect(readerLease).toBeDefined()

      const writer = yield* Effect.provideService(gateB.reserveExclusive, Scope.Scope, scopeB)
      const writerAwaitEntered = yield* Deferred.make<void>()
      const writerGranted = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(writerAwaitEntered, undefined)
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer reservation was cancelled")
        yield* Deferred.succeed(writerGranted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)

      yield* Deferred.await(writerAwaitEntered)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writerGranted)).toBe(false)
      yield* readerLease!.release
      yield* Deferred.await(writerGranted)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.effect(
    "shares only the supplied process gate across independently memoized graphs",
    Effect.gen(function* () {
      const processScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(processScope, Exit.void))
      const scopeA = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scopeA, Exit.void))
      const scopeB = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scopeB, Exit.void))

      const acquiredGate = yield* GenerationGate.acquireProcess(processScope)
      const replacement = gateReplacement(acquiredGate)
      const graphA = AppNodeBuilder.build(LayerNode.group([gateProbeANode, localProbeNode]), [
        [GenerationGate.node, replacement],
      ])
      const graphB = AppNodeBuilder.build(LayerNode.group([gateProbeBNode, localProbeNode]), [
        [GenerationGate.node, replacement],
      ])
      const contextA = yield* Layer.buildWithMemoMap(graphA, Layer.makeMemoMapUnsafe(), scopeA)
      const contextB = yield* Layer.buildWithMemoMap(graphB, Layer.makeMemoMapUnsafe(), scopeB)
      const gateA = Context.get(contextA, GateProbeA)
      const gateB = Context.get(contextB, GateProbeB)
      const localA = Context.get(contextA, LocalProbe)
      const localB = Context.get(contextB, LocalProbe)

      expect(gateA).toBe(acquiredGate)
      expect(gateB).toBe(acquiredGate)
      expect(localA).not.toBe(localB)
      expect(localA.token).not.toBe(localB.token)

      const reader = yield* Effect.provideService(gateA.reserveShared, Scope.Scope, scopeA)
      yield* reader.await
      const readerLease = yield* reader.transfer
      expect(readerLease).toBeDefined()

      const writer = yield* Effect.provideService(gateB.reserveExclusive, Scope.Scope, scopeB)
      const writerAwaitEntered = yield* Deferred.make<void>()
      const writerGranted = yield* Deferred.make<void>()
      const writerFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(writerAwaitEntered, undefined)
        yield* writer.await
        const lease = yield* writer.transfer
        if (lease === undefined) return yield* Effect.die("writer reservation was cancelled")
        yield* Deferred.succeed(writerGranted, undefined)
        yield* lease.release
      }).pipe(Effect.forkChild)

      yield* Deferred.await(writerAwaitEntered)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writerGranted)).toBe(false)
      yield* readerLease!.release
      yield* Deferred.await(writerGranted)
      yield* Fiber.join(writerFiber)
    }),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
