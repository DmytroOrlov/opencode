import { NodeFileSystem } from "@effect/platform-node"
import { validateRoutes } from "@opentunnel/client/effect"
import { Service, type Info } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { TLS_CA_CERTIFICATE_ENVIRONMENT, verifyTlsCaMode, type TlsCaMode } from "@opencode/util/tls-ca"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Deferred, Effect, FileSystem, Schedule, Schema } from "effect"
import { NetAddress } from "effect/net"
import { TestClock } from "effect/testing"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { PortOwner } from "../src/services/port-owner"
import { ServiceConfig } from "../src/services/service-config"
import { ServiceRegistration } from "../src/services/service-registration"
import { selfLaunchEnvironment } from "../src/util/process"
import { spawnServiceContender } from "../../client/src/service-contender"
import { isolatedEnv, transpilerCache } from "./fixture/environment"
import { testEffect } from "../../core/test/lib/effect"

verifyTlsCaMode("bundled")

const it = testEffect(NodeFileSystem.layer)

test("managed service ports are stable per installation channel", () => {
  expect(ServiceConfig.defaultPort("latest", "linux")).toBe(0xc0de)
  expect(ServiceConfig.defaultPort("dev", "linux")).toBe(0xc0de)
  expect(ServiceConfig.defaultPort("beta", "linux")).toBe(0xc0de)
  expect(ServiceConfig.defaultPort("next", "linux")).toBe(0xc0de)
  expect(ServiceConfig.defaultPort("local", "linux")).toBe(0xc0df)
  expect(ServiceConfig.defaultPort("latest", "darwin")).toBe(0xc0de)
  expect(ServiceConfig.defaultPort("preview-a", "linux")).toBe(ServiceConfig.defaultPort("preview-a", "linux"))
  expect(ServiceConfig.defaultPort("preview-a", "linux")).not.toBe(ServiceConfig.defaultPort("preview-b", "linux"))
})

test("managed service ports on Windows stay below the ranges Windows and WSL reserve", () => {
  expect(ServiceConfig.defaultPort("latest", "win32")).toBe(0x70de)
  expect(ServiceConfig.defaultPort("dev", "win32")).toBe(0x70de)
  expect(ServiceConfig.defaultPort("local", "win32")).toBe(0x70df)
  const ports = Array.from({ length: 200 }, (_, index) => ({
    windows: ServiceConfig.defaultPort(`preview-${index}`, "win32"),
    linux: ServiceConfig.defaultPort(`preview-${index}`, "linux"),
  }))
  expect(ports.some((port) => port.linux >= 0x8000)).toBe(true)
  expect(ports.every((port) => port.windows >= 10_000 && port.windows < 0x8000)).toBe(true)
  expect(ports.filter((port) => port.linux < 0x8000 && port.windows !== port.linux)).toEqual([])
})

