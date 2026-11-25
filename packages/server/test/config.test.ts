import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/schema/config"
import { Bus } from "@opencode/core/bus"
import { SessionGenerationAdmission } from "@opencode/core/session/generation-admission"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { filesystem as platformFilesystem } from "@opencode/util/effect/app-node-platform"
import { verifyTlsCaMode } from "@opencode/util/tls-ca"
import { tmpdir, tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { filesystemInjection, configAnnouncementFault } from "./fixture/config-fs"
import { it } from "../../core/test/lib/effect"
import { serveRoutes } from "./fixture/routes"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@opencode/schema/schema"

// The route graph built by `serveRoutes` asks for the verified TLS CA mode on every server-info read; naming it here
// keeps this file correct when it runs alone rather than relying on another file's load order.
verifyTlsCaMode("bundled")

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "opencode.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

it.live("updates the global shell without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    const fallbackResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ fallback: { providerID: "openai", model: "gpt-test", variant: "high" } }),
      }),
    )
    expect(fallbackResponse.status).toBe(204)
    const fallbackText = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(fallbackText).toContain('"shell": "/bin/zsh"')
    expect(fallbackText).toContain('"fallback": {')
    expect(fallbackText).toContain('"providerID": "openai"')

    const disabledResponse = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ fallback: null }),
      }),
    )
    expect(disabledResponse.status).toBe(204)
    const disabledText = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(disabledText).toContain('"shell": "/bin/zsh"')
    expect(disabledText).toContain('"fallback": null')

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

/**
 * The real route stack over a real filesystem whose operations can be made to fail.
 *
 * `serveRoutes` builds the production layer graph, so the injected filesystem is the only way to break the config
 * writer's rename, reader refresh or cleanup, and the recorded operations are what prove the injected step was reached
 * rather than bypassed. Every case below answers through the actual HTTP route and reads the actual bytes back.
 */
