import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Arbitrary, Deferred, Effect, Fiber, Layer, Logger, Option, Schema, Stream } from "effect"
import { Exit, FileSystem, PlatformError, PubSub } from "effect"
import { Config } from "@opencode/core/config"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { ConfigIntegration } from "@opencode/core/config/integration"
import { ConfigFallback } from "@opencode/core/config/fallback"
import { FallbackRuntimeIntent } from "@opencode/core/config/fallback-runtime-intent"
import { SessionGenerationAdmission } from "@opencode/core/session/generation-admission"
import { Directory, Document, type Entry, Event, Info } from "@opencode/schema/config"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { filesystem as platformFilesystem } from "@opencode/util/effect/app-node-platform"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { ConfigV1 } from "../fixture/v1-config/config"
import { ConfigPermissionV1 } from "@opencode/core/v1/config/permission"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigVariable } from "@opencode/core/config/variable"
import { FSUtil } from "@opencode/util/fs-util"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { KV } from "@opencode/core/kv"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { Wildcard } from "@opencode/core/util/wildcard"
import { Integration } from "@opencode/schema/integration"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { withEnv } from "../fixture/env"
import { location } from "../fixture/location"
import { tmpdir, withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const itWithPermissions = process.platform === "win32" || process.getuid?.() === 0 ? it.live.skip : it.live
const selection = Schema.decodeUnknownSync(ConfigModel.Selection)
const decodeInfo = Schema.decodeUnknownSync(Info, { errors: "all", onExcessProperty: "ignore" })
const encodeInfo = Schema.encodeSync(Info)

function migrateV1(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return encodeInfo(decodeInfo(result.encoded))
}

function inFixture(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  vcs?: Project.Vcs,
  watcher: Layer.Layer<Watcher.Service | Watcher.Test> = Watcher.testLayer,
  credentialNode = emptyCredentialNode,
  wellknownNode = emptyWellknownNode,
  options?: Config.Options,
  fileSystem: Layer.Layer<FileSystem.FileSystem> = NodeFileSystem.layer,
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(projectDirectory), vcs },
      ),
    ),
  )
  // The intent service and admission service are part of the built graph already
  // (Config.node depends on them); listing them in the build group exposes the very
  // instances the config layer uses so tests can hold leases and observe staging.
  const built = AppNodeBuilder.build(
    LayerNode.group([Config.node, Bus.node, FallbackRuntimeIntent.node, SessionGenerationAdmission.node]),
    [
      Config.node.replace(Config.configured({ system: false, ...options })),
      Location.node.replace(locationLayer),
      Global.node.replace(Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })),
      Credential.node.replace(credentialNode),
      WellKnown.node.replace(wellknownNode),
      Watcher.node.replace(watcher),
      platformFilesystem.replace(fileSystem),
    ],
  )
  // Merge the watcher layer by reference so Watcher.Test resolves to the same
  // memoized instance the built graph uses.
  return Layer.mergeAll(built, watcher)
}

// Deterministic injection at the real filesystem owner: the graph's FileSystem
// instance is wrapped so only the recorded operations can fail. Every assertion
// below also proves the injected operation was actually reached.
type FilesystemCalls = {
  writes: Array<{ path: string; content: string }>
  renames: Array<[string, string]>
  removes: Array<string>
  reads: Array<{ path: string; failed: boolean }>
  chmods: Array<{ path: string; mode: number }>
}
type FilesystemFaults = {
  write: boolean | ((target: string) => boolean)
  rename: boolean
  remove: boolean
  read: (path: string) => boolean
  afterRename: (from: string, to: string) => Effect.Effect<void>
}
// Single-use parking barriers (S2): the injected filesystem can stop the first read of a
// target path, the first write, or the first rename at a Deferred until the test releases it.
// Each armed gate is consumed by exactly one call and can be re-armed afterwards, so a test
// can park several successive operations while S1 commit flows stay undiverted.
type FilesystemBarriers = {
  read: Map<string, Deferred.Deferred<unknown>>
  write: Deferred.Deferred<unknown> | undefined
  rename: Deferred.Deferred<unknown> | undefined
}

const ioFault = (method: string, target: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: target,
    cause: Object.assign(new Error("EIO"), { code: "EIO" }),
  })

function filesystemInjection() {
  const calls: FilesystemCalls = { writes: [], renames: [], removes: [], reads: [], chmods: [] }
  const faults: FilesystemFaults = {
    write: false,
    rename: false,
    remove: false,
    read: () => false,
    afterRename: () => Effect.void,
  }
  const barriers: FilesystemBarriers = {
    read: new Map(),
    write: undefined,
    rename: undefined,
  }
  const armReadGate = (target: string, wait: Deferred.Deferred<unknown>) => barriers.read.set(target, wait)
  const armWriteGate = (wait: Deferred.Deferred<unknown>) => (barriers.write = wait)
  const armRenameGate = (wait: Deferred.Deferred<unknown>) => (barriers.rename = wait)
  // Spin until an asynchronously observable state (intent staging, a parked call) has been
  // reached. This is a synchronization predicate, not a fixed sleep: the test proceeds the
  // moment the boundary is hit, and fails loudly if it never is.
  const awaitUntil = (predicate: () => Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      let spins = 0
      while (true) {
        if (yield* predicate()) return
        if (spins++ > 2_000) return yield* Effect.die(new Error("barrier wait was never reached"))
        yield* Effect.yieldNow
      }
    })
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return {
        ...fs,
        readFileString: (target: string, encoding?: string) => {
          const failed = faults.read(target)
          calls.reads.push({ path: target, failed })
          const gate = !failed ? barriers.read.get(target) : undefined
          if (gate !== undefined) {
            barriers.read.delete(target)
            return Effect.yieldNow.pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(fs.readFileString(target, encoding)),
            )
          }
          return failed
            ? Effect.fail(ioFault("readFileString", target))
            : fs.readFileString(target, encoding)
        },
        writeFileString: (target: string, content: string) => {
          calls.writes.push({ path: target, content })
          const fault = typeof faults.write === "function" ? faults.write(target) : faults.write
          if (barriers.write !== undefined) {
            const gate = barriers.write
            barriers.write = undefined
            return Effect.yieldNow.pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(fault ? Effect.fail(ioFault("writeFileString", target)) : fs.writeFileString(target, content)),
            )
          }
          return fault
            ? Effect.fail(ioFault("writeFileString", target))
            : fs.writeFileString(target, content)
        },
        rename: (from: string, to: string) => {
          calls.renames.push([from, to])
          if (barriers.rename !== undefined) {
            const gate = barriers.rename
            barriers.rename = undefined
            return Effect.yieldNow.pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(
                faults.rename
                  ? Effect.fail(ioFault("rename", from))
                  : fs.rename(from, to).pipe(Effect.andThen(faults.afterRename(from, to))),
              ),
            )
          }
          return faults.rename
            ? Effect.fail(ioFault("rename", from))
            : fs.rename(from, to).pipe(Effect.andThen(faults.afterRename(from, to)))
        },
        remove: (target: string, options?: { force?: boolean; recursive?: boolean }) => {
          calls.removes.push(target)
          return faults.remove ? Effect.fail(ioFault("remove", target)) : fs.remove(target, options)
        },
        chmod: (target: string, mode: number) => {
          calls.chmods.push({ path: target, mode })
          return fs.chmod(target, mode)
        },
      }
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))
  return { calls, faults, barriers, armReadGate, armWriteGate, armRenameGate, awaitUntil, layer }
}

const injectedLayer = (project: string, global: string, injection: ReturnType<typeof filesystemInjection>) =>
  testLayer(
    project,
    global,
    project,
    undefined,
    Watcher.testLayer,
    emptyCredentialNode,
    emptyWellknownNode,
    undefined,
    injection.layer,
  )

function seedConfig(project: string, global: string, file: string, text: string, mode?: number) {
  return Effect.promise(async () => {
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(global)
    await fs.writeFile(file, text)
    if (mode !== undefined) await fs.chmod(file, mode)
  })
}

const readConfig = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const configMode = (file: string) =>
  Effect.promise(async () => ((await fs.stat(file)).mode & 0o777) >>> 0)
const directoryEntries = (directory: string) => Effect.promise(() => fs.readdir(directory))

const selectedFallback = { providerID: "openai", model: "gpt-test", variant: "high" }

const tool = (effect: "allow" | "deny") => ({ action: "tool.use", resource: "shell:*", effect })

const provider = {
  package: "native",
  settings: {},
  headers: {},
  body: {},
  models: {},
}