test("service disabled accepts only booleans without changing configuration on invalid input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-disabled-config-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    expect(await run(ServiceConfig.get("disabled"))).toBe("false")
    await expect(run(ServiceConfig.set("disabled", "yes"))).rejects.toThrow("Disabled must be true or false")
    expect(await run(ServiceConfig.read())).toEqual({})
    await run(ServiceConfig.set("disabled", "true"))
    expect(await run(ServiceConfig.read())).toEqual({ disabled: true })
    await run(ServiceConfig.unset("disabled"))
    expect(await run(ServiceConfig.read())).toEqual({})
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Enabling remote creates a real tunnel, so only the paths that stay local are covered here.
test("service remote accepts only booleans and persists across set and unset", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-remote-config-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    expect(await run(ServiceConfig.get("remote"))).toBe("false")
    await expect(run(ServiceConfig.set("remote", "on"))).rejects.toThrow("Remote must be true or false")
    expect(await run(ServiceConfig.read())).toEqual({})
    await run(ServiceConfig.set("remote", "false"))
    expect(await run(ServiceConfig.read())).toEqual({})
    expect(await run(ServiceConfig.get("remote"))).toBe("false")
    await run(ServiceConfig.unset("remote"))
    expect(await run(ServiceConfig.read())).toEqual({})
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("remote access route is random, stable once created, hidden, and forgotten when remote is turned off", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-remote-route-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    const route = await run(ServiceConfig.remote())
    // The SDK rejects invalid route names, which would keep the service from ever attaching.
    expect(() => validateRoutes({ [route]: "127.0.0.1:4096" })).not.toThrow()
    expect(route).toMatch(/^[0-9a-f]{16}$/)
    expect(await run(ServiceConfig.read())).toEqual({ remote: { route } })
    expect(await run(ServiceConfig.remote())).toBe(route)
    expect(await run(ServiceConfig.get("remote"))).toBe("true")
    expect(await run(ServiceConfig.get())).not.toContain(route)

    await run(ServiceConfig.set("remote", "false"))
    expect(await run(ServiceConfig.read())).toEqual({ remoteAccepted: true })
    expect(await run(ServiceConfig.get("remote"))).toBe("false")
    expect(await run(ServiceConfig.remote())).not.toBe(route)

    await run(ServiceConfig.unset("remote"))
    expect(await run(ServiceConfig.read())).toEqual({ remoteAccepted: true })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("reading a config with remote access stored as a boolean repairs it in place and keeps other settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-remote-legacy-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  const file = path.join(root, "config", ServiceConfig.filename())
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })

    await Bun.write(file, JSON.stringify({ remote: true, password: "kept", env: { A: "1" } }))
    const enabled = await run(ServiceConfig.read())
    const route = enabled.remote?.route ?? ""
    expect(route).toMatch(/^[0-9a-f]{16}$/)
    expect(enabled).toEqual({ remote: { route }, password: "kept", env: { A: "1" } })
    expect(await Bun.file(file).json()).toEqual(enabled)
    expect(await run(ServiceConfig.read())).toEqual(enabled)

    await Bun.write(file, JSON.stringify({ remote: false, password: "kept" }))
    expect(await run(ServiceConfig.read())).toEqual({ password: "kept" })
    expect(await Bun.file(file).json()).toEqual({ password: "kept" })

    const current = JSON.stringify({ remote: { route: "0123456789abcdef" }, password: "kept" })
    await Bun.write(file, current)
    expect(await run(ServiceConfig.read())).toEqual({ remote: { route: "0123456789abcdef" }, password: "kept" })
    expect(await Bun.file(file).text()).toBe(current)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("local channel stores service config with the local service filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-"))
  try {
    await Effect.runPromise(
      ServiceConfig.set("hostname", "127.0.0.2").pipe(
        Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(path.join(root, "config", "service-local.json")).json()).toEqual({
      hostname: "127.0.0.2",
    })
    expect(await Bun.file(path.join(root, "config", "service.json")).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service config manages environment variables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-env-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  try {
    await Effect.runPromise(
      ServiceConfig.set("env", "OPENCODE_SERVICE_ENV_TEST", "configured").pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(
      await Effect.runPromise(
        ServiceConfig.get("env", "OPENCODE_SERVICE_ENV_TEST").pipe(
          Effect.provide(layer),
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
    ).toBe("configured")
    expect(
      (
        await Effect.runPromise(
          ServiceConfig.options().pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)),
        )
      ).env,
    ).toEqual({ OPENCODE_SERVICE_ENV_TEST: "configured" })

    await Effect.runPromise(
      ServiceConfig.unset("env", "OPENCODE_SERVICE_ENV_TEST").pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(path.join(root, "config", "service-local.json")).json()).toEqual({})
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("saved service environment cannot move the registration's state directory", async () => {
  expect(ServiceConfig.processEnv(undefined)).toBeUndefined()
  expect(ServiceConfig.processEnv({ XDG_STATE_HOME: "/custom/state", XDG_DATA_HOME: "/custom/data", A: "1" })).toEqual({
    XDG_DATA_HOME: "/custom/data",
    A: "1",
  })

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-env-state-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  try {
    await fs.mkdir(path.join(root, "config"), { recursive: true })
    await Bun.write(
      path.join(root, "config", ServiceConfig.filename()),
      JSON.stringify({ env: { XDG_STATE_HOME: path.join(root, "elsewhere"), A: "1" } }),
    )
    const options = await Effect.runPromise(
      ServiceConfig.options().pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)),
    )
    expect(options.env).toEqual({ A: "1" })
    expect(options.file).toBe(path.join(root, "state", ServiceConfig.filename()))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

const tlsFixture = path.join(import.meta.dir, "fixture/tls-ca-mode")

function hostileSavedEnvironment(mode: TlsCaMode) {
  return {
    OPENCODE_TLS_CA_MODE: mode === "bundled" ? "system" : "openssl",
    OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
    BUN_OPTIONS: "--smol --use-system-ca",
    NODE_OPTIONS: "--trace-warnings --require ./saved-hostile.js",
    BUN_BE_BUN: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    ...(mode === "bundled"
      ? {
          NODE_EXTRA_CA_CERTS: "",
          NODE_USE_SYSTEM_CA: "1",
          SSL_CERT_FILE: path.join(tlsFixture, "root.pem"),
          SSL_CERT_DIR: tlsFixture,
        }
      : {
          NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem"),
          SSL_CERT_DIR: tlsFixture,
        }),
    OPENCODE_SERVICE_ENV_TEST: "saved-sentinel",
  }
}

test("self-launch projection removes hostile saved and inherited launch authority", () => {
  const unrelated = { TLS_CA_UNRELATED: "keep" }

  const bundledSaved = selfLaunchEnvironment("bundled", {}, {
    ...hostileSavedEnvironment("bundled"),
    ...unrelated,
  })
  expect(bundledSaved).toEqual({ ...unrelated, OPENCODE_SERVICE_ENV_TEST: "saved-sentinel" })

  const bundledInherited = {
    ...hostileSavedEnvironment("bundled"),
    TLS_CA_UNRELATED: "keep",
  }
  const snapshot = { ...bundledInherited }
  const bundled = selfLaunchEnvironment("bundled", bundledInherited, {
    ...hostileSavedEnvironment("bundled"),
    TLS_CA_UNRELATED: "saved",
  })
  expect(bundledInherited).toEqual(snapshot)
  expect(bundled.TLS_CA_UNRELATED).toBe("saved")
  for (const key of [...TLS_CA_CERTIFICATE_ENVIRONMENT, ...forbiddenRuntimeKeys]) {
    expect(Object.hasOwn(bundled, key)).toBe(true)
    expect(bundled[key]).toBeUndefined()
    expect(Object.hasOwn(bundledInherited, key)).toBe(true)
  }

  const system = selfLaunchEnvironment("system", {}, {
    NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem"),
    SSL_CERT_DIR: tlsFixture,
    NODE_USE_SYSTEM_CA: "1",
    ...forbiddenSavedRuntimeOptions,
    ...unrelated,
  })
  expect(system).toEqual({
    NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem"),
    SSL_CERT_DIR: tlsFixture,
    NODE_USE_SYSTEM_CA: "1",
    ...unrelated,
  })

  const emptyInherited = selfLaunchEnvironment(
    "bundled",
    { NODE_EXTRA_CA_CERTS: "", NODE_USE_SYSTEM_CA: "", SSL_CERT_FILE: "", SSL_CERT_DIR: "" },
    { A: "1" },
  )
  expect(emptyInherited).toEqual({
    A: "1",
    NODE_EXTRA_CA_CERTS: undefined,
    NODE_USE_SYSTEM_CA: undefined,
    SSL_CERT_FILE: undefined,
    SSL_CERT_DIR: undefined,
  })

  for (const mode of ["bundled", "system"] as const) {
    const saved = { ...forbiddenSavedRuntimeOptions, TLS_CA_UNRELATED: "keep" }
    const input = { ...saved }
    expect(selfLaunchEnvironment(mode, {}, saved)).toEqual({ TLS_CA_UNRELATED: "keep" })
    expect(saved).toEqual(input)
    const inherited = { ...forbiddenSavedRuntimeOptions, TLS_CA_INHERITED: "keep" }
    const inheritedSnapshot = { ...inherited }
    const overlay = selfLaunchEnvironment(mode, inherited, {})
    expect(inherited).toEqual(inheritedSnapshot)
    for (const key of forbiddenRuntimeKeys) {
      expect(overlay[key]).toBeUndefined()
      expect(Object.hasOwn(overlay, key)).toBe(true)
    }
    expect(overlay.OPENCODE_TLS_CA_MODE).toBeUndefined()
    expect(overlay.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
  }
})

const forbiddenRuntimeKeys = ["OPENCODE_TLS_CA_BOOTSTRAPPED", "BUN_OPTIONS", "NODE_OPTIONS", "BUN_BE_BUN"] as const
const forbiddenSavedRuntimeOptions = {
  OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
  BUN_OPTIONS: "--inspect",
  NODE_OPTIONS: "--require ./saved.js",
  BUN_BE_BUN: "1",
  OPENCODE_TLS_CA_MODE: "system",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
}

test("self-launch projection handles selectors and disabled verification explicitly", () => {
  const savedSelector = selfLaunchEnvironment("bundled", {}, { OPENCODE_TLS_CA_MODE: "system" })
  expect(savedSelector).toEqual({})

  const conflictingInherited = selfLaunchEnvironment(
    "bundled",
    { OPENCODE_TLS_CA_MODE: "system" },
    {},
  )
  expect(Object.hasOwn(conflictingInherited, "OPENCODE_TLS_CA_MODE")).toBe(true)
  expect(conflictingInherited.OPENCODE_TLS_CA_MODE).toBeUndefined()

  const matchingInherited = selfLaunchEnvironment("system", { OPENCODE_TLS_CA_MODE: "system" }, {})
  expect(matchingInherited).toEqual({})

  const savedDisabled = selfLaunchEnvironment("bundled", {}, { NODE_TLS_REJECT_UNAUTHORIZED: "0", A: "1" })
  expect(savedDisabled).toEqual({ A: "1" })

  const inheritedDisabled = selfLaunchEnvironment("bundled", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { A: "1" })
  expect(Object.hasOwn(inheritedDisabled, "NODE_TLS_REJECT_UNAUTHORIZED")).toBe(true)
  expect(inheritedDisabled.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
  expect(inheritedDisabled.A).toBe("1")

  const inherited = { NODE_TLS_REJECT_UNAUTHORIZED: "1" }
  const inheritedEnabled = selfLaunchEnvironment("bundled", inherited, {
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  })
  expect(inheritedEnabled).toEqual({})
  expect({ ...inherited, ...inheritedEnabled }.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
  expect(
    selfLaunchEnvironment("bundled", {}, { NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_TLS_REJECT_UNAUTHORIZED_SAVED: "1" }),
  ).toEqual({ NODE_TLS_REJECT_UNAUTHORIZED_SAVED: "1" })
})

test("the live projection preserves already effective system inputs and applies unrelated saved settings", () => {
  const inherited = {
    NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem"),
    SSL_CERT_DIR: tlsFixture,
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
  }
  const touched = [
    ...Object.keys(inherited),
    "OPENCODE_TLS_CA_MODE",
    "OPENCODE_TLS_CA_BOOTSTRAPPED",
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "BUN_BE_BUN",
    "OPENCODE_SERVICE_ENV_TEST",
  ]
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]))
  Object.assign(process.env, inherited)
  try {
    const projection = ServiceConfig.verifiedProcessEnv({
      ...inherited,
      NODE_EXTRA_CA_CERTS: "/saved/should-not-apply.pem",
      OPENCODE_TLS_CA_MODE: "system",
      OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
      BUN_OPTIONS: "--inspect",
      NODE_OPTIONS: "--require ./saved.js",
      BUN_BE_BUN: "1",
      OPENCODE_SERVICE_ENV_TEST: "saved",
    })
    expect(projection).toEqual({ OPENCODE_SERVICE_ENV_TEST: "saved" })
    Object.assign(process.env, projection)
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(inherited.NODE_EXTRA_CA_CERTS)
    expect(process.env.SSL_CERT_DIR).toBe(inherited.SSL_CERT_DIR)
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
    expect(process.env.OPENCODE_SERVICE_ENV_TEST).toBe("saved")
    expect(process.env.BUN_OPTIONS).toBeUndefined()
    expect(process.env.NODE_OPTIONS).toBeUndefined()
    expect(process.env.BUN_BE_BUN).toBeUndefined()
    expect(process.env.OPENCODE_TLS_CA_BOOTSTRAPPED).toBeUndefined()
  } finally {
    for (const key of touched) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("undefined overlay entries remove inherited variables at the real contender spawn boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-self-launch-spawn-"))
  const marker = path.join(root, "environment.json")
  const inherited: Record<string, string> = {
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    BUN_OPTIONS: "--smol",
    NODE_OPTIONS: "--require ./inherited.js",
    BUN_BE_BUN: "1",
    OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
    OPENCODE_TLS_CA_MODE: "system",
    NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem"),
    OPENCODE_SELF_LAUNCH_SENTINEL: "inherited",
  }
  const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]))
  Object.assign(process.env, inherited)
  const keys = [...Object.keys(inherited), "OPENCODE_SERVICE_ENV_TEST"]
  let contender: ReturnType<typeof spawnServiceContender> | undefined
  try {
    const overlay = selfLaunchEnvironment("bundled", process.env, {
      ...forbiddenSavedRuntimeOptions,
      OPENCODE_SERVICE_ENV_TEST: "saved",
    })
    contender = spawnServiceContender(
      process.execPath,
      [path.join(import.meta.dir, "fixture/environment-observation.ts"), marker, ...keys],
      overlay,
    )

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !(await Bun.file(marker).exists())) await Bun.sleep(25)
    const observed = await Bun.file(marker).json()
    expect(observed).toEqual({
      NODE_TLS_REJECT_UNAUTHORIZED: null,
      BUN_OPTIONS: null,
      NODE_OPTIONS: null,
      BUN_BE_BUN: null,
      OPENCODE_TLS_CA_BOOTSTRAPPED: null,
      OPENCODE_TLS_CA_MODE: null,
      NODE_EXTRA_CA_CERTS: null,
      OPENCODE_SELF_LAUNCH_SENTINEL: "inherited",
      OPENCODE_SERVICE_ENV_TEST: "saved",
    })
    expect(contender.error()).toBeUndefined()
  } finally {
    contender?.child.kill("SIGKILL")
    if (contender && !contender.closed())
      await new Promise<void>((resolve) => contender!.child.once("exit", () => resolve()))
    contender?.release()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

const observationKeys = [
  ...TLS_CA_CERTIFICATE_ENVIRONMENT,
  "OPENCODE_TLS_CA_MODE",
  "OPENCODE_TLS_CA_BOOTSTRAPPED",
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "BUN_BE_BUN",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "OPENCODE_SERVICE_ENV_TEST",
]

function observationPlugin(marker: string) {
  return `import { writeFileSync } from "node:fs"
const keys = ${JSON.stringify(observationKeys)}
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(Object.fromEntries(keys.map((key) => [key, Object.hasOwn(process.env, key) ? process.env[key] ?? null : null]))))
export default { id: "environment-observation", setup: async () => {} }
`
}

async function waitForObservation(root: string, marker: string, url: string, headers: HeadersInit) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const endpoint = new URL("/api/plugin", url)
    endpoint.searchParams.set("location[directory]", root)
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(2_000) }).catch(() => undefined)
    if (response?.ok && (await Bun.file(marker).exists())) {
      return (await Bun.file(marker).json()) as Record<string, string | null>
    }
    await Bun.sleep(50)
  }
  throw new Error("The executing server never loaded the environment observation plugin")
}

async function startNormalManagedService(prefix: string, mode: TlsCaMode) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  const port = await availablePort()
  const configFile = path.join(root, "config", ServiceConfig.filename())
  const registration = path.join(root, "state", "opencode", ServiceConfig.filename())
  const marker = path.join(root, "service-environment.json")
  const saved = { port, env: hostileSavedEnvironment(mode) }
  await fs.mkdir(path.dirname(configFile), { recursive: true })
  await fs.writeFile(configFile, JSON.stringify(saved))
  await fs.mkdir(path.join(root, ".opencode", "plugins"), { recursive: true })
  await fs.writeFile(path.join(root, ".opencode", "plugins", "environment.ts"), observationPlugin(marker))

  const start = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "../src/index.ts"),
      `--tls-ca-mode=${mode}`,
      "service",
      "start",
    ],
    { cwd: path.join(import.meta.dir, ".."), env: isolatedEnv(root), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(start.stdout).text(),
    new Response(start.stderr).text(),
    start.exited,
  ])
  try {
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const url = stdout.trim().split("\n").at(-1)
    expect(url).toStartWith("http://127.0.0.1:")
    const info = await waitForInfo(registration)
    expect(new URL(info.url).port).toBe(String(port))
    const headers = { authorization: "Basic " + btoa(`opencode:${info.password}`) }
    const observed = await waitForObservation(root, marker, info.url, headers)
    return {
      root,
      port,
      registration,
      configFile,
      saved,
      startPid: start.pid,
      info,
      observed,
    }
  } catch (cause) {
    let cleanup: string | undefined
    if (start.exitCode === null) {
      start.kill("SIGTERM")
      let stopped = await waitForExit(start, 5_000)
      if (!stopped) {
        start.kill("SIGKILL")
        stopped = await waitForExit(start, 2_000)
      }
      if (!stopped) cleanup = `Owned service start process ${start.pid} did not exit`
    }
    cleanup = await stopPublishedTestService(registration, true).then(
      () => cleanup,
      (error: unknown) => [cleanup, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; "),
    )
    if (cleanup !== undefined) {
      throw new Error(
        `Managed service startup failed and cleanup did not complete; root retained at ${root}: ${cleanup}`,
        { cause },
      )
    }
    await fs.rm(root, { recursive: true, force: true })
    throw cause
  }
}

