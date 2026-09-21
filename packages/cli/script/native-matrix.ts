import { NodeFileSystem } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { ServerInfo } from "@opencode/protocol/groups/server"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  exitsWithin,
  processRunning,
  stopOwnedProcess,
  waitForProcessExit,
  waitForReady,
  waitForRegistration,
} from "./service-smoke-process"

type Mode = "bundled" | "system"
type HttpsExpectation = "positive" | "negative"

const modes = ["bundled", "system"] as const
const tlsFixture = path.join(import.meta.dir, "..", "test", "fixture", "tls-ca-mode")
const password = "native-matrix-password"
const observationKeys = [
  "OPENCODE_TLS_CA_MODE",
  "OPENCODE_TLS_CA_BOOTSTRAPPED",
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "BUN_BE_BUN",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "OPENCODE_NATIVE_SENTINEL",
]
const certificateKeys = ["NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"]
const removedEnvironment = [
  ...observationKeys,
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_CLI_CONFIG_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
]

type Probe = {
  readonly pid: number
  readonly runtime: string
  readonly bun: string | null
  readonly node: string
  readonly argv: ReadonlyArray<string>
  readonly execArgv: ReadonlyArray<string>
  readonly mode: Mode | null
  readonly environment: Readonly<Record<string, string | null>>
  readonly certificateKeysPresent: Readonly<Record<string, boolean>>
  readonly ffi: {
    readonly available: boolean
    readonly keys: ReadonlyArray<string>
    readonly dynamicLibrary: boolean
    readonly error: unknown
  } | null
  readonly sea: boolean | null
  readonly https:
    | { readonly status: number; readonly body: string }
    | { readonly error: unknown }
    | null
}

type Observation = {
  readonly invocation: string
  readonly commandPid: number
  readonly childPid: number
  readonly runtime: string | null
  readonly applicationArgv: ReadonlyArray<string> | null
  readonly outcome: string
}

type CaseEvidence = {
  readonly case: string
  readonly invocation: string
  readonly selectedMode: Mode
  readonly reportedMode: string | undefined
  readonly spawnPid: number
  readonly listenerPid: number
  readonly pidRelationship: "same" | "recovered" | "detached"
  readonly runtime: string
  readonly applicationArgv: ReadonlyArray<string>
  readonly outcome: string
  readonly cleanup: boolean
  readonly observations?: ReadonlyArray<Observation>
}

const commandTimeout = 30_000

function cleanEnvironment(root: string, extra: Record<string, string | undefined> = {}) {
  const environment: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || removedEnvironment.includes(key)) continue
    environment[key] = value
  }
  return {
    ...environment,
    HOME: root,
    USERPROFILE: root,
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...extra,
  } satisfies Record<string, string | undefined>
}

function timeoutSignal(milliseconds = 10_000) {
  return AbortSignal.timeout(milliseconds)
}

function basicHeaders(secret = password) {
  return { authorization: "Basic " + btoa(`opencode:${secret}`) }
}

function tlsErrorMatches(value: unknown) {
  return /UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|certificate|unable to verify|UnknownIssuer/i.test(JSON.stringify(value))
}

function probePlugin(marker: string, url?: string) {
  return `import { writeFileSync } from "node:fs"

const marker = ${JSON.stringify(marker)}
const url = ${url === undefined ? "undefined" : JSON.stringify(url)}
const observationKeys = ${JSON.stringify(observationKeys)}
const certificateKeys = ${JSON.stringify(certificateKeys)}

function details(error, depth = 0) {
  if (depth >= 3 || !(error instanceof Error)) return String(error)
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    cause: error.cause === undefined ? null : details(error.cause, depth + 1),
    errors: Array.isArray(error.errors) ? error.errors.map((entry) => details(entry, depth + 1)) : null,
  }
}

let claimed = true
try {
  writeFileSync(marker, "", { flag: "wx" })
} catch {
  claimed = false
}

if (claimed) {
  let ffi = null
  try {
    const module = process.getBuiltinModule?.("node:ffi")
    ffi = module
      ? {
          available: true,
          keys: Object.keys(module).sort(),
          dynamicLibrary: typeof module.DynamicLibrary === "function",
          error: null,
        }
      : { available: false, keys: [], dynamicLibrary: false, error: null }
  } catch (error) {
    ffi = { available: false, keys: [], dynamicLibrary: false, error: details(error) }
  }
  const sea = process.getBuiltinModule?.("node:sea")
  const record = {
    pid: process.pid,
    runtime: process.versions.bun ? "bun/" + process.versions.bun : "node/" + process.versions.node,
    bun: process.versions.bun ?? null,
    node: process.versions.node,
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
    mode: process.env.OPENCODE_TLS_CA_MODE ?? null,
    environment: Object.fromEntries(
      observationKeys.map((key) => [key, Object.hasOwn(process.env, key) ? process.env[key] ?? null : null]),
    ),
    certificateKeysPresent: Object.fromEntries(certificateKeys.map((key) => [key, Object.hasOwn(process.env, key)])),
    ffi,
    sea: typeof sea?.isSea === "function" ? sea.isSea() : null,
    https: null,
  }
  if (url !== undefined) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      record.https = { status: response.status, body: await response.text() }
    } catch (error) {
      record.https = { error: details(error) }
    }
  }
  writeFileSync(marker, JSON.stringify(record))
}

export default { id: "native-probe", setup: async () => {} }
`
}