describe("Config", () => {
  it.live("persists fallback null without changing shell and preserves null on reload", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = "{}\n"
          yield* Effect.promise(() => Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(global)]))
          yield* Effect.promise(() => fs.writeFile(file, initial))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const first = yield* config.entries()
            expect(Config.latest(first, "fallback")).toBeUndefined()
            expect(ConfigFallback.resolve(Config.latest(first, "fallback"))).toEqual(ConfigFallback.LEGACY_MODEL_FALLBACK)

            const selectedFallback = { providerID: "openai", model: "gpt-test", variant: "high" }
            yield* config.update({ shell: "/bin/zsh", fallback: selectedFallback })
            const selected = yield* config.entries()
            expect(Config.latest(selected, "fallback")).toMatchObject({
              providerID: "openai",
              model: "gpt-test",
              variant: "high",
            })

            yield* Effect.promise(() =>
              fs.writeFile(file, '{\n  // keep this comment\n  "username": "kept"\n}\n'),
            )
            yield* config.update({ shell: "/bin/bash", fallback: selectedFallback })
            const commented = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            expect(commented).toContain('"shell": "/bin/bash"')
            expect(commented).toContain('"fallback": {')
            expect(commented).toContain('"username": "kept"')
            expect(commented).toContain("keep this comment")

            yield* config.update({ shell: null, fallback: null })
            const saved = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            expect(saved).not.toContain('"shell":')
            expect(saved).toContain('"username": "kept"')
            expect(saved).toContain('"fallback": null')
            expect(saved).toContain("keep this comment")

            const reloaded = yield* config.entries()
            expect(Config.latest(reloaded, "fallback")).toBeNull()
            expect(ConfigFallback.resolve(Config.latest(reloaded, "fallback"))).toBeNull()
          }).pipe(Effect.provide(testLayer(project, global)))
        }),
      ),
    ),
  )

  it.live("excludes home-level claude and agents directories when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(global, "home")
        const project = path.join(home, "project")
        return Effect.promise(() =>
          Promise.all([
            fs.mkdir(project, { recursive: true }),
            fs.mkdir(path.join(home, ".claude"), { recursive: true }),
            fs.mkdir(path.join(home, ".agents"), { recursive: true }),
          ]),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // The fixture is real: with global enabled the walk finds both.
              const config = yield* Config.Service
              const compatibility = yield* config.compatibility!()
              expect([...compatibility.claude, ...compatibility.agents]).toHaveLength(2)
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.andThen(
            // Home-level directories are global config however the walk
            // reaches them, so global: false excludes them even with the
            // project walk enabled.
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(yield* config.compatibility!()).toEqual({ claude: [], agents: [] })
              const watcher = yield* Watcher.Test
              expect(
                (yield* watcher.subscriptions()).filter((watch) => watch.type === "entries" && watch.path === home),
              ).toEqual([])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("excludes claude directories when claude is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(global, "home")
        const project = path.join(tmp.path, "project")
        return Effect.promise(() =>
          Promise.all([
            fs.mkdir(path.join(home, ".claude"), { recursive: true }),
            fs.mkdir(path.join(home, ".agents"), { recursive: true }),
            fs.mkdir(path.join(project, ".claude"), { recursive: true }),
            fs.mkdir(path.join(project, ".agents"), { recursive: true }),
          ]),
        ).pipe(
          Effect.andThen(
            // Fixture control: both global and project claude dirs are found by default.
            Effect.gen(function* () {
              const config = yield* Config.Service
              const compatibility = yield* config.compatibility!()
              expect(compatibility.claude.filter((item) => inFixture(tmp.path, item))).toEqual([
                AbsolutePath.make(path.join(home, ".claude")),
                AbsolutePath.make(path.join(project, ".claude")),
              ])
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const compatibility = yield* config.compatibility!()
              expect(compatibility.claude).toEqual([])
              expect(compatibility.agents.filter((item) => inFixture(tmp.path, item))).toEqual([
                AbsolutePath.make(path.join(home, ".agents")),
                AbsolutePath.make(path.join(project, ".agents")),
              ])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { claude: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("excludes global config reached through the project walk when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        // The location sits BENEATH the global config dir, so the upward walk
        // reaches the global opencode.json as a direct file.
        const global = path.join(tmp.path, "global")
        const project = path.join(global, "plugins", "demo")
        return Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global-sentinel" }))
        }).pipe(
          Effect.andThen(
            // Fixture control: with global enabled the file loads.
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("global-sentinel")
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBeUndefined()
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  // Filesystem sandboxes deny reads outside the project. Simulate a denied discovery root with a
  // symlink into an unsearchable directory, which makes realpath fail with EACCES.
  itWithPermissions("treats unreadable discovery roots as absent", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(global, "home")
        const project = path.join(home, "project")
        const locked = path.join(tmp.path, "locked")
        return Effect.promise(async () => {
          await fs.mkdir(path.join(locked, "agents"), { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell: "project" }))
          await fs.symlink(path.join(locked, "agents"), path.join(home, ".agents"))
          await fs.symlink(path.join(locked, "agents"), path.join(project, ".opencode"))
          await fs.chmod(locked, 0o000)
        }).pipe(
          Effect.andThen(Effect.addFinalizer(() => Effect.promise(() => fs.chmod(locked, 0o755)))),
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              expect(entries.flatMap((entry) => (entry.type === "document" ? [entry.info.shell] : []))).toEqual([
                "project",
              ])
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.scoped,
        )
      }),
    ),
  )

  it.live("discovers the global config directory once when the project walk reaches it", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        // The global config dir is the project's own .opencode (as isolated
        // hosts pin OPENCODE_CONFIG_DIR), and the location is the project under
        // a symlinked spelling, so the walk reaches the same directory under a
        // different string than the global root.
        const real = path.join(tmp.path, "real")
        const link = path.join(tmp.path, "link")
        const global = AbsolutePath.make(path.join(real, ".opencode"))
        const once = Effect.gen(function* () {
          const config = yield* Config.Service
          const watcher = yield* Watcher.Test
          const entries = yield* config.entries()
          expect(entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))).toEqual([global])
          expect(entries.flatMap((entry) => (entry.type === "document" ? [entry.info.shell] : []))).toEqual(["global"])
          expect(
            (yield* watcher.subscriptions())
              .filter((subscription) => subscription.type === "directory")
              .map((subscription) => subscription.path),
          ).toEqual([global])
          expect(
            (yield* watcher.subscriptions()).filter((subscription) =>
              subscription.path.includes(`${path.sep}.opencode${path.sep}`),
            ),
          ).toEqual([])
        })
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.symlink(real, link, process.platform === "win32" ? "junction" : undefined)
        }).pipe(
          Effect.andThen(once.pipe(Effect.provide(testLayer(link, global, real)))),
          // Same spelling on both sides: still exactly once.
          Effect.andThen(once.pipe(Effect.provide(testLayer(real, global, real)))),
        )
      }),
    ),
  )

  it.live("loads system configuration at highest priority", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const system = path.join(tmp.path, "system")
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        return Effect.promise(async () => {
          await fs.mkdir(system, { recursive: true })
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(
            path.join(system, "opencode.json"),
            JSON.stringify({ shell: "system", username: "system-user", experimental: { policies: [tool("deny")] } }),
          )
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(
            path.join(project, "opencode.json"),
            JSON.stringify({ shell: "project", experimental: { policies: [tool("allow")] } }),
          )
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              expect(
                entries.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
              ).toEqual(["global", "project", "system"])
              expect(entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))).toEqual([
                AbsolutePath.make(global),
                AbsolutePath.make(system),
              ])
              expect(Config.latest(entries, "shell")).toBe("system")
              expect(Config.latest(entries, "username")).toBe("system-user")
              expect(ManagedPolicy.decision(ManagedPolicy.statements(entries), "tool.use", "shell:ls")).toBe("deny")
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  system,
                }),
              ),
            ),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              expect(
                entries.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
              ).toEqual(["global", "project"])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  system: false,
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  test("resolves the system configuration directory per platform", () => {
    expect(ConfigDiscovery.systemDirectory("darwin", {})).toBe(
      AbsolutePath.make("/Library/Application Support/opencode"),
    )
    expect(ConfigDiscovery.systemDirectory("linux", {})).toBe(AbsolutePath.make("/etc/opencode"))
    expect(ConfigDiscovery.systemDirectory("win32", { ProgramData: "D:\\ProgramData" })).toBe(
      AbsolutePath.make(path.join("D:\\ProgramData", "opencode")),
    )
    expect(ConfigDiscovery.systemDirectory("win32", {})).toBe(
      AbsolutePath.make(path.join("C:\\ProgramData", "opencode")),
    )
  })

  test("resolves macOS managed preferences with user-specific profiles first", () => {
    expect(ConfigDiscovery.preferencePaths("alice")).toEqual([
      AbsolutePath.make(path.join("/Library/Managed Preferences", "alice", "ai.opencode.managed.plist")),
      AbsolutePath.make("/Library/Managed Preferences/ai.opencode.managed.plist"),
    ])
  })

  test("strips MDM payload metadata from managed preferences", () => {
    expect(
      JSON.parse(
        ConfigDiscovery.stripPreferenceMetadata(
          JSON.stringify({
            PayloadDisplayName: "OpenCode",
            PayloadIdentifier: "ai.opencode.managed",
            PayloadType: "ai.opencode.managed",
            PayloadUUID: "00000000-0000-0000-0000-000000000000",
            PayloadVersion: 1,
            _manualProfile: true,
            share: "disabled",
          }),
        ),
      ),
    ).toEqual({ share: "disabled" })
  })

  it.live("loads explicit file and content overrides in priority order", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const explicit = path.join(tmp.path, "custom.json")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(explicit, JSON.stringify({ shell: "explicit" }))
          await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              expect(
                entries.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
              ).toEqual(["global", "explicit", "project", "content"])
              expect(Config.latest(entries, "shell")).toBe("content")
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  file: explicit,
                  content: JSON.stringify({ shell: "content" }),
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("layers integration documents below remote and user config and reloads when they change", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const named = (name: string) => ({ providers: { remote: { name } } })
        yield* Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify(named("global")))
          await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify(named("project")))
        })
        const integrationID = Integration.ID.make("https://example.com")
        const credentialNode = makeGlobalNode({
          service: Credential.Service,
          layer: Layer.mock(Credential.Service)({
            list: () =>
              Effect.succeed([
                new Credential.Info({
                  id: Credential.ID.create(),
                  integrationID,
                  label: "default",
                  value: Credential.Key.make({ type: "key", key: "secret" }),
                }),
              ]),
          }),
          deps: [],
        })
        const entry: WellKnown.Entry = {
          origin: "https://example.com",
          integrationID,
          manifest: { auth: { command: ["login"], env: "TOKEN" } },
        }
        const wellknownNode = makeGlobalNode({
          service: WellKnown.Service,
          layer: Layer.mock(WellKnown.Service)({
            entries: () => Effect.succeed([entry]),
            snapshot: () => [entry],
            resolve: () => Effect.succeed([named("wellknown")]),
          }),
          deps: [],
        })
        const names = (entries: readonly Entry[]) =>
          entries.flatMap((entry) => (entry.type === "document" ? [entry.info.providers?.remote?.name] : []))

        return yield* Effect.gen(function* () {
          const config = yield* Config.Service
          const bus = yield* Bus.Service
          const updated = Effect.fnUntraced(function* (change: Effect.Effect<void>) {
            const event = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
            yield* change
            expect(yield* Fiber.join(event)).toHaveLength(1)
            return names(yield* config.entries())
          })
          const integration = Integration.ID.make("opencode")
          expect(names(yield* config.entries())).toEqual(["wellknown", "global", "project"])
          expect(
            yield* updated(
              config.integration!(
                integration,
                ConfigIntegration.make({
                  integrationID: integration,
                  connection: { type: "env", name: "OPENCODE_API_KEY" },
                  info: decodeInfo(named("console")),
                }),
              ),
            ),
          ).toEqual(["console", "wellknown", "global", "project"])
          expect(yield* updated(config.integration!(integration, undefined))).toEqual([
            "wellknown",
            "global",
            "project",
          ])
        }).pipe(
          Effect.provide(testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode)),
        )
      }),
    ),
  )

  it.live("ranks integration policies below managed policies and above user and project policies", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const system = path.join(tmp.path, "system")
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const shell = (resource: string, effect: "allow" | "deny") => ({ action: "tool.use", resource, effect })
        const write = (directory: string, policies: unknown[]) =>
          fs
            .mkdir(directory, { recursive: true })
            .then(() => fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify({ policies })))
        return Effect.promise(() =>
          Promise.all([
            write(system, [shell("shell:rm*", "deny")]),
            write(global, [shell("shell:*", "allow")]),
            write(project, [shell("shell:*", "allow")]),
          ]),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const integration = Integration.ID.make("opencode")
              yield* config.integration!(
                integration,
                ConfigIntegration.make({
                  integrationID: integration,
                  connection: { type: "env", name: "OPENCODE_API_KEY" },
                  organization: "Acme",
                  info: decodeInfo({ policies: [shell("shell:rm*", "allow"), shell("shell:*", "deny")] }),
                }),
              )
              const statements = ManagedPolicy.statements(yield* config.entries())
              const deciding = (resource: string) =>
                statements.findLast(
                  (policy) => policy.action === "tool.use" && Wildcard.match(resource, policy.resource),
                )
              expect(deciding("shell:rm -rf")).toMatchObject({
                effect: "deny",
                message: "Blocked by configuration policy",
              })
              expect(deciding("shell:ls")).toMatchObject({ effect: "deny", message: "Blocked by Acme's policy" })
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  system,
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("keeps only the policies of documents from integrations managed policy denies", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const system = path.join(tmp.path, "system")
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const allowed = "org_allowed"
        const opencode = Integration.ID.make("opencode")
        const origin = "https://ai.acme.com"
        const credentialID = Credential.ID.create()
        let org = "org_personal"
        const credentialNode = makeGlobalNode({
          service: Credential.Service,
          layer: Layer.mock(Credential.Service)({
            list: (integrationID) =>
              Effect.succeed([
                new Credential.Info({
                  id: Credential.ID.create(),
                  integrationID,
                  label: "default",
                  value: Credential.Key.make({ type: "key", key: "secret" }),
                }),
              ]),
            get: (id) =>
              Effect.succeed(
                new Credential.Info({
                  id,
                  integrationID: opencode,
                  label: "Console",
                  value: Credential.Key.make({ type: "key", key: "secret", metadata: { orgID: org } }),
                }),
              ),
          }),
          deps: [],
        })
        const entry: WellKnown.Entry = {
          origin,
          integrationID: Integration.ID.make(origin),
          manifest: { auth: { command: ["login"], env: "TOKEN" } },
        }
        const wellknownNode = makeGlobalNode({
          service: WellKnown.Service,
          layer: Layer.mock(WellKnown.Service)({
            entries: () => Effect.succeed([entry]),
            snapshot: () => [entry],
            resolve: () =>
              Effect.succeed([
                {
                  mcp: { servers: { wiki: { type: "remote", url: "https://wiki.acme.com/mcp" } } },
                  policies: [{ action: "tool.use", resource: "shell:rm*", effect: "deny" }],
                },
              ]),
          }),
          deps: [],
        })
        const supplied = (entries: readonly Entry[]) =>
          entries.flatMap((entry) =>
            entry.type === "document" && !entry.path
              ? [{ servers: Object.keys(entry.info.mcp?.servers ?? {}), policies: entry.info.policies?.length ?? 0 }]
              : [],
          )
        return Effect.promise(() =>
          fs.mkdir(system, { recursive: true }).then(() =>
            fs.writeFile(
              path.join(system, "opencode.json"),
              JSON.stringify({
                policies: [
                  { action: "integration.use", resource: "*", effect: "deny" },
                  { action: "integration.use", resource: `opencode#${allowed}`, effect: "allow" },
                ],
              }),
            ),
          ),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const install = () =>
                config.integration!(
                  opencode,
                  ConfigIntegration.make({
                    integrationID: opencode,
                    connection: { type: "credential", id: credentialID, label: "Console", method: "key" },
                    organization: org,
                    info: decodeInfo({
                      mcp: { servers: { docs: { type: "remote", url: "https://docs.acme.com/mcp" } } },
                      policies: [{ action: "mcp.use", resource: "github", effect: "deny" }],
                    }),
                  }),
                )
              yield* install()
              // The personal account's servers and the denied well-known origin's config are gone; their policies stay.
              expect(supplied(yield* config.entries())).toEqual([
                { servers: [], policies: 1 },
                { servers: [], policies: 1 },
              ])
              org = allowed
              yield* config.integration!(opencode, undefined)
              yield* install()
              expect(supplied(yield* config.entries())).toEqual([
                { servers: ["docs"], policies: 1 },
                { servers: [], policies: 1 },
              ])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode, {
                  system,
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("skips project configuration when project discovery is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("global")
              const watcher = yield* Watcher.Test
              expect((yield* watcher.subscriptions()).map((subscription) => subscription.path)).toEqual([global])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  project: false,
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("reloads file substitutions when their source changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.json")
          const source = path.join(global, "shell.txt")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(source, "first")
            await fs.writeFile(file, JSON.stringify({ shell: "{file:shell.txt}" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const watcher = yield* Watcher.Test
            const changed = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.sleep("10 millis")

            yield* Effect.promise(() => fs.writeFile(source, "second"))
            yield* watcher.emit({ type: "update", path: source })

            expect(yield* Fiber.join(changed)).toHaveLength(1)
            expect(Config.latest(yield* config.entries(), "shell")).toBe("second")
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  it.live("excludes missing files under symlinked global roots when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const link = path.join(tmp.path, "link")
        const project = path.join(link, "plugins", "demo")
        return Effect.promise(async () => {
          await fs.mkdir(path.join(global, "plugins", "demo"), { recursive: true })
          await fs.symlink(global, link, process.platform === "win32" ? "junction" : undefined)
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const watcher = yield* Watcher.Test
              const subscriptions = yield* watcher.subscriptions()
              expect(subscriptions.length).toBeGreaterThan(0)
              expect(
                subscriptions.filter((item) => inFixture(global, item.path) || inFixture(link, item.path)),
              ).toEqual([])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("exposes filesystem updates under config roots through changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, "commands"), { recursive: true })
            await fs.mkdir(project, { recursive: true })
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            const received = yield* config
              .changes()
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.sleep("10 millis")

            const file = path.join(global, "commands", "review.md")
            yield* watcher.emit({ type: "update", path: file })

            const collected = yield* Fiber.join(received).pipe(Effect.timeout("1 second"))
            expect(Array.from(collected)).toEqual([{ type: "update", path: file }])
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  // Real watcher on purpose: the regression this pins (a deleted config file's
  // watch being torn down, making recreation invisible) only reproduces with
  // path-faithful event delivery.
  it.live("keeps watching a deleted config file so recreating it reloads", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(project, "opencode.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(file, JSON.stringify({ shell: "one" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            expect(Config.latest(yield* config.entries(), "shell")).toBe("one")
            yield* Effect.sleep("10 millis")

            const removed = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.promise(() => fs.rm(file))
            yield* Fiber.join(removed).pipe(Effect.timeout("5 seconds"))
            expect(Config.latest(yield* config.entries(), "shell")).toBeUndefined()

            const recreated = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ shell: "two" })))
            yield* Fiber.join(recreated).pipe(Effect.timeout("5 seconds"))
            expect(Config.latest(yield* config.entries(), "shell")).toBe("two")
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
                Config.node.replace(Config.configured({ system: false })),
                Location.node.replace(
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                  ),
                ),
                Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
                Credential.node.replace(emptyCredentialNode),
                WellKnown.node.replace(emptyWellknownNode),
              ]),
            ),
          )
        }),
      ),
    ),
  )

  it.effect("backs Config.Service and Config.Test with one shared test implementation", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const test = yield* Config.Test
      expect(yield* config.entries()).toEqual([])

      const entry = new Document({ type: "document", info: new Info({}) })
      yield* test.setEntries([entry])
      expect(yield* config.entries()).toEqual([entry])

      const received = yield* config
        .changes()
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* test.emitChange({ type: "create", path: "/root/commands/review.md" })
      expect(Array.from(yield* Fiber.join(received))).toEqual([{ type: "create", path: "/root/commands/review.md" }])
    }).pipe(Effect.provide(Config.testLayer())),
  )

  test("returns the latest defined scalar from priority-ordered documents", () => {
    const entries = [
      new Document({
        type: "document",
        info: new Info({ model: selection("openrouter/openai/gpt-5") }),
      }),
      new Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
      new Document({ type: "document", info: new Info({}) }),
      new Document({
        type: "document",
        info: new Info({ model: selection("openrouter/openai/gpt-5.5") }),
      }),
    ]

    expect(Config.latest(entries, "model")).toEqual(selection("openrouter/openai/gpt-5.5"))
    expect(Config.latest(entries, "default_agent")).toBeUndefined()
  })

  it.live("tolerates unavailable authenticated wellknown config and reloads it later", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        yield* Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell: "project" }))
        })

        const integrationID = Integration.ID.make("https://example.com")
        let available = false
        let key = "secret"
        const credentialNode = makeGlobalNode({
          service: Credential.Service,
          layer: Layer.succeed(
            Credential.Service,
            Credential.Service.of({
              refresh: () => Effect.die("unused Credential.refresh"),
              all: () => Effect.die("unused Credential.all"),
              list: () =>
                Effect.succeed([
                  new Credential.Info({
                    id: Credential.ID.create(),
                    integrationID,
                    label: "default",
                    value: Credential.Key.make({ type: "key", key }),
                  }),
                ]),
              get: () => Effect.die("unused Credential.get"),
              create: () => Effect.die("unused Credential.create"),
              activate: () => Effect.die("unused Credential.activate"),
              update: () => Effect.die("unused Credential.update"),
              remove: () => Effect.die("unused Credential.remove"),
            }),
          ),
          deps: [],
        })
        const entry: WellKnown.Entry = {
          origin: "https://example.com",
          integrationID,
          manifest: { auth: { command: ["login"], env: "TOKEN" } },
        }
        const wellknownNode = makeGlobalNode({
          service: WellKnown.Service,
          layer: Layer.succeed(
            WellKnown.Service,
            WellKnown.Service.of({
              entries: () => Effect.succeed([entry]),
              snapshot: () => [entry],
              refresh: () => Effect.succeed(false),
              add: () => Effect.die("unused Wellknown.add"),
              remove: () => Effect.die("unused Wellknown.remove"),
              resolve: (_entry, variables) =>
                available ? Effect.succeed([{ shell: variables.TOKEN }]) : Effect.fail(new Error("expired credential")),
              cached: () => Effect.succeed([]),
              clearCached: () => Effect.void,
            }),
          ),
          deps: [],
        })

        return yield* Effect.gen(function* () {
          const config = yield* Config.Service
          const bus = yield* Bus.Service
          const initial = yield* config.entries()
          expect(Config.latest(initial, "shell")).toBe("project")
          expect(
            initial.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
          ).toEqual(["global", "project"])
          const updated = yield* bus.subscribe(Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
          yield* Effect.yieldNow
          available = true
          key = "next"
          yield* bus.publish(
            Credential.Event.Switched,
            { credentialID: Credential.ID.create(), integrationID },
            { global: true },
          )
          expect(yield* Fiber.join(updated)).toHaveLength(1)
          const refreshed = yield* config.entries()
          expect(Config.latest(refreshed, "shell")).toBe("project")
          expect(
            refreshed.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
          ).toEqual(["next", "global", "project"])
        }).pipe(
          Effect.provide(testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode)),
        )
      }),
    ),
  )

  it.live("keeps the last resolved wellknown config across failures and restarts while a credential exists", () =>
    withTempDir((tmp) => {
      let manifestStatus = 200
      let configStatus = 200
      let requests = 0
      let key: string | undefined = "secret"
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/.well-known/opencode") {
            if (manifestStatus !== 200) return new Response("Unavailable", { status: manifestStatus })
            return Response.json({
              auth: { command: ["login"], env: "TOKEN" },
              remote_config: { url: `${url.origin}/config`, headers: { authorization: "Bearer {env:TOKEN}" } },
            })
          }
          requests++
          if (configStatus !== 200) return new Response("Unavailable", { status: configStatus })
          return Response.json({
            config: {
              enabled_providers: ["remote"],
              provider: { remote: { npm: "@ai-sdk/openai-compatible", models: { chat: {} } } },
            },
          })
        },
      })
      const origin = server.url.origin
      const integrationID = Integration.ID.make(origin)
      const credentialNode = makeGlobalNode({
        service: Credential.Service,
        layer: Layer.mock(Credential.Service)({
          list: () =>
            Effect.succeed(
              key === undefined
                ? []
                : [
                    new Credential.Info({
                      id: Credential.ID.create(),
                      integrationID,
                      label: "default",
                      value: Credential.Key.make({ type: "key", key }),
                    }),
                  ],
            ),
        }),
        deps: [],
      })
      const global = path.join(tmp.path, "global")
      const project = path.join(tmp.path, "project")
      const remote = (entries: readonly Entry[]) => ({
        provider: Config.latest(entries, "providers")?.remote?.package,
        policies: Config.latest(entries, "policies"),
      })
      const loaded = {
        provider: "aisdk:@ai-sdk/openai-compatible",
        policies: [
          { action: "provider.use", resource: "*", effect: "deny" },
          { action: "provider.use", resource: "remote", effect: "allow" },
        ],
      } as const
      const removed = { provider: undefined, policies: undefined }
      return Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
        const kv = Layer.succeedContext(yield* Layer.build(LayerNode.compile(KV.node)))
        // Each build is a fresh process sharing one persisted KV store.
        const instance = () =>
          AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WellKnown.node]), [
            Config.node.replace(Config.configured({ system: false })),
            Location.node.replace(
              Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
            ),
            Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
            Credential.node.replace(credentialNode),
            KV.node.replace(kv),
            Watcher.node.replace(Watcher.testLayer),
          ])
        const services = Effect.gen(function* () {
          const config = yield* Config.Service
          const bus = yield* Bus.Service
          // Each reload also rewrites a local file so Config publishes an update to wait on.
          const reload = Effect.fnUntraced(function* (shell: string, trigger: Effect.Effect<unknown, Error>) {
            const updated = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ shell })))
            yield* trigger
            yield* Fiber.join(updated)
            return remote(yield* config.entries())
          })
          const switched = bus.publish(
            Credential.Event.Switched,
            { credentialID: Credential.ID.create(), integrationID },
            { global: true },
          )
          return { config, bus, wellknown: yield* WellKnown.Service, reload, switched }
        })

        yield* Effect.gen(function* () {
          const warm = yield* services
          expect(yield* warm.reload("initial", warm.wellknown.add(origin))).toEqual(loaded)

          configStatus = 503
          const before = requests
          expect(yield* warm.reload("unavailable", warm.switched)).toEqual(loaded)
          expect(requests).toBeGreaterThan(before)

          key = undefined
          expect(yield* warm.reload("logged-out", warm.switched)).toEqual(removed)

          // Logging out drops the saved config, so logging back in while the remote is down supplies nothing.
          key = "secret"
          expect(yield* warm.reload("logged-in-unavailable", warm.switched)).toEqual(removed)
          configStatus = 200
          expect(yield* warm.reload("logged-in", warm.switched)).toEqual(loaded)
          configStatus = 503

          manifestStatus = 503
          const updated = yield* warm.bus
            .subscribe(WellKnown.Event.Updated)
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
          expect(yield* warm.wellknown.refresh()).toBe(false)
          yield* Effect.sleep("50 millis")
          expect(updated.pollUnsafe()).toBeUndefined()
        }).pipe(Effect.scoped, Effect.provide(instance()))

        yield* Effect.gen(function* () {
          const cold = yield* services
          expect(remote(yield* cold.config.entries())).toEqual(loaded)
          // The wellknown plugin loads these entries at startup and dies if they fail.
          expect(yield* cold.wellknown.entries()).toHaveLength(1)
          expect(yield* cold.reload("removed", cold.wellknown.remove(origin))).toEqual(removed)
          manifestStatus = 200
          expect(yield* cold.reload("re-added", cold.wellknown.add(origin))).toEqual(removed)
        }).pipe(Effect.scoped, Effect.provide(instance()))
      }).pipe(Effect.ensuring(Effect.promise(() => server.stop(true))))
    }),
  )

  it.live("logs redacted source-aware diagnostics for every config source", () => {
    const output: Array<Record<string, unknown>> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "configuration normalization diagnostic") return
      const details = entry.message[1]
      if (typeof details === "object" && details !== null) output.push(details as Record<string, unknown>)
    })
    return withTempDir((tmp) =>
      Effect.gen(function* () {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const malformed = path.join(tmp.path, "malformed.json")
        yield* Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "opencode.json"), "null")
          await fs.writeFile(path.join(project, "opencode.json"), "")
          await fs.writeFile(malformed, '{ "credential": "file-secret"')
        })
        const integrationID = Integration.ID.make("https://invalid.example.com")
        const entry: WellKnown.Entry = {
          origin: "https://invalid.example.com",
          integrationID,
          manifest: { auth: { command: ["login"], env: "TOKEN" } },
        }
        const credentialNode = makeGlobalNode({
          service: Credential.Service,
          layer: Layer.succeed(
            Credential.Service,
            Credential.Service.of({
              refresh: () => Effect.die("unused Credential.refresh"),
              all: () => Effect.die("unused Credential.all"),
              list: () =>
                Effect.succeed([
                  new Credential.Info({
                    id: Credential.ID.create(),
                    integrationID,
                    label: "default",
                    value: Credential.Key.make({ type: "key", key: "wellknown-secret" }),
                  }),
                ]),
              get: () => Effect.die("unused Credential.get"),
              create: () => Effect.die("unused Credential.create"),
              activate: () => Effect.die("unused Credential.activate"),
              update: () => Effect.die("unused Credential.update"),
              remove: () => Effect.die("unused Credential.remove"),
            }),
          ),
          deps: [],
        })
        const wellknownNode = makeGlobalNode({
          service: WellKnown.Service,
          layer: Layer.succeed(
            WellKnown.Service,
            WellKnown.Service.of({
              entries: () => Effect.succeed([entry]),
              snapshot: () => [entry],
              refresh: () => Effect.succeed(false),
              add: () => Effect.die("unused Wellknown.add"),
              remove: () => Effect.die("unused Wellknown.remove"),
              // Exercise the loader boundary against a malformed implementation response.
              resolve: () => Effect.succeed([null as unknown as WellKnown.Config]),
              cached: () => Effect.succeed([]),
              clearCached: () => Effect.void,
            }),
          ),
          deps: [],
        })

        yield* Config.Service.use((config) => config.entries()).pipe(
          Effect.provide(
            testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode, {
              file: malformed,
              content: "",
            }),
          ),
        )

        expect(output.map((item) => `${item.source}:${item.path}:${item.kind}`).toSorted()).toEqual(
          [
            `${path.join(global, "opencode.json")}:$:invalid`,
            `${path.join(project, "opencode.json")}:$:invalid`,
            `${malformed}:$:invalid`,
            "https://invalid.example.com:$:invalid",
            "OPENCODE_CONFIG_CONTENT:$:invalid",
          ].toSorted(),
        )
        expect(JSON.stringify(output)).not.toContain("secret")
      }),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  test("migrates arbitrary v1 configuration into valid v2 configuration", () => {
    const json = Schema.fromJsonString(Schema.toCodecJson(ConfigV1.Info))
    const result = Effect.runSync(
      Arbitrary.checkEffect(
        Arbitrary.schema(ConfigV1.Info),
        (info) => {
          migrateV1(JSON.parse(Schema.encodeUnknownSync(json)(info)))
          return true
        },
        { runs: 100 },
      ),
    )
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
  }, 30_000)

  // Effect leaves decoded key order unspecified, but these maps' order is user-visible: agents cycle
  // in this order, the first matching formatter wins, and providers fold aliases in sequence.
  test("decodes configuration maps in source order", () => {
    const keys = ["zeta", "build", "alpha", "plan", "mid"]
    const map = <A>(value: A) => Object.fromEntries(keys.map((key) => [key, value]))
    const info = Schema.decodeUnknownSync(Info)(
      migrateV1({
        agents: map({}),
        formatter: map({ command: ["fmt"], extensions: [".ts"] }),
        providers: map({}),
        commands: map({ template: "run" }),
      }),
      { errors: "all", onExcessProperty: "ignore" },
    )
    expect(Object.keys(info.agents ?? {})).toEqual(keys)
    expect(Object.keys(typeof info.formatter === "object" ? info.formatter : {})).toEqual(keys)
    expect(Object.keys(info.providers ?? {})).toEqual(keys)
    expect(Object.keys(info.commands ?? {})).toEqual(keys)
  })

  test("decodes v1 permissions in source order at every level", () => {
    const decode = Schema.decodeUnknownSync(ConfigPermissionV1.Info)
    expect(decode({ "*": "allow", custom: "deny", bash: { "git *": "ask", "*": "deny" }, edit: "deny" })).toEqual([
      ["*", "allow"],
      ["custom", "deny"],
      [
        "bash",
        [
          ["git *", "ask"],
          ["*", "deny"],
        ],
      ],
      ["edit", "deny"],
    ])
    expect(decode("ask")).toEqual([["*", "ask"]])
    for (const invalid of [["allow"], { bash: ["allow"] }, { question: { "*": "allow" } }, { read: null }])
      expect(() => decode(invalid)).toThrow()
  })

  test("migrates the v1 experimental subagent depth", () => {
    expect(migrateV1({ experimental: { subagent_depth: 2 } }).experimental?.subagent_depth).toBe(2)
  })

  test("migrates the v1 update policy", () => {
    expect(migrateV1({ autoupdate: false }).update).toBe("disable")
    expect(migrateV1({ autoupdate: "notify" }).update).toBe("notify")
    expect(migrateV1({ autoupdate: true }).update).toBe("auto")
    expect(migrateV1({}).update).toBeUndefined()
  })

  test("normalizes the native auto update policy", () => {
    expect(ConfigNormalize.normalize({ update: "auto" })).toEqual({
      type: "normalized",
      encoded: { update: "auto" },
      diagnostics: [],
    })
  })

  test("migrates v1 provider lists to policies", () => {
    expect(
      migrateV1({
        enabled_providers: ["anthropic", "openai"],
        disabled_providers: ["openai"],
      }).policies,
    ).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "anthropic", effect: "allow" },
      { action: "provider.use", resource: "openai", effect: "allow" },
      { action: "provider.use", resource: "openai", effect: "deny" },
    ])
    expect(migrateV1({ enabled_providers: [] }).policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
    ])
  })

  test("migrates v1 provider setup options into AISDK settings", () => {
    const migrated = migrateV1({
      provider: {
        bedrock: {
          npm: "@ai-sdk/amazon-bedrock",
          models: { claude: { provider: { npm: "@ai-sdk/anthropic" } } },
          options: {
            headers: { "x-test": "1" },
            body: { trace: true },
            region: "us-east-1",
            profile: "dev",
          },
        },
      },
    })

    expect(migrated.providers?.bedrock).toMatchObject({
      package: Provider.aisdk("@ai-sdk/amazon-bedrock"),
      models: { claude: { package: Provider.aisdk("@ai-sdk/anthropic") } },
      settings: { region: "us-east-1", profile: "dev" },
      headers: { "x-test": "1" },
      body: { trace: true },
    })
  })

  test("renames old provider IDs while migrating v1 configuration", () => {
    const migrated = migrateV1({
      model: "azure-cognitive-services/deployment",
      enabled_providers: ["google-vertex-anthropic"],
      disabled_providers: ["azure-cognitive-services"],
      agent: {
        reviewer: { model: "google-vertex-anthropic/claude-sonnet" },
      },
      command: {
        review: { template: "Review", model: "azure-cognitive-services/deployment" },
      },
      provider: {
        "azure-cognitive-services": {
          npm: "@ai-sdk/azure",
          env: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
          models: { deployment: {} },
        },
        "google-vertex-anthropic": {
          npm: "@ai-sdk/google-vertex/anthropic",
          options: { project: "test-project", location: "us-central1" },
          models: { "claude-sonnet": {} },
        },
      },
    })

    expect(migrated.model).toEqual({ providerID: "azure", model: "deployment" })
    expect(migrated.agents?.reviewer?.model).toEqual({ providerID: "google-vertex", model: "claude-sonnet" })
    expect(migrated.commands?.review?.model).toEqual({ providerID: "azure", model: "deployment" })
    expect(migrated.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "google-vertex", effect: "allow" },
      { action: "provider.use", resource: "azure", effect: "deny" },
    ])
    expect(migrated.providers?.azure).toMatchObject({
      env: ["AZURE_COGNITIVE_SERVICES_API_KEY"],
      package: Provider.aisdk("@ai-sdk/azure"),
      models: { deployment: {} },
    })
    expect(migrated.providers?.["azure-cognitive-services"]).toBeUndefined()
    expect(migrated.providers?.["google-vertex"]).toMatchObject({
      settings: { project: "test-project", location: "us-central1" },
      models: {
        "claude-sonnet": { package: Provider.aisdk("@ai-sdk/google-vertex/anthropic") },
      },
    })
    expect(migrated.providers?.["google-vertex"]).not.toHaveProperty("package")
    expect(migrated.providers?.["google-vertex-anthropic"]).toBeUndefined()
  })

  test("preserves the generated base URL for v1 Azure OpenAI-compatible providers", () => {
    const migrated = migrateV1({
      provider: {
        "azure-cognitive-services": {
          npm: "@ai-sdk/openai-compatible",
          env: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
        },
      },
    })

    expect(migrated.providers?.azure).toMatchObject({
      env: ["AZURE_COGNITIVE_SERVICES_API_KEY"],
      package: Provider.aisdk("@ai-sdk/openai-compatible"),
      settings: {
        baseURL: "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai",
      },
    })
  })

  test("ignores old provider IDs when the current provider ID is configured", () => {
    const migrated = migrateV1({
      provider: {
        azure: { models: { current: {} } },
        "azure-cognitive-services": { models: { legacy: {} } },
        "google-vertex": { models: { gemini: {} } },
        "google-vertex-anthropic": { models: { claude: {} } },
      },
    })

    expect(migrated.providers?.azure?.models).toEqual({ current: expect.anything() })
    expect(migrated.providers?.["google-vertex"]?.models).toEqual({ gemini: expect.anything() })
  })

  test("preserves the built-in package for v1 Vertex Anthropic custom models", () => {
    const migrated = migrateV1({
      provider: {
        "google-vertex-anthropic": {
          models: { claude: {} },
        },
      },
    })

    expect(migrated.providers?.["google-vertex"]?.package).toBeUndefined()
    expect(migrated.providers?.["google-vertex"]?.models?.claude?.package).toBe(
      Provider.aisdk("@ai-sdk/google-vertex/anthropic"),
    )
  })

  test("migrates v1 interleaved fields to compatibility", () => {
    const migrated = migrateV1({
      provider: {
        custom: {
          models: {
            object: { interleaved: { field: "vendor_reasoning" } },
            string: { interleaved: "reasoning_text" },
            boolean: { interleaved: true },
          },
        },
      },
    })

    expect(migrated.providers?.custom?.models?.object?.compatibility).toEqual({
      reasoningField: "vendor_reasoning",
    })
    expect(migrated.providers?.custom?.models?.string?.compatibility).toEqual({ reasoningField: "reasoning_text" })
    expect(migrated.providers?.custom?.models?.boolean?.compatibility).toBeUndefined()
  })

  for (const subtask of [true, false]) {
    test(`migrates v1 command configuration with subtask: ${subtask}`, () => {
      expect(
        migrateV1({
          command: {
            review: {
              template: "Review changes",
              description: "Review code",
              agent: "reviewer",
              model: "anthropic/claude",
              variant: "high",
              subtask,
            },
          },
        }).commands,
      ).toEqual({
        review: {
          template: "Review changes",
          description: "Review code",
          agent: "reviewer",
          model: { providerID: "anthropic", model: "claude", variant: "high" },
          subagent: subtask,
        },
      })
    })
  }

  test("normalizes renamed permission actions when migrating v1 permissions", () => {
    expect(
      migrateV1({
        permission: {
          task: "ask",
          bash: { "git status": "allow", "*": "deny" },
          write: "deny",
          apply_patch: "deny",
          read: "allow",
        },
      }).permissions,
    ).toEqual([
      { action: "subagent", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])
  })

  it.live("returns an empty configuration when directory files do not exist", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = (yield* config.entries()).filter((entry) => !entry.path || inFixture(tmp.path, entry.path))

          expect(entries).toEqual([
            new Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("deduplicates global ecosystem directories found during upward discovery", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const home = path.join(global, "home")
          const project = path.join(home, "project")
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(home, ".claude"), { recursive: true }),
              fs.mkdir(path.join(home, ".agents"), { recursive: true }),
              fs.mkdir(project, { recursive: true }),
            ]),
          )
          const compatibility = yield* Config.Service.use((config) => config.compatibility!()).pipe(
            Effect.provide(testLayer(project, global)),
          )

          expect(compatibility.claude).toEqual([AbsolutePath.make(path.join(home, ".claude"))])
          expect(compatibility.agents).toEqual([AbsolutePath.make(path.join(home, ".agents"))])
        }),
      ),
    ),
  )

  it.live("does not recursively watch ecosystem config roots", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(tmp.path, ".claude", "skills"), { recursive: true }),
              fs.mkdir(path.join(tmp.path, ".agents"), { recursive: true }),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            yield* config.entries()

            expect((yield* watcher.subscriptions()).filter((item) => inFixture(tmp.path, item.path))).toEqual([
              {
                type: "directory",
                path: AbsolutePath.make(path.join(tmp.path, "global")),
                ignore: FSUtil.ignoreGlobs.toSorted(),
              },
              {
                type: "entries",
                path: tmp.path,
                names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"],
              },
            ])
          }).pipe(Effect.provide(testLayer(tmp.path, undefined, undefined, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  it.live("loads opencode JSON and JSONC files from lowest to highest priority", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(tmp.path, "opencode.json"),
                JSON.stringify({ $schema: "base", providers: { base: provider } }),
              ),
              fs.writeFile(
                path.join(tmp.path, "opencode.jsonc"),
                `{
                  // Later global files override scalar fields while retaining providers.
                  "$schema": "last",
                  "providers": { "last": ${JSON.stringify(provider)} },
                }`,
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(2)
            expect(documents.map((document) => document.type)).toEqual(["document", "document"])
            expect(documents.map((document) => document.info.$schema)).toEqual(["base", "last"])
            expect(documents[0]).toBeInstanceOf(Document)
            expect(documents[0]?.path).toBe(AbsolutePath.make(path.join(tmp.path, "opencode.json")))
            expect(documents[1]?.info.providers?.last).toBeInstanceOf(ConfigProvider.Info)

            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "opencode.jsonc"), JSON.stringify({ $schema: "changed" })),
            )
            expect(
              (yield* config.entries())
                .filter((entry) => entry.type === "document")
                .map((document) => document.info.$schema),
            ).toEqual(["base", "last"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("substitutes environment variables and relative file contents", () =>
    withEnv(
      {
        OPENCODE_TEST_FLAG: "false",
        OPENCODE_TEST_MCP_TOKEN: String.raw`C:\Users\new\"secret"`,
        OPENCODE_TEST_MISSING: undefined,
      },
      () =>
        withTempDir((tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(path.join(tmp.path, "token.txt"), 'file\n"token"\n'),
                fs.writeFile(
                  path.join(tmp.path, "opencode.jsonc"),
                  `{
                      // Ignored reference: {file:.}
                      "username": "user-{env:OPENCODE_TEST_MISSING}",
                      "snapshots": {env:OPENCODE_TEST_FLAG},
                      "mcp": {
                        "servers": {
                          "remote": {
                            "type": "remote",
                            "url": "https://example.com/mcp",
                            "headers": {
                              "Authorization": "Bearer {env:OPENCODE_TEST_MCP_TOKEN}",
                              "X-Token": "{file:token.txt}",
                              "X-Missing": "Bearer {file:~/.opencode-test-missing/key}",
                              "X-Folder": "{file:.}"
                            }
                          }
                        }
                      }
                    }`,
                ),
              ]),
            )

            return yield* Effect.gen(function* () {
              const config = yield* Config.Service
              const document = (yield* config.entries()).find((entry) => entry.type === "document")
              expect(document?.info.username).toBe("user-")
              expect(document?.info.snapshots).toBe(false)
              const remote = document?.info.mcp?.servers?.remote
              expect(remote?.type).toBe("remote")
              if (remote?.type !== "remote") return
              expect(remote.headers).toEqual({
                Authorization: String.raw`Bearer C:\Users\new\"secret"`,
                "X-Token": 'file\n"token"',
                "X-Missing": "Bearer ",
                "X-Folder": "",
              })
            }).pipe(Effect.provide(testLayer(tmp.path)))
          }),
        ),
    ),
  )

  it.effect("keeps env values unescaped when the config already parses", () =>
    Effect.gen(function* () {
      const text = yield* ConfigVariable.substitute({
        type: "virtual",
        source: "test",
        dir: "/",
        text: '{ "quoted": "{env:QUOTED}", "fragment": {env:FRAGMENT} }',
        env: { QUOTED: String.raw`a\"b`, FRAGMENT: '{"k":"v"}' },
      })
      expect(JSON.parse(text)).toEqual({ quoted: 'a"b', fragment: { k: "v" } })
    }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node))),
  )

  it.live("does not load legacy config.json files", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ $schema: "legacy" })),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("accepts $schema metadata without writing it into config files", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const contents = JSON.stringify({
            shell: "/bin/zsh",
            providers: { local: provider },
          })
          yield* Effect.promise(() => fs.writeFile(file, contents))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.$schema).toBeUndefined()
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(contents)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads supported scalar and resource configuration", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                shell: "/bin/bash",
                model: "anthropic/claude",
                default_agent: "reviewer",
                update: "notify",
                share: "disabled",
                enterprise: { url: "https://share.example.com" },
                username: "test-user",
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "bash", resource: "git status", effect: "allow" },
                ],
                agents: {
                  reviewer: {
                    model: "openrouter/openai/gpt-5#high",
                    request: {
                      headers: { "x-agent": "reviewer" },
                      body: { reasoningEffort: "high" },
                    },
                    description: "Review changes for correctness",
                    system: "Find regressions.",
                    mode: "subagent",
                    hidden: false,
                    color: "#ff6b6b",
                    steps: 12,
                    disabled: false,
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                  },
                },
                snapshots: false,
                watcher: { ignore: ["node_modules/**", "dist/**", ".git"] },
                formatter: {
                  prettier: { disabled: true },
                  custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
                },
                lsp: { typescript: { disabled: true }, custom: { command: ["custom-lsp"], extensions: [".foo"] } },
                media: {
                  image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
                },
                tool_output: { max_lines: 1000, max_bytes: 32768 },
                mcp: {
                  timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
                  servers: {
                    local: {
                      type: "local",
                      command: ["node", "./mcp/server.js"],
                      environment: { API_KEY: "secret" },
                      disabled: false,
                      codemode: false,
                      timeout: { catalog: 10000 },
                      protocol: "legacy",
                    },
                    remote: {
                      type: "remote",
                      url: "https://mcp.example.com/mcp",
                      headers: { Authorization: "Bearer token" },
                      oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                      disabled: true,
                      codemode: false,
                      timeout: { startup: 15000 },
                      protocol: "2026-07-28",
                    },
                  },
                },
                compaction: {
                  auto: true,
                  prune: false,
                  keep: { tokens: 2000 },
                  buffer: 10000,
                },
                skills: ["./skills", "~/shared-skills", "https://example.com/.well-known/skills/"],
                instructions: ["CONTRIBUTING.md", ".cursor/rules/*.md", "https://example.com/shared-rules.md"],
                references: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.shell).toBe("/bin/bash")
            expect(documents[0]?.info.model).toEqual(selection("anthropic/claude"))
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.update).toBe("notify")
            expect(documents[0]?.info.share).toBe("disabled")
            expect(documents[0]?.info.enterprise).toEqual({ url: "https://share.example.com" })
            expect(documents[0]?.info.username).toBe("test-user")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "bash", resource: "git status", effect: "allow" },
            ])
            const reviewer = documents[0]?.info.agents?.reviewer
            expect(reviewer?.model).toEqual(selection("openrouter/openai/gpt-5#high"))
            expect(reviewer?.request).toEqual({
              headers: { "x-agent": "reviewer" },
              body: { reasoningEffort: "high" },
            })
            expect(reviewer?.description).toBe("Review changes for correctness")
            expect(reviewer?.system).toBe("Find regressions.")
            expect(reviewer?.mode).toBe("subagent")
            expect(reviewer?.hidden).toBe(false)
            expect(reviewer?.color).toBe("#ff6b6b")
            expect(reviewer?.steps).toBe(12)
            expect(reviewer?.disabled).toBe(false)
            expect(reviewer?.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.watcher).toEqual({ ignore: ["node_modules/**", "dist/**", ".git"] })
            expect(documents[0]?.info.formatter).toEqual({
              prettier: { disabled: true },
              custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.lsp).toEqual({
              typescript: { disabled: true },
              custom: { command: ["custom-lsp"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.media).toEqual({
              image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
            })
            expect(documents[0]?.info.tool_output).toEqual({ max_lines: 1000, max_bytes: 32768 })
            expect(documents[0]?.info.mcp).toEqual({
              timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "./mcp/server.js"],
                  environment: { API_KEY: "secret" },
                  disabled: false,
                  codemode: false,
                  timeout: { catalog: 10000 },
                  protocol: "legacy",
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com/mcp",
                  headers: { Authorization: "Bearer token" },
                  oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                  disabled: true,
                  codemode: false,
                  timeout: { startup: 15000 },
                  protocol: "2026-07-28",
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.skills).toEqual([
              "./skills",
              "~/shared-skills",
              "https://example.com/.well-known/skills/",
            ])
            expect(documents[0]?.info.instructions).toEqual([
              "CONTRIBUTING.md",
              ".cursor/rules/*.md",
              "https://example.com/shared-rules.md",
            ])
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates the deprecated reference key into references", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                reference: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates v1 configuration when a v1-only key is present", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                shell: "/bin/zsh",
                default_agent: "reviewer",
                autoupdate: false,
                snapshot: false,
                autoshare: true,
                permission: {
                  bash: "ask",
                  edit: { "*.md": "allow", "*": "deny" },
                  question: "deny",
                  webfetch: { "*": "ask", "https://en.wikipedia.org/*": "allow" },
                },
                agent: {
                  reviewer: {
                    prompt: "Review changes.",
                    disable: true,
                    temperature: 0.2,
                    permission: { read: "allow" },
                  },
                },
                skills: { paths: ["./skills"], urls: ["https://example.com/.well-known/skills/"] },
                references: {
                  docs: { path: "../docs", description: "Use for product documentation", hidden: true },
                },
                attachment: { image: { auto_resize: false, max_width: 1200 } },
                provider: {
                  custom: {
                    options: { apiKey: "secret" },
                    models: {
                      model: {
                        options: { reasoningEffort: "high" },
                        variants: { fast: { temperature: 0.2 } },
                      },
                    },
                  },
                  openai: {
                    npm: "@ai-sdk/openai",
                    options: { apiKey: "secret", organization: "org" },
                    models: {
                      model: {
                        options: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                        variants: { high: { reasoningEffort: "high", reasoningSummary: "auto" } },
                      },
                    },
                  },
                  anthropic: {
                    npm: "@ai-sdk/anthropic",
                    models: {
                      model: {
                        options: {
                          effort: "high",
                          taskBudget: 4096,
                          metadata: { userId: "user-1" },
                        },
                      },
                    },
                  },
                  litellm: {
                    npm: "@ai-sdk/openai-compatible",
                    options: { baseURL: "https://litellm.example/v1" },
                    models: {
                      "glm-5.3-flashx": {
                        options: { reasoningEffort: "high", allowed_openai_params: ["reasoning_effort"] },
                        variants: { thinking: { chat_template_kwargs: { enable_thinking: true } } },
                      },
                    },
                  },
                },
                compaction: { auto: true, tail_turns: 3, preserve_recent_tokens: 2000, reserved: 10000 },
                experimental: { mcp_timeout: 5000 },
                mcp: {
                  local: { type: "local", command: ["node", "server.js"], enabled: false, timeout: 10000 },
                  remote: {
                    type: "remote",
                    url: "https://mcp.example.com",
                    oauth: { clientId: "client", callbackPort: 19876 },
                    timeout: 20000,
                  },
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info).toBeInstanceOf(Info)
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.update).toBe("disable")
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.share).toBe("auto")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "shell", resource: "*", effect: "ask" },
              { action: "edit", resource: "*.md", effect: "allow" },
              { action: "edit", resource: "*", effect: "deny" },
              { action: "question", resource: "*", effect: "deny" },
              { action: "webfetch", resource: "*", effect: "ask" },
              { action: "webfetch", resource: "https://en.wikipedia.org/*", effect: "allow" },
            ])
            expect(documents[0]?.info.agents?.reviewer).toMatchObject({
              system: "Review changes.",
              disabled: true,
              request: { body: { temperature: 0.2 } },
              permissions: [{ action: "read", resource: "*", effect: "allow" }],
            })
            expect(documents[0]?.info.skills).toEqual(["./skills", "https://example.com/.well-known/skills/"])
            expect(documents[0]?.info.references).toEqual({
              docs: { path: "../docs", description: "Use for product documentation", hidden: true },
            })
            expect(documents[0]?.info.media).toEqual({ image: { auto_resize: false, max_width: 1200 } })
            expect(documents[0]?.info.providers?.custom).toMatchObject({
              settings: { apiKey: "secret" },
              models: {
                model: {
                  settings: { reasoningEffort: "high" },
                  variants: [{ id: "fast", settings: { temperature: 0.2 } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.openai).toMatchObject({
              package: Provider.aisdk("@ai-sdk/openai"),
              settings: { apiKey: "secret", organization: "org" },
              models: {
                model: {
                  settings: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                  variants: [{ id: "high", settings: { reasoningEffort: "high", reasoningSummary: "auto" } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.anthropic).toMatchObject({
              package: Provider.aisdk("@ai-sdk/anthropic"),
              models: {
                model: {
                  settings: {
                    effort: "high",
                    taskBudget: 4096,
                    metadata: { userId: "user-1" },
                  },
                },
              },
            })
            expect(documents[0]?.info.providers?.litellm?.models?.["glm-5.3-flashx"]).toMatchObject({
              settings: { reasoningEffort: "high" },
              body: { allowed_openai_params: ["reasoning_effort"] },
              variants: [{ id: "thinking", settings: {}, body: { chat_template_kwargs: { enable_thinking: true } } }],
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.mcp).toMatchObject({
              timeout: { catalog: 5000, execution: 5000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "server.js"],
                  disabled: true,
                  timeout: { startup: 10000, catalog: 10000, execution: 10000 },
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com",
                  oauth: { client_id: "client", callback_port: 19876 },
                  timeout: { startup: 20000, catalog: 20000, execution: 20000 },
                },
              },
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("ignores an invalid file while loading valid config values", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ $schema: "base" })),
              fs.writeFile(path.join(tmp.path, "opencode.jsonc"), "{ invalid"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents.map((document) => document.info.$schema)).toEqual(["base"])
            expect(yield* watcher.subscriptions()).toContainEqual({
              path: tmp.path,
              type: "entries",
              names: [".agents", ".claude", ".opencode", "opencode.json", "opencode.jsonc"],
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads global and ancestor configuration across the project boundary", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        const globalAgents = path.join(global, "home", ".agents")
        const globalClaude = path.join(global, "home", ".claude")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(globalAgents, { recursive: true })
            await fs.mkdir(globalClaude, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".agents"), { recursive: true })
            await fs.mkdir(path.join(root, ".claude"), { recursive: true })
            await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
            await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
            await fs.mkdir(path.join(directory, ".claude"), { recursive: true })
            await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ $schema: "outside" })),
              fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(parent, "opencode.jsonc"), JSON.stringify({ $schema: "parent" })),
              fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify({ $schema: "directory" })),
              fs.writeFile(path.join(root, ".opencode", "opencode.json"), JSON.stringify({ $schema: "root-dot" })),
              fs.writeFile(
                path.join(directory, ".opencode", "opencode.jsonc"),
                JSON.stringify({ $schema: "directory-dot" }),
              ),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = (yield* config.entries()).filter((entry) => !entry.path || inFixture(tmp.path, entry.path))
            const documents = entries.filter((entry) => entry.type === "document")
            const compatibility = yield* config.compatibility!()

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".opencode")),
              AbsolutePath.make(path.join(directory, ".opencode")),
            ])
            expect(compatibility.agents.filter((path) => inFixture(tmp.path, path))).toEqual([
              AbsolutePath.make(globalAgents),
              AbsolutePath.make(path.join(root, ".agents")),
              AbsolutePath.make(path.join(directory, ".agents")),
            ])
            expect(compatibility.claude.filter((path) => inFixture(tmp.path, path))).toEqual([
              AbsolutePath.make(globalClaude),
              AbsolutePath.make(path.join(root, ".claude")),
              AbsolutePath.make(path.join(directory, ".claude")),
            ])
            expect(documents.map((document) => document.info.$schema)).toEqual([
              "global",
              "outside",
              "root",
              "parent",
              "directory",
              "root-dot",
              "directory-dot",
            ])
            expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
              "global",
              AbsolutePath.make(global),
              "outside",
              "root",
              "parent",
              "directory",
              "root-dot",
              AbsolutePath.make(path.join(root, ".opencode")),
              "directory-dot",
              AbsolutePath.make(path.join(directory, ".opencode")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                type: "git",
                store: AbsolutePath.make(path.join(root, ".git")),
              }),
            ),
          )
        })
      }),
    ),
  )

  // --- S1: atomic commit and publication ---------------------------------------

  it.live("commits the candidate through one same-directory temp file and one exact rename", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  // keep this comment\n  "username": "kept",\n  "shell": "/bin/zsh"\n}\n'
          yield* seedConfig(project, global, file, initial, 0o600)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            yield* config.update({ fallback: selectedFallback })
            const saved = yield* readConfig(file)
            expect(injection.calls.writes.length).toBe(1)
            const temp = injection.calls.writes[0]!.path
            expect(temp).not.toBe(file)
            expect(path.dirname(temp)).toBe(global)
            expect(path.basename(temp).startsWith(".")).toBe(true)
            expect(path.basename(temp).endsWith(".tmp")).toBe(true)
            expect(injection.calls.renames).toEqual([[temp, file]])
            // Cleanup of the temp path is attempted even though the rename consumed it.
            expect(injection.calls.removes).toEqual([temp])
            // What landed in the temp file is byte-for-byte what the rename committed.
            expect(injection.calls.writes[0]!.content).toBe(saved)
            expect(saved).toContain("keep this comment")
            expect(saved).toContain('"username": "kept"')
            expect(saved).toContain('"shell": "/bin/zsh"')
            expect(saved).toContain('"fallback": {')
            expect(saved).toContain('"model": "gpt-test"')
            expect(injection.calls.chmods.length).toBe(1)
            expect(injection.calls.chmods[0]!.path).toBe(temp)
            expect(injection.calls.chmods[0]!.mode & 0o777).toBe(0o600)
            expect(yield* configMode(file)).toBe(0o600)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject(selectedFallback)
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("rejects a candidate whose recognized field is invalid before touching disk", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  // keep this comment\n  "username": "kept",\n  "mcp": 42\n}\n'
          yield* seedConfig(project, global, file, initial, 0o600)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const before = yield* config.entries()
            const error = yield* config.update({ shell: "/bin/bash", fallback: selectedFallback }).pipe(Effect.flip)
            expect(error._tag).toBe("Config.CandidateRejected")
            // Nothing was staged: no temp write, no rename, no cleanup.
            expect(injection.calls.writes.length).toBe(0)
            expect(injection.calls.renames.length).toBe(0)
            expect(injection.calls.removes.length).toBe(0)
            expect(yield* readConfig(file)).toBe(initial)
            expect(yield* configMode(file)).toBe(0o600)
            const after = yield* config.entries()
            expect(after).toEqual(before)
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("rejects malformed JSONC and a non-object root without writing", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* Effect.promise(async () => {
            await fs.mkdir(project, { recursive: true })
            await fs.mkdir(global)
            await fs.writeFile(file, '{\n  "username": "kept",\n  "shell": \n}\n')
          })
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const malformed = yield* config.update({ shell: "/bin/bash" }).pipe(Effect.flip)
            expect(malformed._tag).toBe("Config.CandidateRejected")
            expect(injection.calls.writes.length).toBe(0)
            expect(injection.calls.renames.length).toBe(0)
            yield* Effect.promise(() => fs.writeFile(file, "[1, 2]\n"))
            // A non-object root cannot even take a sparse edit, so the editing step fails
            // before validation: still a precommit failure with the old bytes intact.
            const root = yield* config.update({ shell: "/bin/bash" }).pipe(Effect.flip)
            expect(root._tag).toBe("FileSystemError")
            expect(injection.calls.writes.length).toBe(0)
            expect(injection.calls.renames.length).toBe(0)
            expect(yield* readConfig(file)).toBe("[1, 2]\n")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("keeps legacy unsupported and precedence-conflict diagnostics non-fatal", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial =
            '{\n  "username": "kept",\n  "logLevel": "INFO",\n  "compaction": { "reserved": 1000, "buffer": 2000 }\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            yield* config.update({ shell: "/bin/zsh" })
            const saved = yield* readConfig(file)
            expect(saved).toContain('"logLevel": "INFO"')
            expect(saved).toContain('"reserved": 1000')
            expect(saved).toContain('"buffer": 2000')
            expect(saved).toContain('"username": "kept"')
            expect(saved).toContain('"shell": "/bin/zsh"')
            expect(injection.calls.renames.length).toBe(1)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "shell")).toBe("/bin/zsh")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("keeps old bytes, mode and readers when the temp write fails, then recovers", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept",\n  "shell": "/bin/zsh"\n}\n'
          yield* seedConfig(project, global, file, initial, 0o600)
          const injection = filesystemInjection()
          injection.faults.write = true
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const error = yield* config.update({ shell: "/bin/bash", fallback: selectedFallback }).pipe(Effect.flip)
            expect(error._tag).toBe("FileSystemError")
            // The injected boundary was reached: one temp write was attempted.
            expect(injection.calls.writes.length).toBe(1)
            expect(path.basename(injection.calls.writes[0]!.path).endsWith(".tmp")).toBe(true)
            expect(injection.calls.renames.length).toBe(0)
            expect(injection.calls.removes).toEqual([injection.calls.writes[0]!.path])
            expect(yield* readConfig(file)).toBe(initial)
            expect(yield* configMode(file)).toBe(0o600)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "shell")).toBe("/bin/zsh")
            expect(Config.latest(entries, "fallback")).toBeUndefined()
            injection.faults.write = false
            yield* config.update({ shell: "/bin/bash" })
            expect(yield* readConfig(file)).toContain('"shell": "/bin/bash"')
            const recovered = yield* config.entries()
            expect(Config.latest(recovered, "shell")).toBe("/bin/bash")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("keeps old bytes, mode and readers when the rename fails, then recovers", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept",\n  "shell": "/bin/zsh"\n}\n'
          yield* seedConfig(project, global, file, initial, 0o600)
          const injection = filesystemInjection()
          injection.faults.rename = true
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const error = yield* config.update({ shell: "/bin/bash", fallback: selectedFallback }).pipe(Effect.flip)
            expect(error._tag).toBe("FileSystemError")
            // Both the temp write and the rename attempt were reached.
            expect(injection.calls.writes.length).toBe(1)
            expect(injection.calls.renames).toEqual([[injection.calls.writes[0]!.path, file]])
            expect(injection.calls.removes).toEqual([injection.calls.writes[0]!.path])
            expect(yield* readConfig(file)).toBe(initial)
            expect(yield* configMode(file)).toBe(0o600)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "shell")).toBe("/bin/zsh")
            expect(Config.latest(entries, "fallback")).toBeUndefined()
            injection.faults.rename = false
            yield* config.update({ shell: "/bin/bash" })
            expect(yield* readConfig(file)).toContain('"shell": "/bin/bash"')
            const recovered = yield* config.entries()
            expect(Config.latest(recovered, "shell")).toBe("/bin/bash")
            // Only the target file remains in the directory: the temp file was cleaned.
            expect(yield* directoryEntries(global)).toEqual(["opencode.jsonc"])
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("treats an equal candidate as a no-op with no writes, renames or invalidation", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n')
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const update = config.update
            const bus = yield* Bus.Service
            let notified = 0
            const unsubscribe = yield* bus.listen((event) =>
              event.type === "config.updated"
                ? Effect.sync(() => {
                    notified += 1
                  })
                : Effect.void,
            )
            return yield* Effect.gen(function* () {
              yield* update({ shell: "/bin/zsh", fallback: selectedFallback })
              const committed = yield* readConfig(file)
              // The listener is live, so a later count of one proves real invalidation happened.
              expect(notified).toBe(1)
              expect(injection.calls.writes.length).toBe(1)
              expect(injection.calls.renames.length).toBe(1)
              yield* update({ shell: "/bin/zsh", fallback: selectedFallback })
              expect(injection.calls.writes.length).toBe(1)
              expect(injection.calls.renames.length).toBe(1)
              expect(injection.calls.removes.length).toBe(1)
              expect(notified).toBe(1)
              expect(yield* readConfig(file)).toBe(committed)
              const entries = yield* config.entries()
              expect(Config.latest(entries, "fallback")).toMatchObject(selectedFallback)
            }).pipe(Effect.onExit(() => unsubscribe))
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("commits but reports unpublished when reader refresh fails, then reconciles forward", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept",\n  "shell": "/bin/zsh"\n}\n'
          yield* seedConfig(project, global, file, initial, 0o600)
          const injection = filesystemInjection()
          // Reads fail for the committed target only after the rename has happened, so
          // the failure lands between the commit and coherent publication.
          injection.faults.read = (target) => target === file && injection.calls.renames.length > 0
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const error = yield* config.update({ shell: "/bin/bash", fallback: selectedFallback }).pipe(Effect.flip)
            expect(error._tag).toBe("Config.CommittedButUnpublished")
            expect(injection.calls.writes.length).toBe(1)
            expect(injection.calls.renames.length).toBe(1)
            expect(injection.calls.removes).toEqual([injection.calls.writes[0]!.path])
            const saved = yield* readConfig(file)
            expect(saved).toBe(injection.calls.writes[0]!.content)
            expect(saved).toContain('"model": "gpt-test"')
            expect(saved).toContain('"shell": "/bin/bash"')
            expect(yield* configMode(file)).toBe(0o600)
            // A protected read must not succeed with the pre-commit document, so while the
            // fault stands the read fails explicitly with the real cause.
            const staleRead = yield* Effect.exit(config.entries())
            expect(Exit.hasDies(staleRead)).toBe(true)
            injection.faults.read = () => false
            // The retained coherent state is only ever served after a successful refresh.
            const reconciled = yield* config.entries()
            expect(Config.latest(reconciled, "fallback")).toMatchObject(selectedFallback)
            // Nothing is stranded: a later writer still commits and publishes.
            yield* config.update({ shell: null })
            expect(yield* readConfig(file)).not.toContain('"shell":')
            const final = yield* config.entries()
            expect(Config.latest(final, "shell")).toBeUndefined()
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("refuses a matching PATCH while the commit is not visible to readers", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          // A second discovered source is faulted instead of the update target, so the
          // failure can only land in the reader refresh and never in the precommit read.
          const source = path.join(project, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n', 0o600)
          yield* Effect.promise(() => fs.writeFile(source, '{\n  "username": "project"\n}\n'))
          const injection = filesystemInjection()
          let armed = false
          injection.faults.read = (target) => armed && target === source
          injection.faults.afterRename = () =>
            Effect.sync(() => {
              armed = true
            })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const first = yield* config.update({ shell: "/bin/bash", fallback: selectedFallback }).pipe(Effect.flip)
            expect(first._tag).toBe("Config.CommittedButUnpublished")
            const committed = yield* readConfig(file)
            const writes = injection.calls.writes.length
            const renames = injection.calls.renames.length
            const removes = injection.calls.removes.length
            const faultedReads = injection.calls.reads.filter((read) => read.failed).length
            // The same PATCH matches disk bytes, but readers still cannot see that commit,
            // so it must not report success: it names the committed document unpublished
            // again, still without writing, renaming or cleaning anything.
            const second = yield* config.update({ shell: "/bin/bash", fallback: selectedFallback }).pipe(Effect.flip)
            expect(second._tag).toBe("Config.CommittedButUnpublished")
            expect(injection.calls.writes.length).toBe(writes)
            expect(injection.calls.renames.length).toBe(renames)
            expect(injection.calls.removes.length).toBe(removes)
            expect(yield* readConfig(file)).toBe(committed)
            // Reachability: the no-op path really attempted the reader refresh and failed there.
            expect(injection.calls.reads.filter((read) => read.failed).length).toBe(faultedReads + 1)
            expect(injection.calls.reads.filter((read) => read.path === file && read.failed).length).toBe(0)
            // Repair: with the source readable again the matching PATCH succeeds without writing.
            armed = false
            yield* config.update({ shell: "/bin/bash", fallback: selectedFallback })
            expect(injection.calls.writes.length).toBe(writes)
            expect(injection.calls.renames.length).toBe(renames)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject(selectedFallback)
            expect(Config.latest(entries, "username")).toBe("project")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("repairs readers on a matching PATCH after an external disk change without writing", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept",\n  "shell": "/bin/zsh"\n}\n')
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const update = config.update
            const bus = yield* Bus.Service
            let notified = 0
            const unsubscribe = yield* bus.listen((event) =>
              event.type === "config.updated"
                ? Effect.sync(() => {
                    notified += 1
                  })
                : Effect.void,
            )
            return yield* Effect.gen(function* () {
              expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/zsh")
              // The file changes on disk with no watch event, so core readers are stale.
              yield* Effect.promise(() => fs.writeFile(file, '{\n  "username": "kept",\n  "shell": "/bin/bash"\n}\n'))
              expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/zsh")
              // A PATCH matching disk must not write or rename, yet it must leave readers coherent.
              yield* update({ shell: "/bin/bash" })
              expect(injection.calls.writes.length).toBe(0)
              expect(injection.calls.renames.length).toBe(0)
              expect(notified).toBe(1)
              expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/bash")
              // A further matching PATCH is inert: no writes, renames or invalidation.
              yield* update({ shell: "/bin/bash" })
              expect(injection.calls.writes.length).toBe(0)
              expect(injection.calls.renames.length).toBe(0)
              expect(notified).toBe(1)
              expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/bash")
            }).pipe(Effect.onExit(() => unsubscribe))
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("reports the reconciliation failure itself for a matching PATCH after an unrelated edit", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const source = path.join(project, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n', 0o600)
          yield* Effect.promise(() => fs.writeFile(source, '{\n  "username": "project"\n}\n'))
          const injection = filesystemInjection()
          let armed = false
          injection.faults.read = (target) => armed && target === source
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const update = config.update
            expect(Config.latest(yield* config.entries(), "shell")).toBeUndefined()
            // An unrelated durable edit lands on disk with no watch event, so this writer makes
            // no commit of its own.
            yield* Effect.promise(() => fs.writeFile(file, '{\n  "username": "kept",\n  "shell": "/bin/bash"\n}\n'))
            armed = true
            const exit = yield* Effect.exit(update({ shell: "/bin/bash" }))
            // The matching PATCH may not claim success, and with no commit to attribute it
            // may not invent a committed-state identity either: the reconciliation failure
            // surfaces with its own cause and an empty error channel.
            expect(Exit.isFailure(exit)).toBe(true)
            expect(Exit.hasInterrupts(exit)).toBe(false)
            expect(Exit.hasDies(exit)).toBe(true)
            expect(Option.isNone(Exit.findErrorOption(exit))).toBe(true)
            expect(injection.calls.writes.length).toBe(0)
            expect(injection.calls.renames.length).toBe(0)
            expect(injection.calls.removes.length).toBe(0)
            expect(yield* readConfig(file)).toBe('{\n  "username": "kept",\n  "shell": "/bin/bash"\n}\n')
            // The stalled reconciliation stays armed, so a protected read cannot silently
            // succeed with the pre-edit document either.
            expect(Exit.hasDies(yield* Effect.exit(config.entries()))).toBe(true)
            // Recovery: once the source is readable the read reconciles, and the same PATCH is
            // then a clean success that still writes and renames nothing.
            armed = false
            expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/bash")
            yield* update({ shell: "/bin/bash" })
            expect(injection.calls.writes.length).toBe(0)
            expect(injection.calls.renames.length).toBe(0)
            expect(yield* configMode(file)).toBe(0o600)
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("propagates an aborted announcement for a matching PATCH that committed nothing", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n', 0o600)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const update = config.update
            const bus = yield* Bus.Service
            let attempted = 0
            let notified = 0
            const aborting = yield* bus.listen((event) =>
              event.type === "config.updated"
                ? Effect.sync(() => {
                    attempted += 1
                  }).pipe(Effect.andThen(Effect.die(new Error("injected announcement failure"))))
                : Effect.void,
            )
            const counting = yield* bus.listen((event) =>
              event.type === "config.updated"
                ? Effect.sync(() => {
                    notified += 1
                  })
                : Effect.void,
            )
            return yield* Effect.gen(function* () {
              // An unrelated durable edit followed by a PATCH that matches disk: this writer commits
              // nothing, so an aborted announcement must not borrow its committed-state identity.
              yield* Effect.promise(() =>
                fs.writeFile(file, '{\n  "username": "kept",\n  "shell": "/bin/bash"\n}\n'),
              )
              const exit = yield* Effect.exit(update({ shell: "/bin/bash" }))
              expect(Exit.isFailure(exit)).toBe(true)
              expect(Exit.hasDies(exit)).toBe(true)
              expect(Exit.hasInterrupts(exit)).toBe(false)
              expect(Option.isNone(Exit.findErrorOption(exit))).toBe(true)
              // Reachability: the announcement really ran and its delivery stayed incomplete.
              expect(attempted).toBe(1)
              expect(notified).toBe(0)
              expect(injection.calls.writes.length).toBe(0)
              expect(injection.calls.renames.length).toBe(0)
              expect(injection.calls.removes.length).toBe(0)
              expect(yield* readConfig(file)).toBe('{\n  "username": "kept",\n  "shell": "/bin/bash"\n}\n')
              expect(yield* configMode(file)).toBe(0o600)
              // The delivery stays pending, so a protected read cannot quietly succeed either.
              expect(Exit.hasDies(yield* Effect.exit(config.entries()))).toBe(true)
              expect(notified).toBe(0)
              // Recovery through the existing reader reconciliation: with delivery no longer aborted
              // the pending announcement is re-delivered exactly once and the coherent document is served.
              yield* aborting
              const entries = yield* config.entries()
              expect(notified).toBe(1)
              expect(Config.latest(entries, "shell")).toBe("/bin/bash")
              // A later matching PATCH is then a clean success that still writes and renames nothing.
              yield* update({ shell: "/bin/bash" })
              expect(injection.calls.writes.length).toBe(0)
              expect(injection.calls.renames.length).toBe(0)
              expect(notified).toBe(1)
            }).pipe(
              Effect.onExit(() => Effect.all([counting, aborting]).pipe(Effect.ignore)),
            )
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("retries a pending announcement on the next protected read instead of losing it", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const source = path.join(project, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n', 0o600)
          yield* Effect.promise(() => fs.writeFile(source, '{\n  "username": "project"\n}\n'))
          const injection = filesystemInjection()
          let armed = false
          injection.faults.read = (target) => armed && target === source
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const update = config.update
            const bus = yield* Bus.Service
            let notified = 0
            let abortAnnouncements = true
            const aborting = yield* bus.listen((event) =>
              event.type === "config.updated" && abortAnnouncements
                ? Effect.die(new Error("injected announcement failure"))
                : Effect.void,
            )
            const counting = yield* bus.listen((event) =>
              event.type === "config.updated"
                ? Effect.sync(() => {
                    notified += 1
                  })
                : Effect.void,
            )
            return yield* Effect.gen(function* () {
              armed = true
              // A real commit whose reader refresh fails: durable, not yet visible to readers.
              const error = yield* update({ shell: "/bin/bash" }).pipe(Effect.flip)
              expect(error._tag).toBe("Config.CommittedButUnpublished")
              expect(injection.calls.writes.length).toBe(1)
              expect(injection.calls.renames.length).toBe(1)
              armed = false
              // The document now reconciles, but the mandatory announcement aborts: the coherent
              // document is installed while the failure surfaces instead of being discarded.
              expect(Exit.hasDies(yield* Effect.exit(config.entries()))).toBe(true)
              expect(notified).toBe(0)
              // The delivery stays pending, so the next protected read retries it rather than
              // accepting that an ephemeral event was lost.
              expect(Exit.hasDies(yield* Effect.exit(config.entries()))).toBe(true)
              expect(notified).toBe(0)
              // Recovery: with the listener no longer aborting, the pending announcement is
              // re-delivered exactly once and the coherent committed document is served.
              abortAnnouncements = false
              const entries = yield* config.entries()
              expect(notified).toBe(1)
              expect(Config.latest(entries, "shell")).toBe("/bin/bash")
              expect(injection.calls.writes.length).toBe(1)
              expect(injection.calls.renames.length).toBe(1)
              expect(yield* configMode(file)).toBe(0o600)
              // Nothing is pending anymore, so a later read is inert.
              yield* config.entries()
              expect(notified).toBe(1)
            }).pipe(
              Effect.onExit(() => Effect.all([counting, aborting]).pipe(Effect.ignore)),
            )
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("reports committed with postpublication failure when notification aborts", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n', 0o600)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const update = config.update
            const bus = yield* Bus.Service
            const unsubscribe = yield* bus.listen((event) =>
              event.type === "config.updated"
                ? Effect.die(new Error("injected notification failure"))
                : Effect.void,
            )
            return yield* Effect.gen(function* () {
              const error = yield* update({ shell: "/bin/bash", fallback: selectedFallback }).pipe(Effect.flip)
              expect(error._tag).toBe("Config.CommittedWithPostPublicationFailure")
              expect(injection.calls.renames.length).toBe(1)
              const saved = yield* readConfig(file)
              expect(saved).toContain('"shell": "/bin/bash"')
              expect(saved).toContain('"model": "gpt-test"')
              expect(yield* configMode(file)).toBe(0o600)
              // Readers are coherent: the commit was published even though notification did not
              // complete, so a protected read must not report the pre-commit document.
              const entries = yield* config.entries()
              expect(Config.latest(entries, "fallback")).toMatchObject(selectedFallback)
              expect(injection.calls.removes).toEqual([injection.calls.writes[0]!.path])
              yield* unsubscribe
              yield* update({ shell: null })
              const final = yield* config.entries()
              expect(Config.latest(final, "shell")).toBeUndefined()
            }).pipe(
              Effect.onExit(() => unsubscribe.pipe(Effect.ignore)),
            )
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("propagates an aborted notification from an ordinary reload to its caller", () => {
    const logs: Array<{ message: string; detail: string; tag: string }> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "failed to reload config") return
      // The reload routine reports the aborting listener, so the logged cause carries it.
      const cause = (entry.message[1] as { cause?: { reasons?: Array<{ _tag?: string; defect?: unknown }> } })?.cause
      const reason = cause?.reasons?.[0]
      logs.push({
        message: entry.message[0],
        detail: reason?.defect instanceof Error ? reason.defect.message : "",
        tag: reason?._tag ?? "",
      })
    })
    return Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n')
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const watcher = yield* Watcher.Test
            const unsubscribe = yield* bus.listen((event) =>
              event.type === "config.updated"
                ? Effect.die(new Error("injected reload notification failure"))
                : Effect.void,
            )
            return yield* Effect.gen(function* () {
              yield* Effect.promise(() => fs.writeFile(file, '{\n  "username": "kept",\n  "shell": "/bin/bash"\n}\n'))
              yield* watcher.emit({ type: "update", path: file })
              yield* Effect.sleep("200 millis")
              // `reload` fails when notification aborts, so the reload routine reports the
              // failure instead of discarding it, as it did before the refactor.
              expect(logs).toHaveLength(1)
              expect(logs[0]!.message).toBe("failed to reload config")
              expect(logs[0]!.detail).toContain("injected reload notification failure")
              expect(logs[0]!.tag).toBe("Die")
              // The document itself was reloaded, so only the completion step failed.
              expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/bash")
              expect(injection.calls.writes.length).toBe(0)
              expect(injection.calls.renames.length).toBe(0)
              yield* unsubscribe
            }).pipe(Effect.onExit(() => unsubscribe.pipe(Effect.ignore)))
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("records a failed temporary cleanup as a diagnostic when nothing is stranded", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n')
          const injection = filesystemInjection()
          injection.faults.remove = true
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            yield* config.update({ shell: "/bin/bash" })
            expect(injection.calls.writes.length).toBe(1)
            expect(injection.calls.renames.length).toBe(1)
            expect(injection.calls.removes.length).toBe(1)
            const saved = yield* readConfig(file)
            expect(saved).toContain('"shell": "/bin/bash"')
            // The rename consumed the temp file, so the failed cleanup stranded nothing.
            expect(yield* directoryEntries(global)).toEqual(["opencode.jsonc"])
            const entries = yield* config.entries()
            expect(Config.latest(entries, "shell")).toBe("/bin/bash")
            injection.faults.remove = false
            yield* config.update({ shell: null })
            expect(yield* readConfig(file)).not.toContain('"shell":')
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("releases readers and locks when a writer is cancelled across the rename", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, '{\n  "username": "kept"\n}\n', 0o600)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const update = config.update
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const gate = yield* PubSub.sliding<void>(1)
                const wake = yield* PubSub.subscribe(gate)
                injection.faults.afterRename = () => PubSub.publish(gate, undefined).pipe(Effect.asVoid)
                const writer = yield* Effect.forkChild(update({ shell: "/bin/bash", fallback: selectedFallback }))
                // The gate wakes this fiber only after the real rename replaced the target.
                yield* Stream.fromSubscription(wake).pipe(Stream.take(1), Stream.runForEach(() => Effect.void))
                yield* Fiber.interrupt(writer)
                const exit = yield* Fiber.await(writer)
                expect(Exit.hasInterrupts(exit)).toBe(true)
                // Cancellation cleaned forward: the commit stands and readers hold it.
                const saved = yield* readConfig(file)
                expect(saved).toContain('"shell": "/bin/bash"')
                expect(saved).toContain('"model": "gpt-test"')
                expect(injection.calls.removes).toEqual([injection.calls.writes[0]!.path])
                const entries = yield* config.entries()
                expect(Config.latest(entries, "fallback")).toMatchObject(selectedFallback)
                return entries
              }),
            ).pipe(
              Effect.andThen(
                // The exclusive lease and the staged revision were both released.
                Effect.gen(function* () {
                  yield* update({ shell: null })
                  const final = yield* config.entries()
                  expect(Config.latest(final, "shell")).toBeUndefined()
                }),
              ),
            )
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("creates the global directory and file when none existed", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            yield* config.update({ shell: "/bin/zsh", fallback: selectedFallback })
            expect(injection.calls.writes.length).toBe(1)
            expect(path.dirname(injection.calls.writes[0]!.path)).toBe(global)
            expect(injection.calls.renames).toEqual([[injection.calls.writes[0]!.path, file]])
            const saved = yield* readConfig(file)
            expect(saved).toBe(injection.calls.writes[0]!.content)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "shell")).toBe("/bin/zsh")
            expect(Config.latest(entries, "fallback")).toMatchObject(selectedFallback)
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  // --- S2: entry-ordered durable commits, out-of-order validation, staged intent ---

  it.live("commits updates in entry order when validation finished out of order", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept"\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            const stagedModel = intent.current().pipe(
              Effect.map((snap) =>
                snap.override.type === "none" || snap.override.value === null
                  ? undefined
                  : String(snap.override.value.model),
              ),
            )
            const fileReads = () => injection.calls.reads.filter((read) => read.path === file).length
            const readsAtStart = fileReads()
            // B enters first but parks in its pre-admission read; C validates and stages first.
            const parkB = Deferred.makeUnsafe<unknown>()
            injection.armReadGate(file, parkB)
            const writerB = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-b" } }))
            yield* injection.awaitUntil(() => Effect.succeed(fileReads() >= readsAtStart + 1))
            const writerC = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-c" } }))
            yield* injection.awaitUntil(() => stagedModel.pipe(Effect.map((model) => model === "model-c")))
            const mid = yield* intent.current()
            expect(mid.override.type).toBe("some")
            if (mid.override.type === "some") expect(mid.override.value).toMatchObject({ model: "model-c" })
            // Negative proof the boundary was reached without any durable commit: the entry-first
            // writer validated nothing yet and neither writer wrote or renamed.
            expect(injection.calls.renames.length).toBe(0)
            expect(injection.calls.writes.length).toBe(0)
            expect(yield* readConfig(file)).toBe(initial)
            // B resumes; park it inside its own commit boundary (the fresh re-read of the
            // document under the exclusive lease), after arming the gate so it cannot slip past.
            const commitGate = Deferred.makeUnsafe<unknown>()
            injection.armReadGate(file, commitGate)
            yield* Deferred.succeed(parkB, undefined)
            yield* injection.awaitUntil(() => Effect.succeed(fileReads() >= readsAtStart + 2))
            // B's stale pre-admission candidate neither re-stages (its older revision loses to C)
            // nor writes: it is still inside the commit boundary.
            expect(injection.calls.writes.length).toBe(0)
            expect(yield* stagedModel).toBe("model-c")
            yield* Deferred.succeed(commitGate, undefined)
            expect(Exit.isSuccess(yield* Fiber.await(writerB))).toBe(true)
            expect(Exit.isSuccess(yield* Fiber.await(writerC))).toBe(true)
            // Durable commits happened in entry order: B's document first, then C's patch applied
            // on top of it, one write and rename each.
            expect(injection.calls.writes.length).toBe(2)
            expect(injection.calls.writes[0]!.content).toContain('"model": "model-b"')
            expect(injection.calls.writes[1]!.content).toContain('"model": "model-c"')
            expect(injection.calls.renames.length).toBe(2)
            const saved = yield* readConfig(file)
            expect(saved).toContain('"model": "model-c"')
            expect(saved).not.toContain('"model": "model-b"')
            expect(saved).toContain('"username": "kept"')
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-c" })
            // Both committed, so each cleared its own staged revision on exit.
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("publishes no staged intent when an update is cancelled during validation, and later writers progress", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept"\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            const fileReads = () => injection.calls.reads.filter((read) => read.path === file).length
            const readsAtStart = fileReads()
            const update = config.update
            yield* Effect.scoped(
              Effect.gen(function* () {
                const parkB = Deferred.makeUnsafe<unknown>()
                injection.armReadGate(file, parkB)
                const cancelled = yield* Effect.forkChild(update({ fallback: { providerID: "openai", model: "model-k" } }))
                yield* injection.awaitUntil(() => Effect.succeed(fileReads() >= readsAtStart + 1))
                // Validation was reached; staging never was: a cancelled precommit update
                // publishes no intent and writes nothing.
                expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
                const later = yield* Effect.forkChild(update({ shell: "/bin/zsh" }))
                yield* Fiber.interrupt(cancelled)
                expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true)
                // The cancelled owner retired its entry position, so the later writer progressed
                // through the entry-order boundary and committed normally.
                expect(Exit.isSuccess(yield* Fiber.await(later))).toBe(true)
                expect(injection.calls.writes.length).toBe(1)
                expect(injection.calls.renames.length).toBe(1)
                const saved = yield* readConfig(file)
                expect(saved).toContain('"shell": "/bin/zsh"')
                expect(saved).not.toContain('"fallback"')
                expect(saved).toContain('"username": "kept"')
                expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
                const entries = yield* config.entries()
                expect(Config.latest(entries, "shell")).toBe("/bin/zsh")
                expect(Config.latest(entries, "fallback")).toBeUndefined()
              }),
            )
            // A fallback update still progresses after the cancelled one.
            yield* config.update({ fallback: { providerID: "openai", model: "model-z" } })
            expect(Config.latest(yield* config.entries(), "fallback")).toMatchObject({ model: "model-z" })
            expect(injection.calls.renames.length).toBe(2)
            // Sparse survival: the shell patch committed earlier and the fallback patch committed later
            // coexist in the same document.
            const saved = yield* readConfig(file)
            expect(saved).toContain('"shell": "/bin/zsh"')
            expect(saved).toContain('"model": "model-z"')
            expect(saved).toContain('"username": "kept"')
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("publishes no staged intent for a candidate rejected by validation, then commits after the document is fixed", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          // An invalid recognized field in the on-disk document makes every candidate invalid.
          yield* seedConfig(project, global, file, '{\n  "username": "kept",\n  "mcp": 42\n}\n')
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            const error = yield* config.update({ fallback: { providerID: "openai", model: "model-rej" } }).pipe(Effect.flip)
            expect(error._tag).toBe("Config.CandidateRejected")
            // FR-006: staging follows validation, so a rejected candidate publishes no intent,
            // writes nothing, and its reserved position retired for later writers.
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
            expect(injection.calls.writes.length).toBe(0)
            expect(injection.calls.renames.length).toBe(0)
            expect(yield* readConfig(file)).toContain('"mcp": 42')
            // The reserved position did not strand anyone: after the document is fixed the next
            // update progresses, stages, commits and clears.
            yield* Effect.promise(() => fs.writeFile(file, '{\n  "username": "kept"\n}\n'))
            yield* config.update({ fallback: { providerID: "openai", model: "model-ok" } })
            expect(Config.latest(yield* config.entries(), "fallback")).toMatchObject({ model: "model-ok" })
            expect(injection.calls.renames.length).toBe(1)
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("clears the staged intent of an update that fails at its temp write, then commits a later update", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept"\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            const stagedModel = intent.current().pipe(
              Effect.map((snap) =>
                snap.override.type === "none" || snap.override.value === null
                  ? undefined
                  : String(snap.override.value.model),
              ),
            )
            injection.faults.write = (target) => target.endsWith(".tmp")
            const error = yield* config.update({ fallback: { providerID: "openai", model: "model-p" } }).pipe(Effect.flip)
            expect(error._tag).toBe("FileSystemError")
            // Precommit failure with the old bytes intact: one temp write, no rename, cleaned up.
            expect(injection.calls.writes.length).toBe(1)
            expect(injection.calls.renames.length).toBe(0)
            expect(injection.calls.removes.length).toBe(1)
            expect(yield* readConfig(file)).toBe(initial)
            // The failed update cleared the intent it had staged at validation, so recovery
            // resolves against the committed configuration (nothing committed here), not the
            // failed newer intent.
            expect(yield* stagedModel).toBeUndefined()
            injection.faults.write = false
            yield* config.update({ fallback: { providerID: "openai", model: "model-q" } })
            expect(injection.calls.renames.length).toBe(1)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-q" })
            expect(yield* stagedModel).toBeUndefined()
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("exposes the committed fallback after a newer update's commit fails", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept"\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            yield* config.update({ fallback: { providerID: "openai", model: "model-e1" } })
            injection.faults.write = (target) => target.endsWith(".tmp")
            const error = yield* config.update({ fallback: { providerID: "openai", model: "model-e2" } }).pipe(Effect.flip)
            expect(error._tag).toBe("FileSystemError")
            // The first commit stands untouched; the newer failed update cleared its staged intent,
            // so readers (and retry-time fallback resolution) see the committed value.
            const saved = yield* readConfig(file)
            expect(saved).toContain('"model": "model-e1"')
            expect(saved).not.toContain('"model": "model-e2"')
            expect(injection.calls.renames.length).toBe(1)
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-e1" })
            injection.faults.write = false
            yield* config.update({ shell: "/bin/zsh" })
            expect(Config.latest(yield* config.entries(), "shell")).toBe("/bin/zsh")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )


  it.live("re-applies a repeated fallback at its own commit boundary so it still commits", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept"\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            const stagedModel = intent.current().pipe(
              Effect.map((snap) =>
                snap.override.type === "none" || snap.override.value === null
                  ? undefined
                  : String(snap.override.value.model),
              ),
            )
            const fileReads = () => injection.calls.reads.filter((read) => read.path === file).length
            // Story 2 scenario 9 (A -> B -> A): the third update's pre-admission candidate is
            // byte-equal to the on-disk document, but B lands at an earlier entry position, so
            // the third comparison happens at its own commit boundary, against B's document.
            yield* config.update({ fallback: { providerID: "openai", model: "model-a1" } })
            expect(injection.calls.renames.length).toBe(1)
            const readsAtStart = fileReads()
            const park = Deferred.makeUnsafe<unknown>()
            injection.armReadGate(file, park)
            const writerB = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-b2" } }))
            yield* injection.awaitUntil(() => Effect.succeed(fileReads() >= readsAtStart + 1))
            const writerA2 = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-a1" } }))
            yield* injection.awaitUntil(() => stagedModel.pipe(Effect.map((model) => model === "model-a1")))
            // Negative: while B is parked nothing new is durable, and A2's stale byte-equal
            // candidate has not been (wrongly) treated as a completed no-op.
            expect(injection.calls.renames.length).toBe(1)
            yield* Deferred.succeed(park, undefined)
            expect(Exit.isSuccess(yield* Fiber.await(writerB))).toBe(true)
            expect(Exit.isSuccess(yield* Fiber.await(writerA2))).toBe(true)
            // All three commits are durable in entry order; a stale pre-admission comparison
            // would have skipped the third write entirely.
            expect(injection.calls.renames.length).toBe(3)
            expect(injection.calls.writes[1]!.content).toContain('"model": "model-b2"')
            expect(injection.calls.writes[2]!.content).toContain('"model": "model-a1"')
            const saved = yield* readConfig(file)
            expect(saved).toContain('"model": "model-a1"')
            expect(saved).not.toContain('"model": "model-b2"')
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-a1" })
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("starts a second service generation from the committed document with no staged intent", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          yield* seedConfig(project, global, file, "{}\n")
          // Generation 1: the fallback update commits durably.
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            yield* config.update({ fallback: { providerID: "openai", model: "model-f1" } })
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-f1" })
          }).pipe(Effect.provide(testLayer(project, global)))
          // Generation 2 builds fresh from disk: the committed document is visible and nothing
          // is staged, so retry-time resolution falls through to the committed value.
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-f1" })
            const intent = yield* FallbackRuntimeIntent.Service
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
            expect(yield* readConfig(file)).toContain('"model": "model-f1"')
          }).pipe(Effect.provide(testLayer(project, global)))
        }),
      ),
    ),
  )

  it.live("orders three overlapping commits so a failed middle exit cannot clear the newest intent", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept"\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            const stagedModel = intent.current().pipe(
              Effect.map((snap) =>
                snap.override.type === "none" || snap.override.value === null
                  ? undefined
                  : String(snap.override.value.model),
              ),
            )
            const fileReads = () => injection.calls.reads.filter((read) => read.path === file).length
            const readsAtStart = fileReads()
            // B enters first and parks; C and D validate and stage first, in entry order.
            const parkB = Deferred.makeUnsafe<unknown>()
            injection.armReadGate(file, parkB)
            const writerB = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-g1" } }))
            yield* injection.awaitUntil(() => Effect.succeed(fileReads() >= readsAtStart + 1))
            const writerC = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-g2" } }))
            yield* injection.awaitUntil(() => stagedModel.pipe(Effect.map((model) => model === "model-g2")))
            const writerD = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-g3" } }))
            yield* injection.awaitUntil(() => stagedModel.pipe(Effect.map((model) => model === "model-g3")))
            // C validated before B, D before both, yet nothing is durable yet.
            expect(injection.calls.renames.length).toBe(0)
            expect(yield* readConfig(file)).toBe(initial)
            // Entry order B -> C -> D fixes the temp-write order; C's temp write fails.
            let temps = 0
            injection.faults.write = (target) => target.endsWith(".tmp") && ++temps === 2
            yield* Deferred.succeed(parkB, undefined)
            expect(Exit.isSuccess(yield* Fiber.await(writerB))).toBe(true)
            const exitC = yield* Fiber.await(writerC)
            expect(Exit.isSuccess(exitC)).toBe(false)
            // C retired its entry position and cleared only its own revision: D stays staged.
            expect(yield* stagedModel).toBe("model-g3")
            yield* injection.awaitUntil(() => Effect.succeed(injection.calls.renames.length >= 2))
            expect(Exit.isSuccess(yield* Fiber.await(writerD))).toBe(true)
            // Entry order held: B committed first, D's patch applied on top of B. C wrote a
            // temp file that failed and renamed nothing; every temp was cleaned up.
            expect(injection.calls.writes.length).toBe(3)
            expect(injection.calls.renames.length).toBe(2)
            expect(injection.calls.removes.length).toBe(3)
            const saved = yield* readConfig(file)
            expect(saved).toContain('"model": "model-g3"')
            expect(saved).not.toContain('"model": "model-g2"')
            expect(saved).not.toContain('"model": "model-g1"')
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-g3" })
            // D's own exit cleared only D's revision.
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )

  it.live("defers a durable commit while a protected reader holds a shared lease, then admits it", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "opencode.jsonc")
          const initial = '{\n  "username": "kept"\n}\n'
          yield* seedConfig(project, global, file, initial)
          const injection = filesystemInjection()
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            if (!config.update) throw new Error("Config updates are unavailable")
            const intent = yield* FallbackRuntimeIntent.Service
            const admission = yield* SessionGenerationAdmission.Service
            const stagedModel = intent.current().pipe(
              Effect.map((snap) =>
                snap.override.type === "none" || snap.override.value === null
                  ? undefined
                  : String(snap.override.value.model),
              ),
            )
            // A session generation in flight holds the shared side of the admission lease.
            const lease = yield* admission.acquireShared
            const writer = yield* Effect.forkChild(config.update({ fallback: { providerID: "openai", model: "model-lease" } }))
            yield* injection.awaitUntil(() => stagedModel.pipe(Effect.map((model) => model === "model-lease")))
            // FR-006 ordering is visible through the lease too: staging happened BEFORE
            // admission, while the durable commit waits for the protected reader.
            expect(injection.calls.writes.length).toBe(0)
            expect(injection.calls.renames.length).toBe(0)
            expect(yield* readConfig(file)).toBe(initial)
            yield* lease.release
            yield* injection.awaitUntil(() => Effect.succeed(injection.calls.renames.length >= 1))
            expect(Exit.isSuccess(yield* Fiber.await(writer))).toBe(true)
            const entries = yield* config.entries()
            expect(Config.latest(entries, "fallback")).toMatchObject({ model: "model-lease" })
            // The committed update cleared its own staged revision, and a later exclusive
            // owner (a generation change) acquires immediately.
            expect(yield* intent.current().pipe(Effect.map((snap) => snap.override.type))).toBe("none")
            const next = yield* admission.acquireExclusive
            yield* next.release
          }).pipe(Effect.provide(injectedLayer(project, global, injection)))
        }),
      ),
    ),
  )
})