async function stopPublishedTestService(registration: string, waitForRegistration = false) {
  let exists = await Bun.file(registration).exists()
  if (!exists && waitForRegistration) {
    const deadline = Date.now() + 5_000
    while (!exists && Date.now() < deadline) {
      await Bun.sleep(25)
      exists = await Bun.file(registration).exists()
    }
  }
  if (!exists) return
  const raw = await Bun.file(registration)
    .json()
    .catch(() => undefined)
  if (raw === undefined) throw new Error(`Registration ${registration} could not be read for cleanup`)
  const info = await Schema.decodeUnknownPromise(Service.Info)(raw)
  await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
  if (!(await waitForPIDGone(info.pid))) {
    process.kill(info.pid, "SIGTERM")
    if (!(await waitForPIDGone(info.pid, 2_000))) {
      process.kill(info.pid, "SIGKILL")
      if (!(await waitForPIDGone(info.pid, 2_000)))
        throw new Error(`Owned service process ${info.pid} did not exit`)
    }
  }
  if (await Bun.file(registration).exists()) throw new Error(`Owned registration ${registration} was not removed`)
}

async function waitForPIDGone(pid: number, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!running(pid)) return true
    await Bun.sleep(25)
  }
  return !running(pid)
}

test.each(["bundled", "system"] as const)(
  "normal managed service %s child receives only the verified launch environment",
  async (mode) => {
    const service = await startNormalManagedService(`opencode-service-observed-${mode}-`, mode)
    try {
      expect(service.info.pid).not.toBe(service.startPid)
      expect(running(service.info.pid)).toBe(true)
      expect(service.observed.OPENCODE_TLS_CA_MODE).toBe(mode)
      expect(service.observed.OPENCODE_TLS_CA_BOOTSTRAPPED).toBeNull()
      expect(service.observed.BUN_OPTIONS).toBeNull()
      expect(service.observed.NODE_OPTIONS).toBeNull()
      expect(service.observed.BUN_BE_BUN).toBeNull()
      expect(service.observed.NODE_TLS_REJECT_UNAUTHORIZED).toBeNull()
      expect(service.observed.OPENCODE_SERVICE_ENV_TEST).toBe("saved-sentinel")
      if (mode === "bundled") {
        for (const key of TLS_CA_CERTIFICATE_ENVIRONMENT) expect(service.observed[key]).toBeNull()
      } else {
        expect(service.observed.NODE_EXTRA_CA_CERTS).toBe(path.join(tlsFixture, "root.pem"))
        expect(service.observed.SSL_CERT_DIR).toBe(tlsFixture)
      }
      expect(await Bun.file(service.configFile).json()).toMatchObject(service.saved)
      expect(
        await fetch(new URL("/api/info", service.info.url), { headers: { authorization: "Basic " + btoa(`opencode:${service.info.password}`) } }).then(
          (response) => response.json(),
        ),
      ).toMatchObject({ pid: service.info.pid, tlsCaMode: mode })
      await Effect.runPromise(Service.stop({ file: service.registration }).pipe(Effect.provide(NodeFileSystem.layer)))
      for (let attempt = 0; attempt < 400 && running(service.info.pid); attempt++) await Bun.sleep(25)
      expect(running(service.info.pid)).toBe(false)
    } finally {
      await stopObservedService(service)
    }
  },
  60_000,
)