const wire = Effect.fnUntraced(function* (
  global: string,
  injection: ReturnType<typeof filesystemInjection>,
  // Extra node replacements for this build. A global node the config owner shares (the generation admission) is
  // replaced the way `AppNodeBuilder.build` itself does it: with a value built by the production implementation, which
  // is what lets the test hold a lease without simulating the lock.
  replacements: LayerNode.Replacements = [],
) {
  const dir = yield* tmpdirScoped("opencode-config-wire-")
  const server = yield* serveRoutes(
    {
      app: { version: "test" },
      database: { path: path.join(dir.path, "opencode.db") },
      models: { fetch: false },
      fs: { filewatcher: false },
      config: { directory: global },
    },
    [platformFilesystem.replace(injection.layer), ...replacements],
  )

  return {
    injection,
    patch: (body: Record<string, unknown>, signal?: AbortSignal) =>
      Effect.promise(async () => {
        const response = await server.fetch("http://opencode.local/api/experimental/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        })
        return { status: response.status, body: await response.text() }
      }),
    // The protected read for the same Location the PATCH's handler serves: it must never present a document older than
    // the last durable commit, which is what makes a stale read observable here.
    read: () =>
      Effect.promise(async () => {
        const url = new URL("http://opencode.local/api/config")
        url.searchParams.set("location[directory]", global)
        const response = await server.fetch(url)
        return { status: response.status, body: await response.text() }
      }),
    // The Bus the graph wired for this build, which is the instance the config owner publishes through: Bus is an
    // application-level node, so acquiring it from the built context is the same instance, not a stand-in.
    bus: Effect.fnUntraced(function* () {
      return Context.get(server.context, Bus.Service)
    }),
  }
})

/** The last recorded fallback in the server's own config read, which is what a protected reader sees. */
const readFallback = Effect.fnUntraced(function* (read: () => Effect.Effect<{ status: number; body: string }>) {
  const response = yield* read()
  if (response.status !== 200) return { status: response.status, fallback: "READ_FAILED" as unknown }
  const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(JSON.parse(response.body))
  const documents = entries.filter((entry): entry is Config.Document => entry.type === "document")
  return { status: response.status, fallback: documents.at(-1)?.info.fallback }
})

it.live("a committed patch answers 204 with no body, one rename, no stranded temp and agreeing readers", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-ok-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "shell": "bash"
}
`,
      ),
    )
    const route = yield* wire(global, filesystemInjection())

    const response = yield* route.patch({ fallback: { providerID: "openai", model: "gpt-test", variant: "high" } })
    expect(response.status).toBe(204)
    expect(response.body).toBe("")

    // One same-directory temp write and exactly one rename: the commit boundary.
    const writes = route.injection.calls.writes.filter((write) => write.path.includes(".tmp"))
    const renames = route.injection.calls.renames.filter(([, to]) => to === config)
    expect(writes.length).toBe(1)
    expect(renames.length).toBe(1)
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toContain('"fallback": {')
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toContain("// keep this comment")
    // Nothing is left behind in the config directory.
    expect((yield* Effect.promise(() => fs.readdir(global))).filter((name) => name.startsWith("."))).toEqual([])

    const read = yield* readFallback(route.read)
    expect(read.status).toBe(200)
    expect(read.fallback).toEqual({ providerID: "openai", model: "gpt-test", variant: "high" })
  }),
)

it.live("a precommit rejection answers uncoded, keeps the old bytes, and lets the next writer through", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-precommit-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    // Unparseable on disk: the sparse edit cannot produce a valid candidate, so nothing is staged, renamed or announced.
    yield* Effect.promise(() => fs.writeFile(config, `{ "shell": "bash"`))
    const before = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    const route = yield* wire(global, filesystemInjection())

    const response = yield* route.patch({ shell: "/bin/zsh" })
    expect(response.status).toBe(500)
    const body = JSON.parse(response.body)
    // No committed-state code: nothing was committed, so the boundary must not name one.
    expect(body).not.toHaveProperty("code")
    expect(body["_tag"]).toBe("UnknownError")
    expect(route.injection.calls.renames).toEqual([])
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toBe(before)

    // The reserved entry position retired with the failure, so a later writer commits.
    yield* Effect.promise(() => fs.writeFile(config, `{ "shell": "bash" }\n`))
    const later = yield* route.patch({ shell: "/bin/zsh" })
    expect(later.status).toBe(204)
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toContain('"/bin/zsh"')
  }),
)

it.live("a failed rename commits nothing, stays uncoded, and leaves nothing stranded", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-rename-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(config, `{ "shell": "bash" }\n`))
    const before = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    const injection = filesystemInjection()
    const route = yield* wire(global, injection)
    injection.faults.rename = true

    const response = yield* route.patch({ fallback: { providerID: "openai", model: "gpt-test" } })
    expect(response.status).toBe(500)
    const body = JSON.parse(response.body)
    expect(body).not.toHaveProperty("code")
    // The rename really was attempted, and it is the only durable operation that was not completed.
    expect(injection.calls.renames.length).toBe(1)
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toBe(before)
    expect((yield* Effect.promise(() => fs.readdir(global))).filter((name) => name.startsWith("."))).toEqual([])
    expect(injection.calls.removes.length).toBe(1)

    // The lease and the entry position released, so the next writer commits forward.
    injection.faults.rename = false
    const later = yield* route.patch({ fallback: { providerID: "openai", model: "gpt-test" } })
    expect(later.status).toBe(204)
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toContain('"gpt-test"')
  }),
)

it.live("a committed document its protected readers could not refresh answers with the committed code", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-unpublished-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(config, `{ "fallback": { "providerID": "openai", "model": "old" } }\n`))
    const injection = filesystemInjection()
    const route = yield* wire(global, injection)
    // The rename succeeded, so every later read of the document fails: the refresh cannot install the new bytes.
    injection.faults.read = (target) => target === config && injection.calls.renames.length > 0

    const response = yield* route.patch({ fallback: { providerID: "openai", model: "new" } })
    expect(response.status).toBe(500)
    const body = JSON.parse(response.body)
    expect(body).toMatchObject({
      _tag: "UnknownError",
      code: "CONFIG_COMMITTED_BUT_UNPUBLISHED",
    })
    // The new bytes are authoritative on disk, and the write path used the real rename.
    expect(injection.calls.renames.length).toBe(1)
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toContain('"model": "new"')

    // A protected read is never allowed to present the superseded document: it fails explicitly while refresh is
    // faulted, and once the reader can load again it reconciles forward to the committed bytes.
    const stale = yield* readFallback(route.read)
    expect(stale.status).toBe(500)

    injection.faults.read = () => false
    const reconciled = yield* readFallback(route.read)
    expect(reconciled.status).toBe(200)
    expect(reconciled.fallback).toEqual({ providerID: "openai", model: "new" })
  }),
)

it.live("a committed and published document whose mandatory announcement failed answers with that code", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-announce-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(config, `{ "shell": "bash" }\n`))
    const injection = filesystemInjection()
    const route = yield* wire(global, injection)
    const fault = configAnnouncementFault()
    // The listener is registered through the Location's own Bus, so the failure travels the same publication path
    // production uses (`Config.announceUpdate` -> `Bus.publish(Event.Updated)` with unisolated inline listeners).
    const unsubscribe = yield* route.bus().pipe(Effect.andThen((bus) => bus.listen(fault.listener)))
    fault.arm()

    const response = yield* route.patch({ shell: "/bin/zsh" })
    expect(response.status).toBe(500)
    const body = JSON.parse(response.body)
    expect(body).toMatchObject({
      _tag: "UnknownError",
      code: "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE",
    })
    // Proof the announcement really was attempted through the Bus, not inferred from the status.
    expect(fault.state.seen).toEqual(["config.updated"])
    expect(injection.calls.renames.length).toBe(1)
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toContain('"/bin/zsh"')

    // Readers and disk stay coherent: with the announcement answering again, the protected read shows the new value.
    yield* unsubscribe
    fault.disarm()
    const read = yield* readFallback(route.read)
    expect(read.status).toBe(200)
  }),
)

it.live("a failed temporary cleanup is only a diagnostic when nothing is stranded", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-cleanup-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(config, `{ "shell": "bash" }\n`))
    const injection = filesystemInjection()
    const route = yield* wire(global, injection)
    // Cleanup runs after the rename consumed the temporary file, so removing it fails and must not change the outcome.
    injection.faults.remove = true

    const response = yield* route.patch({ shell: "/bin/zsh" })
    expect(response.status).toBe(204)
    expect(injection.calls.renames.length).toBe(1)
    expect(injection.calls.removes.length).toBe(1)
    expect((yield* Effect.promise(() => fs.readdir(global))).filter((name) => name.startsWith("."))).toEqual([])
    // The lease released: a later writer still commits.
    injection.faults.remove = false
    expect(yield* route.patch({ shell: "fish" })).toMatchObject({ status: 204 })
  }),
)


it.live("a held generation defers a queued commit, and two PATCHes still commit in entry order", () =>
  Effect.gen(function* () {
    // Items 2 and 3 of the production path: both requests reserve their entry position and validate their candidate
    // while the newer one waits behind the older at the commit boundary, and a generation holding a shared lease
    // defers the durable commit rather than letting it through.
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-admission-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(config, `{ "shell": "bash" }\n`))
    const injection = filesystemInjection()
    // The admission the build shares, created with the production implementation and injected for the global node the
    // same way `AppNodeBuilder.build` injects it, so this is the instance the PATCH's config owner acquires its
    // exclusive lease from rather than a stand-in for it.
    const admission = yield* SessionGenerationAdmission.make
    const route = yield* wire(global, injection, [
      SessionGenerationAdmission.node.replace(
        Layer.succeed(SessionGenerationAdmission.Service, admission),
      ),
    ])
    // A primer PATCH first: it builds the Location's services and completes one whole write, so the waits below count
    // from a state where the update's own candidate read is the next read of the document rather than a service's first
    // load of it.
    const primer = yield* route.patch({ shell: "/bin/primer" })
    expect(primer.status).toBe(204)
    const seen = injection.readCount(config)
    const staged = injection.calls.writes.length
    const committed = injection.calls.renames.length
    // A generation in flight holds the shared side of the admission, which is what keeps a durable commit out.
    const held = yield* admission.acquireShared

    // Park the older request inside the candidate read that precedes admission: its entry position is reserved
    // before that read, so the newer request demonstrably queues behind that position instead of racing it.
    const parked = Deferred.makeUnsafe<void>()
    injection.armReadGate(config, parked, seen)
    // The older request's rename parks too, which is what makes the instant of its commit boundary observable.
    const commitBoundary = Deferred.makeUnsafe<void>()
    injection.armRenameGate(commitBoundary)

    const older = yield* route.patch({ fallback: { providerID: "openai", model: "older" } }).pipe(
      Effect.forkChild({ startImmediately: true }),
    )
    // The older request is parked inside its own candidate read, holding its reserved entry position.
    yield* injection.awaitedReads(config, seen + 1)
    const newer = yield* route.patch({ fallback: { providerID: "openai", model: "newer" } }).pipe(
      Effect.forkChild({ startImmediately: true }),
    )
    // The newer request has read and validated its own candidate: it cannot be waiting anywhere yet, so the queue
    // behind the older's entry position is demonstrably the one that holds, and neither request is durable.
    yield* injection.awaitedReads(config, seen + 2)
    expect(injection.calls.renames.length).toBe(committed)
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toContain('"/bin/primer"')

    yield* Deferred.succeed(parked, undefined)
    // The older request validated and reached the commit boundary, where the held lease stops it: the only way a
    // commit is visible below is the lease release.
    yield* held.release
    yield* injection.awaitedRenames(committed + 1)

    // The older request is at its rename and the newer has staged nothing yet, so the two durable commits cannot
    // overlap: entry order, not arrival at the lease, decides which document lands first.
    expect(injection.calls.writes.length).toBe(staged + 1)
    expect(injection.calls.writes[staged]!.path).toBe(injection.calls.renames[committed]![0])
    expect(injection.calls.writes[staged]!.content).toContain('"model": "older"')

    // The parked rename is the commit boundary: letting it through lands the older document, after which the newer
    // request is admitted and moves the document forward.
    yield* Deferred.succeed(commitBoundary, undefined)
    const first = yield* Fiber.join(older)
    const second = yield* Fiber.join(newer)

    expect(first).toMatchObject({ status: 204 })
    expect(second).toMatchObject({ status: 204 })
    expect(injection.calls.renames.length).toBe(committed + 2)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain('"model": "newer"')
    expect(text).not.toContain('"model": "older"')
    expect((yield* Effect.promise(() => fs.readdir(global))).filter((name) => name.startsWith("."))).toEqual([])
    const read = yield* readFallback(route.read)
    expect(read.fallback).toEqual({ providerID: "openai", model: "newer" })
  }),
)

it.live("a real request abort cancels the queued PATCH inside Config's owner and leaves the next writer unblocked", () =>
  Effect.gen(function* () {
    // T020's wire-level half. `HttpEffect.toWebHandlerWith` cancels a request by interrupting the fiber that runs it
    // (`fiber.interruptUnsafe(undefined, ClientAbort.annotation)`), so the assertions below are about the OWNER and not
    // the client: the request must be inside Config's read/queue owner when the signal fires; the route must answer with
    // the HTTP layer's own client-abort response (`HttpServerError.causeResponse` maps a delivered `ClientAbort` to an
    // empty 499, which a request that was never cancelled cannot produce); the abandoned writer must contribute no temp
    // file and no rename once the read it parked in is released; and a later PATCH in the same graph must still commit,
    // which is what shows its entry reservation and exclusive lease were retired instead of stranded.
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-abort-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(config, `{ "shell": "bash" }\n`))
    const injection = filesystemInjection()
    // Only this document's operations count: the persistence machinery writes unrelated files in the same build.
    const staged = () => injection.calls.writes.filter((write) => write.path.includes(".tmp")).length
    const committed = () => injection.calls.renames.filter(([, to]) => to === config).length
    // The admission the build shares, injected the way `AppNodeBuilder.build` injects it, so the lease the abandoned
    // owner took is the same one a later writer must be able to take.
    const admission = yield* SessionGenerationAdmission.make
    const route = yield* wire(global, injection, [
      SessionGenerationAdmission.node.replace(
        Layer.succeed(SessionGenerationAdmission.Service, admission),
      ),
    ])
    // A primer PATCH first: it builds the Location's services and completes one whole write, so the aborted request's
    // own candidate read is the next read of the document rather than a service's first load of it.
    const primer = yield* route.patch({ shell: "/bin/primer" })
    expect(primer.status).toBe(204)
    const seen = injection.readCount(config)
    const stagedAt = staged()
    const committedAt = committed()

    // Park the request inside the candidate read that follows its entry reservation. The wait is a Deferred the
    // production read itself resolves, so the read count below is what shows the request reached that owner, and zero
    // staged files and zero commits is what shows it had not passed the interruptible half of the update.
    const parked = Deferred.makeUnsafe<void>()
    injection.armReadGate(config, parked, seen)

    const controller = new AbortController()
    const abandoned = yield* route.patch(
      { fallback: { providerID: "openai", model: "aborted" } },
      controller.signal,
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* injection.awaitedReads(config, seen + 1)
    expect(staged()).toBe(stagedAt)
    expect(committed()).toBe(committedAt)

    // The client cancels, and the owning fiber takes it: the request answered nothing and never reached its commit
    // boundary.
    controller.abort()
    expect(yield* Fiber.join(abandoned)).toEqual({ status: 499, body: "" })
    expect(staged()).toBe(stagedAt)
    expect(committed()).toBe(committedAt)

    // The gate the abandoned request parked in is released. A fiber that survived the cancellation would resume here
    // and stage a temp file and rename it onto the document; an owner whose read was interrupted cannot.
    yield* Deferred.succeed(parked, undefined)

    // A fresh PATCH in the same graph must still commit: the reservation and lease the abandoned writer took are
    // retired on interruption, and no staged intent is left current for it to hand to the next writer.
    const next = yield* route.patch({ fallback: { providerID: "openai", model: "next" } })
    expect(next.status).toBe(204)
    // The later writer demonstrably reached the owner, so the zero-progress assertions above are not vacuous.
    yield* injection.awaitedReads(config, seen + 2)
    expect(staged()).toBe(stagedAt + 1)
    expect(committed()).toBe(committedAt + 1)
    // The one staged temp file belongs to the rename that landed, and the bytes are exactly the successful writer's.
    expect(
      injection.calls.writes.filter((write) => write.path.includes(".tmp"))[stagedAt]!.path,
    ).toBe(
      injection.calls.renames.filter(([, to]) => to === config)[committedAt]![0],
    )
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain('"model": "next"')
    expect(text).not.toContain('"model": "aborted"')
    // Nothing is stranded in the config directory: no temp, no half-written document.
    expect((yield* Effect.promise(() => fs.readdir(global))).filter((name) => name.startsWith("."))).toEqual([])
    const read = yield* readFallback(route.read)
    expect(read.fallback).toEqual({ providerID: "openai", model: "next" })
  }),
)

it.live("a cancellation arriving mid-commit completes publication and cleanup forward instead of truncating", () =>
  Effect.gen(function* () {
    // The control that keeps the guarantee above narrow: from the first temp write through publication the owner is
    // deliberately `Effect.uninterruptible` (`config.ts:849`), so a cancellation that lands there must NOT interrupt
    // the commit. The request parks AT its rename, is cancelled there, and still finishes forward: one whole document,
    // no stranded temp, protected readers agreeing, and the client-abort response only once the region has exited.
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-config-wire-abort-commit-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "opencode.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "shell": "bash"
}
`,
      ),
    )
    const injection = filesystemInjection()
    const staged = () => injection.calls.writes.filter((write) => write.path.includes(".tmp")).length
    const committed = () => injection.calls.renames.filter(([, to]) => to === config).length
    const route = yield* wire(global, injection)
    const primer = yield* route.patch({ shell: "/bin/primer" })
    expect(primer.status).toBe(204)
    const stagedAt = staged()
    const committedAt = committed()
    const renamesAt = injection.calls.renames.length

    // Park the request exactly at the commit boundary: its temp file is staged, the rename has not happened.
    const atRename = Deferred.makeUnsafe<void>()
    injection.armRenameGate(atRename)
    const controller = new AbortController()
    const child = yield* route.patch(
      { fallback: { providerID: "openai", model: "cancelled-mid-commit" } },
      controller.signal,
    ).pipe(Effect.forkChild({ startImmediately: true }))
    // The injection records the rename as the production path attempts it, before the gate parks it, so this is proof
    // the commit began rather than a request that never got there.
    yield* injection.awaitedRenames(renamesAt + 1)
    expect(staged()).toBe(stagedAt + 1)

    // Cancelled while the region is open: releasing the boundary must still land the document whole, and only then
    // does the cancellation take effect on the response.
    controller.abort()
    yield* Deferred.succeed(atRename, undefined)
    expect(yield* Fiber.join(child)).toEqual({ status: 499, body: "" })

    // Forward completion: exactly one temp write and one rename, the previous bytes plus this writer's field with the
    // JSONC comment intact, and nothing left behind.
    expect(staged()).toBe(stagedAt + 1)
    expect(committed()).toBe(committedAt + 1)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain('"model": "cancelled-mid-commit"')
    expect(text).toContain("// keep this comment")
    expect((yield* Effect.promise(() => fs.readdir(global))).filter((name) => name.startsWith("."))).toEqual([])
    // A protected reader sees the committed document rather than a truncated one, and a later writer is unblocked.
    const read = yield* readFallback(route.read)
    expect(read.status).toBe(200)
    expect(read.fallback).toEqual({ providerID: "openai", model: "cancelled-mid-commit" })
    expect(yield* route.patch({ shell: "fish" })).toMatchObject({ status: 204 })
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