async function installProbe(root: string, marker: string, url?: string) {
  await fs.mkdir(path.join(root, ".opencode", "plugins"), { recursive: true })
  await fs.writeFile(path.join(root, ".opencode", "plugins", "native-probe.ts"), probePlugin(marker, url))
}

async function decodeRegistration(file: string) {
  try {
    return await Schema.decodeUnknownPromise(Service.Info)(await Bun.file(file).json())
  } catch {
    return undefined
  }
}

async function findRegistration(root: string) {
  const directory = path.join(root, "state", "opencode")
  const files = (await fs.readdir(directory).catch(() => [])).filter(
    (file) => file === "service.json" || (file.startsWith("service-") && file.endsWith(".json")),
  )
  const file = files[0]
  return file === undefined ? undefined : path.join(directory, file)
}

async function publishedRegistration(root: string) {
  const file = await waitForRegistration(path.join(root, "state", "opencode"))
  const info = await decodeRegistration(file)
  if (info === undefined) throw new Error(`Published registration ${file} failed ServerInfo validation`)
  return { file, info }
}

async function waitForFileGone(file: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!(await Bun.file(file).exists())) return true
    await Bun.sleep(25)
  }
  return !(await Bun.file(file).exists())
}

async function stopChildHandle(child: Bun.Subprocess, timeout = 10_000) {
  if (child.exitCode !== null) return true
  try {
    child.kill("SIGTERM")
  } catch {
    return child.exitCode !== null
  }
  if (await exitsWithin(child, timeout)) return true
  try {
    child.kill("SIGKILL")
  } catch {
    return child.exitCode !== null
  }
  return exitsWithin(child, 2_000)
}