test.each(["bundled", "system"] as const)(
  "direct service %s launch filters saved TLS configuration after verification",
  async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `opencode-service-direct-${mode}-`)))
    const port = await availablePort()
    const configFile = path.join(root, "config", ServiceConfig.filename())
    const registration = path.join(root, "state", "opencode", ServiceConfig.filename())
    const marker = path.join(root, "service-environment.json")
    const saved = { port, env: hostileSavedEnvironment(mode) }
    await fs.mkdir(path.dirname(configFile), { recursive: true })
    await fs.writeFile(configFile, JSON.stringify(saved))
    await fs.mkdir(path.join(root, ".opencode", "plugins"), { recursive: true })
    await fs.writeFile(path.join(root, ".opencode", "plugins", "environment.ts"), observationPlugin(marker))
    const owner = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../src/index.ts"),
        `--tls-ca-mode=${mode}`,
        "serve",
        "--service",
      ],
      { cwd: path.join(import.meta.dir, ".."), env: isolatedEnv(root), stdout: "ignore", stderr: "pipe" },
    )
    const stderr = new Response(owner.stderr).text()
    try {
      const info = await waitForInfo(registration)
      expect(info.pid).toBeGreaterThan(0)
      expect(running(info.pid)).toBe(true)
      const headers = { authorization: "Basic " + btoa(`opencode:${info.password}`) }
      const observed = await waitForObservation(root, marker, info.url, headers)
      expect(observed.OPENCODE_TLS_CA_MODE).toBe(mode)
      expect(observed.OPENCODE_TLS_CA_BOOTSTRAPPED).toBeNull()
      expect(observed.BUN_OPTIONS).toBeNull()
      expect(observed.NODE_OPTIONS).toBeNull()
      expect(observed.BUN_BE_BUN).toBeNull()
      expect(observed.NODE_TLS_REJECT_UNAUTHORIZED).toBeNull()
      expect(observed.OPENCODE_SERVICE_ENV_TEST).toBe("saved-sentinel")
      for (const key of TLS_CA_CERTIFICATE_ENVIRONMENT) expect(observed[key]).toBeNull()
      expect(await Bun.file(configFile).json()).toMatchObject(saved)
      await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
      expect(await waitForPIDGone(info.pid)).toBe(true)
      expect(await Bun.file(registration).exists()).toBe(false)
    } finally {
      const failures: string[] = []
      try {
        await stopPublishedTestService(registration)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
      if (owner.exitCode === null) {
        owner.kill("SIGTERM")
        if (!(await waitForExit(owner, 5_000))) {
          owner.kill("SIGKILL")
          if (!(await waitForExit(owner, 2_000))) failures.push(`Owned direct service process ${owner.pid} did not exit`)
        }
      }
      const output = await stderr
      if (failures.length)
        throw new Error(
          `Direct service cleanup failed; root retained at ${root}: ${failures.join("; ")}\nstderr:\n${output}`,
        )
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)

async function stopObservedService(service: Awaited<ReturnType<typeof startNormalManagedService>>) {
  await Effect.runPromise(Service.stop({ file: service.registration }).pipe(Effect.provide(NodeFileSystem.layer))).catch(
    () => {},
  )
  if (!(await waitForPIDGone(service.info.pid))) {
    process.kill(service.info.pid, "SIGTERM")
    if (!(await waitForPIDGone(service.info.pid, 2_000))) {
      process.kill(service.info.pid, "SIGKILL")
      if (!(await waitForPIDGone(service.info.pid, 2_000)))
        throw new Error(`Owned observed service process ${service.info.pid} did not exit`)
    }
  }
  if (await Bun.file(service.registration).exists())
    throw new Error(`Owned observed service registration ${service.registration} was not removed`)
  await fs.rm(service.root, { recursive: true, force: true })
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(process.platform === "win32" || !Bun.which("lsof"))("port owner names the listening process", async () => {
  using listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  using wildcard = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response() })
  const describe = (port: number | undefined, hostname?: string) =>
    Effect.runPromise(PortOwner.describe(port ?? 0, hostname).pipe(Effect.provide(LayerNode.compile(AppProcess.node))))
  expect(await describe(listener.port)).toStartWith(`PID ${process.pid} (`)
  expect(await describe(listener.port, "127.0.0.1")).toStartWith(`PID ${process.pid} (`)
  expect(await describe(listener.port, "localhost")).toStartWith(`PID ${process.pid} (`)
  expect(await describe(listener.port, "127.0.0.2")).toBeUndefined()
  expect(await describe(wildcard.port, "127.0.0.2")).toStartWith(`PID ${process.pid} (`)
})

test.skipIf(process.platform === "win32")("port owner gives up on a lookup that ignores SIGTERM", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-port-owner-stuck-"))
  const PATH = process.env.PATH
  try {
    await Bun.write(path.join(root, "lsof"), "#!/bin/sh\ntrap '' TERM\nsleep 10\n")
    await fs.chmod(path.join(root, "lsof"), 0o755)
    process.env.PATH = `${root}${path.delimiter}${PATH}`
    const started = Date.now()
    const owner = await Promise.race([
      Effect.runPromise(PortOwner.describe(1).pipe(Effect.provide(LayerNode.compile(AppProcess.node)))),
      Bun.sleep(4_000).then(() => "hung"),
    ])
    expect(owner).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3_000)
  } finally {
    process.env.PATH = PATH
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("port owner is unknown for a free port", async () => {
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = free.port ?? 0
  free.stop(true)
  expect(
    await Effect.runPromise(PortOwner.describe(port).pipe(Effect.provide(LayerNode.compile(AppProcess.node)))),
  ).toBeUndefined()
})

test("service filenames share release channels and identify preview channels", () => {
  expect(ServiceConfig.filename("latest")).toBe("service.json")
  expect(ServiceConfig.filename("dev")).toBe("service.json")
  expect(ServiceConfig.filename("beta")).toBe("service.json")
  expect(ServiceConfig.filename("next")).toBe("service.json")
  expect(ServiceConfig.filename("local")).toBe("service-local.json")
  expect(ServiceConfig.filename("preview-a")).toBe("service-preview-a.json")
  expect(ServiceConfig.filename("preview/a")).toBe("service-preview-a.json")
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-1234", "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-1234.2", "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-other-1234", "preview-a")).toBe(false)
  expect(ServiceConfig.versionBelongsToChannel("1.2.3", "preview-a")).toBe(false)
})

test("service config migrates from the hashed channel filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-migration-"))
  const legacy = path.join(root, ServiceConfig.legacyFilename("preview-a")!)
  const target = path.join(root, ServiceConfig.filename("preview-a"))
  try {
    await fs.writeFile(legacy, JSON.stringify({ hostname: "127.0.0.2", port: 4098 }))
    await Effect.runPromise(ServiceConfig.migrateConfig(legacy, target).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await Bun.file(target).json()).toEqual({ hostname: "127.0.0.2", port: 4098 })

    await fs.writeFile(target, JSON.stringify({ port: 4099 }))
    await Effect.runPromise(ServiceConfig.migrateConfig(legacy, target).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await Bun.file(target).json()).toEqual({ port: 4099 })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("preview registration migration never moves stable discovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-migration-"))
  const legacy = path.join(root, "service.json")
  const target = path.join(root, ServiceConfig.filename("preview-a"))
  try {
    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "old-preview" })

    await fs.rm(target)
    await fs.writeFile(legacy, JSON.stringify({ id: "stable", version: "1.2.3", url: "http://localhost:4096", pid: 1 }))
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).exists()).toBe(false)

    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await fs.writeFile(target, JSON.stringify({ id: "current-preview" }))
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "current-preview" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it.effect("deleting a managed service registration stops its owner", () =>
  Effect.gen(function* () {
    const service = yield* registered()
    yield* service.fileSystem.remove(service.file)
    yield* service.stops
    yield* service.cleanup
    expect(yield* service.fileSystem.exists(service.file)).toBe(false)
  }),
)