async function stopPublishedService(
  root: string,
  registration: string | undefined,
  listener: number | undefined,
) {
  const failures: string[] = []
  let file = registration
  if (file === undefined) {
    file = await findRegistration(root)
    if (file === undefined) file = await waitForRegistration(path.join(root, "state", "opencode"), 5_000).catch(() => undefined)
  }
  let stopped = listener
  if (file !== undefined) {
    const info = await decodeRegistration(file)
    if (info !== undefined) stopped ??= info.pid
    try {
      await Effect.runPromise(Service.stop({ file }).pipe(Effect.provide(NodeFileSystem.layer)))
    } catch (cause) {
      failures.push(`Service.stop failed for ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    if (!(await waitForFileGone(file))) failures.push(`Owned registration ${file} was not removed`)
  }
  if (stopped !== undefined && !(await stopOwnedProcess(stopped)))
    failures.push(`Owned service process ${stopped} did not exit`)
  return { failures, listener: stopped }
}

async function waitForProbe(url: string, headers: HeadersInit, root: string, marker: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const endpoint = new URL("/api/plugin", url)
    endpoint.searchParams.set("location[directory]", root)
    const response = await fetch(endpoint, { headers, signal: timeoutSignal(2_000) }).catch(() => undefined)
    if (response?.ok && (await Bun.file(marker).exists())) {
      const record = (await Bun.file(marker)
        .json()
        .catch(() => undefined)) as Probe | undefined
      if (record !== undefined && typeof record.pid === "number" && "https" in record) return record
    }
    await Bun.sleep(50)
  }
  throw new Error("The artifact never activated the native probe plugin")
}

async function freshRoot(prefix: string) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

async function freePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("No test port was allocated")
  return port
}

async function fileHash(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")
}

async function runCommand(
  binary: string,
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
  cwd: string,
) {
  const child = Bun.spawn([binary, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const invocation = `${path.basename(binary)} ${args.join(" ")}`
  if (!(await exitsWithin(child, commandTimeout))) {
    try {
      child.kill("SIGTERM")
    } catch {}
    let exited = await exitsWithin(child, 5_000)
    if (!exited) {
      try {
        child.kill("SIGKILL")
      } catch {}
      exited = await exitsWithin(child, 2_000)
    }
    if (!exited) exited = await stopOwnedProcess(child.pid, 1_000)
    if (!exited) throw new Error(`Command timed out and its owned process ${child.pid} survived cleanup: ${invocation}`)
    const [out, err] = await Promise.all([stdout, stderr])
    throw new Error(`Command timed out after ${commandTimeout}ms: ${invocation}\nstdout:\n${out}\nstderr:\n${err}`)
  }
  const [out, err] = await Promise.all([stdout, stderr])
  return { pid: child.pid, exitCode: child.exitCode, stdout: out, stderr: err }
}

async function locateServiceConfig(root: string) {
  const directory = path.join(root, "config", "opencode")
  const files = (await fs.readdir(directory).catch(() => [])).filter(
    (file) => file === "service.json" || (file.startsWith("service-") && file.endsWith(".json")),
  )
  const file = files[0]
  if (file === undefined) throw new Error(`The artifact did not create a service configuration in ${directory}`)
  return path.join(directory, file)
}

async function savedHostileEnvironment(root: string, mode: Mode) {
  const certDirectory = path.join(root, "saved-certificates")
  await fs.mkdir(certDirectory, { recursive: true })
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
          SSL_CERT_DIR: certDirectory,
        }
      : {
          NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem"),
          SSL_CERT_DIR: certDirectory,
        }),
    OPENCODE_NATIVE_SENTINEL: "saved-sentinel",
  }
}

function assertProbeInvariants(
  probe: Probe,
  mode: Mode,
  applicationArgv: ReadonlyArray<string>,
  nodeBuild: boolean,
) {
  if (probe.mode !== mode) throw new Error(`Probe reported ${probe.mode}, expected ${mode}`)
  if (JSON.stringify(probe.argv) !== JSON.stringify(applicationArgv))
    throw new Error(`Probe argv ${JSON.stringify(probe.argv)} did not match ${JSON.stringify(applicationArgv)}`)
  if (probe.execArgv.some((argument) => argument.startsWith("--tls-ca-mode")))
    throw new Error("The recovered runtime replayed a TLS CA selector in execArgv")
  if (nodeBuild) {
    if (probe.sea !== true) throw new Error("The running Node artifact is not a SEA executable")
    if (!probe.runtime.startsWith("node/")) throw new Error(`Unexpected Node runtime identity ${probe.runtime}`)
    if (!probe.ffi?.available || !probe.ffi.dynamicLibrary)
      throw new Error("The recovered Node artifact cannot use the required node:ffi DynamicLibrary API")
    if (!probe.execArgv.includes("--experimental-ffi"))
      throw new Error("The recovered Node artifact lost its baked --experimental-ffi")
    if (!probe.execArgv.includes("--use-bundled-ca"))
      throw new Error("The recovered Node artifact lost its baked --use-bundled-ca")
  } else if (!probe.runtime.startsWith("bun/")) {
    throw new Error(`Unexpected Bun runtime identity ${probe.runtime}`)
  }
  if (probe.environment.OPENCODE_TLS_CA_BOOTSTRAPPED !== null)
    throw new Error("The executing artifact retained the bootstrap marker")
  if (probe.environment.BUN_OPTIONS !== null) throw new Error("The executing artifact retained BUN_OPTIONS")
  if (probe.environment.NODE_OPTIONS !== null) throw new Error("The executing artifact retained NODE_OPTIONS")
  if (probe.environment.BUN_BE_BUN !== null) throw new Error("The executing artifact retained BUN_BE_BUN")
  if (probe.environment.NODE_TLS_REJECT_UNAUTHORIZED !== null)
    throw new Error("The executing artifact retained disabled certificate verification")
}

if (import.meta.main) {
  const binary = process.argv[2]
  if (!binary) throw new Error("Usage: bun script/native-matrix.ts <artifact> [--node]")
  await runNativeMatrix(binary, process.argv.includes("--node"))
}

export async function runNativeMatrix(binary: string, nodeBuild: boolean) {
  const artifact = path.resolve(binary)
  const sha256 = await fileHash(artifact)
  const cert = await Bun.file(path.join(tlsFixture, "server.pem")).text()
  const key = await Bun.file(path.join(tlsFixture, "server.key")).text()
  const rootPem = await Bun.file(path.join(tlsFixture, "root.pem")).text()
  let handled = 0
  const https = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch() {
      handled++
      return new Response("ok")
    },
  })
  const httpsUrl = `https://localhost:${https.port}`
  const evidence: CaseEvidence[] = []
  const roots: string[] = []

  async function positiveControl() {
    const response = await fetch(httpsUrl, { tls: { ca: rootPem }, signal: timeoutSignal(5_000) })
    if (response.status !== 200 || (await response.text()) !== "ok") throw new Error("Controlled HTTPS control failed")
    if (handled !== 1) throw new Error(`Controlled HTTPS control handled ${handled} requests, expected 1`)
    handled = 0
  }

  async function foreground(
    name: string,
    selectedMode: Mode,
    selector: Mode | undefined,
    ambient: Record<string, string | undefined>,
    options: { readonly recovered?: boolean; readonly https?: HttpsExpectation } = {},
  ) {
    const root = await freshRoot(`opencode-native-${name}-`)
    roots.push(root)
    const port = await freePort()
    const marker = path.join(root, "probe.json")
    await installProbe(root, marker, options.https === undefined ? undefined : httpsUrl)
    if (options.https === "negative") await positiveControl()
    const applicationArgv = ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
    const args = [...(selector === undefined ? [] : [`--tls-ca-mode=${selector}`]), ...applicationArgv]
    const env = cleanEnvironment(root, { OPENCODE_SERVER_PASSWORD: password, ...ambient })
    const child = Bun.spawn([artifact, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    let listener: number | undefined
    let record: Omit<CaseEvidence, "cleanup"> | undefined
    let failure: unknown
    try {
      const headers = basicHeaders()
      const info = await waitForReady(`http://127.0.0.1:${port}`, headers)
      listener = info.pid
      if (info.tlsCaMode !== selectedMode)
        throw new Error(`Reported ${String(info.tlsCaMode)} instead of ${selectedMode}`)
      if (options.recovered ? listener === child.pid : listener !== child.pid)
        throw new Error(`Unexpected listener PID relationship for ${name}: spawned ${child.pid}, listener ${listener}`)
      const unauthorized = await fetch(new URL("/api/info", `http://127.0.0.1:${port}`), {
        signal: timeoutSignal(5_000),
      })
      if (unauthorized.status !== 401) throw new Error(`Unauthenticated info returned ${unauthorized.status}`)
      const probe = await waitForProbe(`http://127.0.0.1:${port}`, headers, root, marker)
      if (probe.pid !== listener) throw new Error("The probe plugin ran in a different process than the listener")
      assertProbeInvariants(probe, selectedMode, applicationArgv, nodeBuild)
      if (probe.environment.OPENCODE_TLS_CA_MODE !== selectedMode)
        throw new Error(`Probe environment mode ${String(probe.environment.OPENCODE_TLS_CA_MODE)}`)
      if (selectedMode === "bundled") {
        for (const certificate of certificateKeys) {
          if (probe.certificateKeysPresent[certificate] !== false)
            throw new Error(`Bundled probe retained ${certificate}`)
        }
      }
      let outcome = "mode, authentication, probe and argv verified"
      if (options.https === "positive") {
        if (probe.https === null || "error" in probe.https) throw new Error("Expected the probe HTTPS request to succeed")
        if (probe.https.status !== 200 || probe.https.body !== "ok")
          throw new Error(`Probe HTTPS returned ${probe.https.status} ${probe.https.body}`)
        if (handled !== 1) throw new Error(`Positive HTTPS case handled ${handled} requests, expected 1`)
        handled = 0
        outcome += "; controlled HTTPS succeeded once"
      }
      if (options.https === "negative") {
        if (probe.https === null || !("error" in probe.https)) throw new Error("Expected the probe HTTPS request to fail")
        if (!tlsErrorMatches(probe.https.error)) throw new Error("Probe failure was not a certificate rejection")
        if (handled !== 0) throw new Error(`Rejected HTTPS case reached the handler ${handled} times`)
        outcome += "; controlled HTTPS rejected before handling"
      }
      record = {
        case: name,
        invocation: `${path.basename(artifact)} ${args.join(" ")}`,
        selectedMode,
        reportedMode: info.tlsCaMode,
        spawnPid: child.pid,
        listenerPid: listener,
        pidRelationship: options.recovered ? "recovered" : "same",
        runtime: probe.runtime,
        applicationArgv: probe.argv as string[],
        outcome,
      }
    } catch (cause) {
      failure = cause
    }

    const failures: string[] = []
    if (listener !== undefined && listener !== child.pid && !(await stopOwnedProcess(listener)))
      failures.push(`Owned listener ${listener} did not exit`)
    if (!(await stopChildHandle(child, listener === child.pid ? 10_000 : 5_000)))
      failures.push(`Owned spawned process ${child.pid} did not exit`)
    const [out, err] = await Promise.all([stdout, stderr])
    if (failures.length) {
      roots.splice(roots.indexOf(root), 1)
      throw new Error(
        `${name} cleanup failed: ${failures.join("; ")}${failure === undefined ? "" : `\noriginal failure: ${String(failure)}`}\nstdout:\n${out}\nstderr:\n${err}\nretained root: ${root}`,
        { cause: failure ?? undefined },
      )
    }
    if (failure !== undefined) {
      await fs.rm(root, { recursive: true, force: true })
      roots.splice(roots.indexOf(root), 1)
      throw new Error(
        `${name} failed (spawn ${child.pid}, listener ${String(listener)})\nstdout:\n${out}\nstderr:\n${err}`,
        { cause: failure },
      )
    }
    await fs.rm(root, { recursive: true, force: true })
    roots.splice(roots.indexOf(root), 1)
    evidence.push({ ...record!, cleanup: true })
  }

  async function managed(mode: Mode, httpsExpectation: HttpsExpectation) {
    const name = `managed-${mode}`
    const root = await freshRoot(`opencode-native-${name}-`)
    roots.push(root)
    const port = await freePort()
    const config = await runCommand(
      artifact,
      ["service", "set", "port", String(port)],
      cleanEnvironment(root),
      root,
    )
    if (config.exitCode !== 0) throw new Error(`service set port failed: ${config.stderr}`)
    const configFile = await locateServiceConfig(root)
    const saved = JSON.parse(await fs.readFile(configFile, "utf8"))
    const hostile = await savedHostileEnvironment(root, mode)
    const persisted = { ...saved, env: hostile }
    await fs.writeFile(configFile, JSON.stringify(persisted))
    const marker = path.join(root, "probe.json")
    await installProbe(root, marker, httpsUrl)
    if (httpsExpectation === "negative") await positiveControl()
    let listener: number | undefined
    let registration: string | undefined
    let startPID: number | undefined
    let stdout = ""
    let stderr = ""
    let record: Omit<CaseEvidence, "cleanup"> | undefined
    let failure: unknown
    try {
      const start = await runCommand(
        artifact,
        [`--tls-ca-mode=${mode}`, "service", "start"],
        cleanEnvironment(root),
        root,
      )
      startPID = start.pid
      stdout = start.stdout
      stderr = start.stderr
      if (start.exitCode !== 0) throw new Error(`service start exited ${start.exitCode}: ${stderr}`)
      const published = await publishedRegistration(root)
      registration = published.file
      listener = published.info.pid
      if (listener === start.pid) throw new Error("The managed listener was the short-lived service start command")
      if (!processRunning(listener)) throw new Error("The managed listener did not outlive service start")
      if (new URL(published.info.url).port !== String(port)) throw new Error("Managed service ignored the saved port")
      const headers = basicHeaders(published.info.password)
      const info = await waitForReady(published.info.url, headers)
      if (info.pid !== listener) throw new Error("Registration and authenticated info disagree on the listener PID")
      if (info.tlsCaMode !== mode) throw new Error(`Managed service reported ${String(info.tlsCaMode)} instead of ${mode}`)
      const probe = await waitForProbe(published.info.url, headers, root, marker)
      if (probe.pid !== listener) throw new Error("The managed probe plugin ran in a different process")
      assertProbeInvariants(probe, mode, ["serve", "--service"], nodeBuild)
      if (probe.environment.OPENCODE_NATIVE_SENTINEL !== "saved-sentinel")
        throw new Error("Unrelated saved environment was not applied")
      if (probe.environment.OPENCODE_TLS_CA_MODE !== mode)
        throw new Error(`The saved selector overrode the verified mode: ${String(probe.environment.OPENCODE_TLS_CA_MODE)}`)
      if (mode === "bundled") {
        for (const certificate of certificateKeys) {
          if (probe.certificateKeysPresent[certificate] !== false)
            throw new Error(`Managed bundled child retained ${certificate}`)
        }
      } else {
        if (probe.environment.NODE_EXTRA_CA_CERTS !== path.join(tlsFixture, "root.pem"))
          throw new Error("Managed system child lost the controlled extra CA")
        if (probe.environment.SSL_CERT_DIR !== path.join(root, "saved-certificates"))
          throw new Error("Managed system child lost the permitted certificate directory")
      }
      let outcome = "saved hostile environment filtered before and after attestation"
      if (httpsExpectation === "positive") {
        if (probe.https === null || "error" in probe.https) throw new Error("Expected the probe HTTPS request to succeed")
        if (probe.https.status !== 200 || probe.https.body !== "ok")
          throw new Error(`Probe HTTPS returned ${probe.https.status} ${probe.https.body}`)
        if (handled !== 1) throw new Error(`Positive HTTPS case handled ${handled} requests, expected 1`)
        handled = 0
        outcome += "; controlled HTTPS succeeded once"
      } else {
        if (probe.https === null || !("error" in probe.https)) throw new Error("Expected the probe HTTPS request to fail")
        if (!tlsErrorMatches(probe.https.error)) throw new Error("Probe failure was not a certificate rejection")
        if (handled !== 0) throw new Error(`Rejected HTTPS case reached the handler ${handled} times`)
        outcome += "; controlled HTTPS rejected before handling"
      }
      const onDisk = JSON.parse(await fs.readFile(configFile, "utf8"))
      for (const [key, value] of Object.entries(hostile)) {
        if (onDisk.env?.[key] !== value) throw new Error(`Saved service configuration changed ${key}`)
      }
      record = {
        case: name,
        invocation: `${path.basename(artifact)} --tls-ca-mode=${mode} service start`,
        selectedMode: mode,
        reportedMode: info.tlsCaMode,
        spawnPid: start.pid,
        listenerPid: listener,
        pidRelationship: "detached",
        runtime: probe.runtime,
        applicationArgv: probe.argv as string[],
        outcome,
      }
    } catch (cause) {
      failure = cause
    }

    const cleanup = await stopPublishedService(root, registration, listener)
    if (startPID !== undefined && startPID !== listener && !(await stopOwnedProcess(startPID, 5_000)))
      cleanup.failures.push(`Owned service start process ${startPID} did not exit`)
    if (cleanup.failures.length) {
      roots.splice(roots.indexOf(root), 1)
      throw new Error(
        `${name} cleanup failed: ${cleanup.failures.join("; ")}${failure === undefined ? "" : `\noriginal failure: ${String(failure)}`}\nstdout:\n${stdout}\nstderr:\n${stderr}\nretained root: ${root}`,
        { cause: failure ?? undefined },
      )
    }
    if (failure !== undefined) {
      await fs.rm(root, { recursive: true, force: true })
      roots.splice(roots.indexOf(root), 1)
      throw new Error(
        `${name} failed (start ${String(startPID)}, listener ${String(listener)})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        { cause: failure },
      )
    }
    await fs.rm(root, { recursive: true, force: true })
    roots.splice(roots.indexOf(root), 1)
    evidence.push({ ...record!, cleanup: true })
  }

  async function direct(mode: Mode) {
    const name = `direct-service-${mode}`
    const root = await freshRoot(`opencode-native-${name}-`)
    roots.push(root)
    const port = await freePort()
    const config = await runCommand(
      artifact,
      ["service", "set", "port", String(port)],
      cleanEnvironment(root),
      root,
    )
    if (config.exitCode !== 0) throw new Error(`service set port failed: ${config.stderr}`)
    const configFile = await locateServiceConfig(root)
    const saved = JSON.parse(await fs.readFile(configFile, "utf8"))
    const hostile = await savedHostileEnvironment(root, mode)
    await fs.writeFile(configFile, JSON.stringify({ ...saved, env: hostile }))
    const marker = path.join(root, "probe.json")
    await installProbe(root, marker, httpsUrl)
    await positiveControl()
    const owner = Bun.spawn([artifact, `--tls-ca-mode=${mode}`, "serve", "--service"], {
      cwd: root,
      env: cleanEnvironment(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = new Response(owner.stdout).text()
    const stderr = new Response(owner.stderr).text()
    let registration: string | undefined
    let listener: number | undefined
    let record: Omit<CaseEvidence, "cleanup"> | undefined
    let failure: unknown
    try {
      const published = await publishedRegistration(root)
      registration = published.file
      listener = published.info.pid
      if (listener !== owner.pid) throw new Error("Direct service launch recovered instead of attesting in place")
      const headers = basicHeaders(published.info.password)
      const info = await waitForReady(published.info.url, headers)
      if (info.tlsCaMode !== mode) throw new Error(`Direct service reported ${String(info.tlsCaMode)} instead of ${mode}`)
      const probe = await waitForProbe(published.info.url, headers, root, marker)
      if (probe.pid !== owner.pid) throw new Error("The direct service probe ran in a different process")
      assertProbeInvariants(probe, mode, ["serve", "--service"], nodeBuild)
      if (probe.environment.OPENCODE_NATIVE_SENTINEL !== "saved-sentinel")
        throw new Error("Direct service did not apply unrelated saved environment")
      for (const certificate of certificateKeys) {
        if (probe.certificateKeysPresent[certificate] !== false)
          throw new Error(`Direct service reapplied saved ${certificate} after attestation`)
      }
      if (probe.https === null || !("error" in probe.https))
        throw new Error("Direct service trusted a saved CA that was never part of its verified launch")
      if (!tlsErrorMatches(probe.https.error))
        throw new Error("Direct service HTTPS failure was not a certificate rejection")
      if (handled !== 0) throw new Error(`Direct service rejected HTTPS reached the handler ${handled} times`)
      record = {
        case: name,
        invocation: `${path.basename(artifact)} --tls-ca-mode=${mode} serve --service`,
        selectedMode: mode,
        reportedMode: info.tlsCaMode,
        spawnPid: owner.pid,
        listenerPid: listener,
        pidRelationship: "same",
        runtime: probe.runtime,
        applicationArgv: probe.argv as string[],
        outcome: "post-attestation saved environment filter removed TLS inputs and preserved unrelated settings",
      }
    } catch (cause) {
      failure = cause
    }

    const cleanup = await stopPublishedService(root, registration, listener)
    if (!(await stopChildHandle(owner, 5_000)))
      cleanup.failures.push(`Owned direct service process ${owner.pid} did not exit`)
    const [out, err] = await Promise.all([stdout, stderr])
    if (cleanup.failures.length) {
      roots.splice(roots.indexOf(root), 1)
      throw new Error(
        `${name} cleanup failed: ${cleanup.failures.join("; ")}${failure === undefined ? "" : `\noriginal failure: ${String(failure)}`}\nstdout:\n${out}\nstderr:\n${err}\nretained root: ${root}`,
        { cause: failure ?? undefined },
      )
    }
    if (failure !== undefined) {
      await fs.rm(root, { recursive: true, force: true })
      roots.splice(roots.indexOf(root), 1)
      throw new Error(
        `${name} failed (owner ${owner.pid}, listener ${String(listener)})\nstdout:\n${out}\nstderr:\n${err}`,
        { cause: failure },
      )
    }
    await fs.rm(root, { recursive: true, force: true })
    roots.splice(roots.indexOf(root), 1)
    evidence.push({ ...record!, cleanup: true })
  }

  async function standalone(mode: Mode) {
    const name = `standalone-${mode}`
    const root = await freshRoot(`opencode-native-${name}-`)
    roots.push(root)
    const disabled = await runCommand(artifact, ["service", "set", "disabled", "true"], cleanEnvironment(root), root)
    if (disabled.exitCode !== 0) throw new Error(`service set disabled failed: ${disabled.stderr}`)
    const configFile = await locateServiceConfig(root)
    const saved = JSON.parse(await fs.readFile(configFile, "utf8"))
    const hostile = await savedHostileEnvironment(root, mode)
    const persisted = { ...saved, env: hostile }
    await fs.writeFile(configFile, JSON.stringify(persisted))
    const marker = path.join(root, "probe.json")
    await installProbe(root, marker)

    let listener: number | undefined
    let probePID: number | undefined
    let record: Omit<CaseEvidence, "cleanup"> | undefined
    let failure: unknown
    let infoCommand:
      | { readonly pid: number; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }
      | undefined
    let pluginCommand:
      | { readonly pid: number; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }
      | undefined
    try {
      infoCommand = await runCommand(
        artifact,
        [`--tls-ca-mode=${mode}`, "api", "get", "/api/info"],
        cleanEnvironment(root),
        root,
      )
      if (infoCommand.exitCode !== 0)
        throw new Error(`standalone api exited ${infoCommand.exitCode}: ${infoCommand.stderr}`)
      const body = await Schema.decodeUnknownPromise(ServerInfo)(JSON.parse(infoCommand.stdout))
      listener = body.pid
      if (body.tlsCaMode !== mode) throw new Error(`Standalone reported ${String(body.tlsCaMode)} instead of ${mode}`)
      if (listener === infoCommand.pid) throw new Error("Standalone request ran in the command process, not a private child")
      if (!Array.isArray(body.urls) || body.urls.length !== 1) throw new Error("Standalone info named no endpoint")
      const stateFiles = await fs.readdir(path.join(root, "state", "opencode")).catch(() => [])
      if (stateFiles.some((file) => file === "service.json" || (file.startsWith("service-") && file.endsWith(".json"))))
        throw new Error("Standalone resolution created a managed registration")
      if (!(await waitForProcessExit(listener)))
        throw new Error("The private standalone server outlived its command lease")

      pluginCommand = await runCommand(
        artifact,
        [`--tls-ca-mode=${mode}`, "api", "get", "/api/provider?location[directory]=" + encodeURIComponent(root)],
        cleanEnvironment(root),
        root,
      )
      if (pluginCommand.exitCode !== 0)
        throw new Error(`standalone plugin probe exited ${pluginCommand.exitCode}: ${pluginCommand.stderr}`)
      const probe = (await Bun.file(marker).json()) as Probe
      probePID = probe.pid
      if (!(await waitForProcessExit(probePID))) throw new Error("The probe standalone server outlived its command lease")
      assertProbeInvariants(probe, mode, ["serve", "--stdio", "--port", "0"], nodeBuild)
      if (probe.environment.OPENCODE_NATIVE_SENTINEL !== null)
        throw new Error("Standalone child consumed saved managed-service environment")
      if (probe.environment.OPENCODE_TLS_CA_MODE !== mode)
        throw new Error("Standalone child did not inherit the parent's verified mode")
      for (const key of ["BUN_OPTIONS", "NODE_OPTIONS", "BUN_BE_BUN", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
        if (probe.environment[key] !== null) throw new Error(`Standalone child retained ${key}`)
      }
      for (const certificate of certificateKeys) {
        if (probe.certificateKeysPresent[certificate] !== false)
          throw new Error(`Standalone ${mode} child inherited saved managed-service CA input ${certificate}`)
      }
      const onDisk = JSON.parse(await fs.readFile(configFile, "utf8"))
      for (const [key, value] of Object.entries(hostile)) {
        if (onDisk.env?.[key] !== value) throw new Error(`Standalone changed saved configuration ${key}`)
      }
      record = {
        case: name,
        invocation: `${path.basename(artifact)} --tls-ca-mode=${mode} api get /api/provider?...`,
        selectedMode: mode,
        reportedMode: body.tlsCaMode,
        spawnPid: pluginCommand.pid,
        listenerPid: probe.pid,
        pidRelationship: "detached",
        runtime: probe.runtime,
        applicationArgv: probe.argv as string[],
        outcome:
          "two independent leases: authenticated info and executing plugin probe each started a private server with the parent's verified mode; no registration",
        observations: [
          {
            invocation: `${path.basename(artifact)} --tls-ca-mode=${mode} api get /api/info`,
            commandPid: infoCommand.pid,
            childPid: listener,
            runtime: null,
            applicationArgv: null,
            outcome: `authenticated mode ${String(body.tlsCaMode)}; private child exited with its lease`,
          },
          {
            invocation: `${path.basename(artifact)} --tls-ca-mode=${mode} api get /api/provider?...`,
            commandPid: pluginCommand.pid,
            childPid: probe.pid,
            runtime: probe.runtime,
            applicationArgv: probe.argv as string[],
            outcome: "executing runtime, argv and saved-environment isolation verified; private child exited with its lease",
          },
        ],
      }
    } catch (cause) {
      failure = cause
    }

    const failures: string[] = []
    if (listener !== undefined && !(await stopOwnedProcess(listener)))
      failures.push(`Owned info-lease child ${listener} did not exit`)
    if (probePID !== undefined && probePID !== listener && !(await stopOwnedProcess(probePID)))
      failures.push(`Owned plugin-lease child ${probePID} did not exit`)
    if (failures.length) {
      roots.splice(roots.indexOf(root), 1)
      throw new Error(
        `${name} cleanup failed: ${failures.join("; ")}${failure === undefined ? "" : `\noriginal failure: ${String(failure)}`}\nretained root: ${root}`,
        { cause: failure ?? undefined },
      )
    }
    if (failure !== undefined) {
      await fs.rm(root, { recursive: true, force: true })
      roots.splice(roots.indexOf(root), 1)
      const out = await fs.readFile(marker, "utf8").catch(() => "")
      throw new Error(
        `${name} failed (info ${String(infoCommand?.pid)}, plugin ${String(pluginCommand?.pid)}, listener ${String(listener)}, probe ${String(probePID)})\nprobe:\n${out}`,
        { cause: failure },
      )
    }
    await fs.rm(root, { recursive: true, force: true })
    roots.splice(roots.indexOf(root), 1)
    evidence.push({ ...record!, cleanup: true })
  }

  try {
    for (const scenario of [
      { name: "clean-default", selected: "bundled" as const, selector: undefined, ambient: {} },
      {
        name: "ambient-system",
        selected: "bundled" as const,
        selector: undefined,
        ambient: { OPENCODE_TLS_CA_MODE: "system" },
      },
      {
        name: "ambient-invalid",
        selected: "bundled" as const,
        selector: undefined,
        ambient: { OPENCODE_TLS_CA_MODE: "openssl" },
      },
      { name: "explicit-bundled", selected: "bundled" as const, selector: "bundled" as const, ambient: {} },
      { name: "explicit-system", selected: "system" as const, selector: "system" as const, ambient: {} },
    ]) {
      await foreground(scenario.name, scenario.selected, scenario.selector, scenario.ambient)
    }

    for (const mode of modes) await managed(mode, mode === "system" ? "positive" : "negative")
    for (const mode of modes) await direct(mode)

    await foreground(
      "recovered-system",
      "system",
      "system",
      { NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem") },
      { recovered: true, https: "positive" },
    )

    for (const mode of modes) await standalone(mode)

    const finalHash = await fileHash(artifact)
    if (finalHash !== sha256)
      throw new Error(`Artifact changed during the native matrix: ${sha256} -> ${finalHash}`)
    for (const entry of evidence) console.log(`NATIVE_CASE ${JSON.stringify({ artifact, sha256, nodeBuild, ...entry })}`)
    console.log(`NATIVE_MATRIX ${JSON.stringify({ artifact, sha256: finalHash, nodeBuild, cases: evidence.length })}`)
  } finally {
    https.stop(true)
    for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