it.effect("corrupting a managed service registration stops its owner", () =>
  Effect.gen(function* () {
    const service = yield* registered()
    yield* service.fileSystem.writeFileString(service.file, "not-json")
    yield* service.stops
    yield* service.cleanup
    expect(yield* service.fileSystem.readFileString(service.file)).toBe("not-json")
  }),
)

it.effect("replacing a managed service registration stops its owner and preserves the foreign owner", () =>
  Effect.gen(function* () {
    const service = yield* registered()
    const foreign = JSON.stringify({ id: "foreign-owner", url: "http://127.0.0.1:4322", pid: process.pid })
    yield* service.fileSystem.writeFileString(service.file, foreign)
    yield* service.stops
    yield* service.cleanup
    expect(yield* service.fileSystem.readFileString(service.file)).toBe(foreign)
  }),
)

// Real process: a server whose boot failed must still be watching its registration.
test("deleting a failed service registration stops its owner", async () => {
  const service = await startManagedService("opencode-service-failed-delete-", true)
  try {
    await waitForFailed(service.info)
    await fs.rm(service.registration)
    expect(await waitForExit(service.owner)).toBe(true)
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("clean managed service shutdown removes its registration", async () => {
  const service = await startManagedService("opencode-service-clean-")
  try {
    await Effect.runPromise(Service.stop({ file: service.registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await waitForExit(service.owner)).toBe(true)
    expect(await Bun.file(service.registration).exists()).toBe(false)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("concurrent service processes elect one server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-election-"))
  const env = serviceEnv(root)
  const command = [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"]
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const port = await availablePort()
  const config = path.join(root, "config", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port }))
  const processes = Array.from({ length: 10 }, () => Bun.spawn(command, { env, stderr: "pipe", stdout: "pipe" }))

  try {
    const info = await waitForInfo(registration)
    const winner = processes.find((process) => process.pid === info.pid)
    const losers = processes.filter((process) => process.pid !== info.pid)
    const exited = await Promise.all(
      losers.map((process) => Promise.race([process.exited.then(() => true), Bun.sleep(60_000).then(() => false)])),
    )

    expect(exited).toEqual(losers.map(() => true))
    const errors = await Promise.all(
      losers.map(
        async (process) => (await new Response(process.stdout).text()) + (await new Response(process.stderr).text()),
      ),
    )
    expect(
      losers.map((process) => process.exitCode),
      errors.filter(Boolean).join("\n"),
    ).toEqual(losers.map(() => 0))
    expect(winner?.exitCode).toBe(null)
    expect(new URL(info.url).port).toBe(String(port))
    expect((await Bun.file(config).json()).password).toBe(info.password)
    expect(await Bun.file(registration + ".lock").exists()).toBe(false)
    expect(
      await fetch(new URL("/api/info", info.url), {
        headers: { authorization: "Basic " + btoa(`opencode:${info.password}`) },
      }).then((response) => response.json()),
    ).toMatchObject({
      version: info.version,
      pid: info.pid,
      hostname: os.hostname(),
      urls: [info.url],
      // The server reports the canonical tmp directory; Windows os.tmpdir() can be an 8.3 short name.
      paths: { tmp: await fs.realpath(path.join(os.tmpdir(), "opencode")) },
      capabilities: { persistentPty: true },
    })
    const contender = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })
    try {
      const contenderExited = await Promise.race([
        contender.exited.then(() => true),
        Bun.sleep(10_000).then(() => false),
      ])
      expect(contenderExited).toBe(true)
      expect(contender.exitCode).toBe(0)
      expect((await waitForInfo(registration)).id).toBe(info.id)
    } finally {
      contender.kill("SIGTERM")
      await contender.exited
    }
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await winner?.exited
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    processes.forEach((process) => process.kill("SIGTERM"))
    await Promise.all(processes.map((process) => process.exited))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 120_000)

test("configured managed service port overrides the channel default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-port-"))
  const port = await availablePort()
  const env = serviceEnv(root)
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const config = path.join(root, "config", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port, password: "" }))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env,
    stderr: "pipe",
    stdout: "ignore",
  })
  try {
    const info = await waitForInfo(registration)
    expect(new URL(info.url).port).toBe(String(port))
    expect(info.password).not.toBe("")
    expect((await Bun.file(config).json()).password).toBe(info.password)
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await owner.exited
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.each([
  { args: [], origins: ["http://192.0.2.10:3001", "https://configured.example.com"] },
  {
    args: ["--cors", "http://192.0.2.20:3001", "--cors", "https://override.example.com"],
    origins: ["http://192.0.2.20:3001", "https://override.example.com"],
  },
])(
  "managed service applies CORS configuration with flag overrides: $args",
  async ({ args, origins }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-cors-"))
    const config = path.join(root, "config", ServiceConfig.filename())
    const registration = path.join(root, "state", "opencode", ServiceConfig.filename())
    const cors = ["http://192.0.2.10:3001", "https://configured.example.com"]
    await fs.mkdir(path.dirname(config), { recursive: true })
    await fs.writeFile(config, JSON.stringify({ cors }))
    const owner = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service", "--port", "0", ...args],
      { env: isolatedEnv(root), stderr: "pipe", stdout: "ignore" },
    )
    try {
      const info = await waitForInfo(registration)
      await Promise.all(
        [...new Set([...cors, ...origins, "https://unlisted.example.com"])].map(async (origin) => {
          const response = await fetch(new URL("/api/info", info.url), {
            method: "OPTIONS",
            headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
          })
          expect(response.headers.get("access-control-allow-origin")).toBe(
            origins.some((value) => value === origin) ? origin : null,
          )
        }),
      )
      expect((await Bun.file(config).json()).cors).toEqual(cors)
    } finally {
      owner.kill("SIGTERM")
      await owner.exited
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test("the original managed service contender binds when the occupied port is released", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-bind-retry-"))
  const recognizing = Promise.withResolvers<void>()
  const requests: string[] = []
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      if (requests.length === 2) recognizing.resolve()
      return Response.json({ unrelated: true })
    },
  })
  const port = listener.port
  if (port === undefined) throw new Error("Server did not bind a port")
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(path.join(root, "config", "service-local.json"), JSON.stringify({ port }))
  await fs.writeFile(
    registration,
    JSON.stringify({
      id: "stale",
      version: OPENCODE_VERSION,
      url: "http://127.0.0.1:1",
      pid: 2_147_483_647,
      password: "stale",
    }),
  )
  const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: isolatedEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })
  const stderr = new Response(contender.stderr).text()
  try {
    // The first probe is preflight; the second only happens after start() fails to bind.
    expect(await Promise.race([recognizing.promise.then(() => true), Bun.sleep(20_000).then(() => false)])).toBe(true)
    expect(requests).toEqual(["/api/info", "/api/info"])
    await listener.stop(true)

    const info = await Promise.race([
      waitForInfo(registration, (info) => info.pid === contender.pid),
      contender.exited.then(() => undefined),
    ])
    expect(info?.pid, contender.exitCode === null ? undefined : await stderr).toBe(contender.pid)
    const endpoint = await Effect.runPromise(
      Service.discover({ file: registration }).pipe(
        Effect.filterOrFail((value) => value !== undefined),
        Effect.retry({ times: 400, schedule: Schedule.spaced("50 millis") }),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(new URL(endpoint.url).port).toBe(String(port))
    expect(
      await fetch(new URL("/api/info", endpoint.url), { headers: Service.headers(endpoint) }).then((response) =>
        response.json(),
      ),
    ).toMatchObject({ pid: contender.pid, version: OPENCODE_VERSION, urls: [endpoint.url] })
    expect(contender.exitCode).toBe(null)
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await waitForExit(contender)).toBe(true)
    expect(await Bun.file(registration).exists()).toBe(false)
    await expectPortAvailable(port)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("unresponsive managed port occupancy reports a bounded conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-unresponsive-conflict-"))
  const recognizing = Promise.withResolvers<void>()
  const requests = { count: 0 }
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests.count += 1
      if (requests.count === 2) recognizing.resolve()
      return new Promise<Response>(() => {})
    },
  })
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    path.join(root, "config", "opencode", "service-local.json"),
    JSON.stringify({ port: listener.port, env: { XDG_STATE_HOME: path.join(root, "elsewhere") } }),
  )
  const stale = {
    id: "stale",
    version: OPENCODE_VERSION,
    url: "http://127.0.0.1:1",
    pid: process.pid,
    password: "stale",
  }
  await fs.writeFile(registration, JSON.stringify(stale))
  // The port lookup is a child of the service, so it shows the state directory tools would inherit. Capture the
  // actual OS answers while our listener is alive, then replay them through the child PATH fixture. This keeps the
  // production lookup/parser/message path under test without requiring an unrelated OS-wide lsof scan to finish
  // inside its best-effort deadline.
  const lsof = process.platform === "win32" ? null : Bun.which("lsof")
  try {
    if (lsof) {
      const capture = async (executable: string, args: string[]) => {
        const child = Bun.spawn([executable, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const stdout = new Response(child.stdout).text()
        const stderr = new Response(child.stderr).text()
        if (!(await waitForExit(child, 5_000))) {
          child.kill("SIGKILL")
          if (!(await waitForExit(child, 2_000))) {
            throw new Error(`Port-owner fixture lookup did not stop: ${executable}`)
          }
          await Promise.all([stdout, stderr])
          throw new Error(`Port-owner fixture lookup timed out: ${executable}`)
        }
        const [out, err] = await Promise.all([stdout, stderr])
        if (child.exitCode !== 0 || out.trim() === "")
          throw new Error(`Port-owner fixture lookup failed: ${executable}, exit=${child.exitCode}, stderr=${err}`)
        return out
      }

      const lsofArgs = ["-nP", `-iTCP:${listener.port}`, "-sTCP:LISTEN", "-Fpn"]
      const psArgs = ["-o", "command=", "-p", String(process.pid)]
      const lsofOutput = await capture(lsof, lsofArgs)
      const psOutput = await capture("ps", psArgs)
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const writeLookup = async (name: string, args: string[], output: string, extra = "") => {
        const file = path.join(root, "bin", name)
        const checks = [
          `test "$#" -eq ${args.length}`,
          ...args.map((arg, index) => `test "$${index + 1}" = ${quote(arg)}`),
        ]
        await Bun.write(
          file,
          ["#!/bin/sh", "set -eu", ...checks, extra, `printf '%s' ${quote(output)}`, ""].filter(Boolean).join("\n") +
            "\n",
        )
        await fs.chmod(file, 0o755)
      }

      await fs.mkdir(path.join(root, "bin"), { recursive: true })
      await writeLookup(
        "lsof",
        lsofArgs,
        lsofOutput,
        `printf '%s' "$XDG_STATE_HOME" > ${quote(path.join(root, "inherited-state"))}`,
      )
      await writeLookup("ps", psArgs, psOutput)
    }
  } catch (cause) {
    await fs.rm(root, { recursive: true, force: true })
    throw cause
  }
  const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: { ...serviceEnv(root), PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}` },
    stderr: "pipe",
    stdout: "pipe",
  })

  try {
    expect(await Promise.race([recognizing.promise.then(() => true), Bun.sleep(20_000).then(() => false)])).toBe(true)
    const exitCode = await Promise.race([contender.exited, Bun.sleep(20_000).then(() => undefined)])
    expect(exitCode).toBe(1)
    const output = (await new Response(contender.stdout).text()) + (await new Response(contender.stderr).text())
    expect(output).toContain(
      `Managed service port ${listener.port} on 127.0.0.1 is already in use by ${
        lsof ? `PID ${process.pid} (` : "another process"
      }`,
    )
    if (lsof) expect(await Bun.file(path.join(root, "inherited-state")).text()).toBe(path.join(root, "state"))
    expect(await Bun.file(registration).json()).toEqual(stale)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("port contender recognizes an incumbent registered during the bind race", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-bind-race-"))
  const recognizing = Promise.withResolvers<void>()
  const requests = { count: 0 }
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests.count += 1
      if (requests.count === 2) recognizing.resolve()
      return Response.json(
        { version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: "/tmp/opencode" } },
        { status: 503 },
      )
    },
  })
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const config = path.join(root, "config", "opencode", "service-local.json")
  await fs.mkdir(path.dirname(config), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port: listener.port }))
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    registration,
    JSON.stringify({
      id: "stale",
      version: OPENCODE_VERSION,
      url: "http://127.0.0.1:1",
      pid: 2_147_483_647,
      password: "stale",
    }),
  )
  const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: serviceEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })

  try {
    expect(await Promise.race([recognizing.promise.then(() => true), Bun.sleep(20_000).then(() => false)])).toBe(true)
    await Bun.sleep(8_000)
    const info = {
      id: "incumbent",
      version: OPENCODE_VERSION,
      url: `http://127.0.0.1:${listener.port}`,
      pid: process.pid,
      password: "incumbent",
    }
    await fs.writeFile(registration, JSON.stringify(info))

    expect(await Promise.race([contender.exited, Bun.sleep(20_000).then(() => undefined)])).toBe(0)
    expect(await Bun.file(registration).json()).toEqual(info)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("service registration replaces a stale owner with the bound address", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-stale-"))
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    registration,
    JSON.stringify({ id: "dead", version: "dead", url: "http://127.0.0.1:4321", pid: 2_147_483_647 }),
  )
  try {
    const cleanup = await Effect.runPromise(
      ServiceRegistration.register({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 4321),
        password: "secret",
        id: "owner",
        file: registration,
        shutdown: Effect.never,
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    )
    expect(await Bun.file(registration).json()).toEqual({
      id: "owner",
      version: OPENCODE_VERSION,
      url: "http://127.0.0.1:4321",
      pid: process.pid,
      password: "secret",
    })
    await Effect.runPromise(cleanup.pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a failed service stays registered and owns the selected port until stopped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-failed-"))
  const port = await availablePort()
  const database = path.join(root, "database")
  await fs.mkdir(database)
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
  const env = { ...serviceEnv(root), OPENCODE_DB: database }
  const command = [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"]
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const owner = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })

  try {
    const info = await waitForInfo(registration)
    await waitForFailed(info)
    expect(owner.exitCode).toBe(null)

    const contender = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })
    expect(await Promise.race([contender.exited.then(() => true), Bun.sleep(10_000).then(() => false)])).toBe(true)
    expect(contender.exitCode).toBe(0)
    expect((await waitForInfo(registration)).id).toBe(info.id)
    expect(owner.exitCode).toBe(null)

    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await owner.exited
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

async function waitForInfo(file: string, accept: (info: Info) => boolean = () => true) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value !== undefined) {
      const info = await Schema.decodeUnknownPromise(Service.Info)(value)
      if (accept(info)) return info
    }
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for service registration")
}

async function waitForFailed(info: Info) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await fetch(new URL("/api/info", info.url), {
      headers: { authorization: "Basic " + btoa(`opencode:${info.password}`) },
    })
      .then((response) => response.status)
      .catch(() => undefined)
    if (status === 500) return
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for service boot failure")
}

async function availablePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Server did not bind a port")
  return port
}

/** A registration watched in-process. `stops` advances the test clock until the watch shuts the server down. */
const registered = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const file = path.join(yield* fileSystem.makeTempDirectoryScoped(), "service-local.json")
  const stopped = yield* Deferred.make<void>()
  const cleanup = yield* ServiceRegistration.register({
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 4321),
    password: "secret",
    id: "owner",
    file,
    shutdown: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
  })
  // Let the watch's immediate first check read the intact file, so the damage is found by a scheduled check.
  yield* TestClock.withLive(Effect.sleep("50 millis"))
  // Each check reads the file for real, so give that I/O live time between 5 s steps. Fail rather than hang.
  const stops = Effect.gen(function* () {
    for (const _ of Array.from({ length: 100 })) {
      if (yield* Deferred.isDone(stopped)) return
      yield* TestClock.adjust("5 seconds")
      yield* TestClock.withLive(Effect.sleep("10 millis"))
    }
    return yield* Effect.fail(new Error("The registration watch never shut the server down"))
  })
  return { fileSystem, file, stops, cleanup }
})

function serviceEnv(root: string) {
  return {
    ...process.env,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
    HOME: root,
    OPENCODE_CONFIG_DIR: undefined,
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}

async function startManagedService(prefix: string, failBoot = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const port = await availablePort()
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  if (failBoot) await fs.mkdir(path.join(root, "database"))
  await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: failBoot ? { ...serviceEnv(root), OPENCODE_DB: path.join(root, "database") } : serviceEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })
  const info = await waitForInfo(registration).catch(async (cause) => {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
    throw cause
  })
  return { root, port, registration, owner, info }
}

async function stopManagedService(service: Awaited<ReturnType<typeof startManagedService>>) {
  service.owner.kill("SIGTERM")
  await service.owner.exited
  await fs.rm(service.root, { recursive: true, force: true })
}

function waitForExit(process: Bun.Subprocess, timeout = 10_000) {
  return Promise.race([process.exited.then(() => true), Bun.sleep(timeout).then(() => false)])
}

async function expectPortAvailable(port: number) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() })
  await server.stop(true)
}
