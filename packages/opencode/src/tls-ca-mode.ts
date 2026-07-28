export type TlsCaMode = "system" | "bundled"

export type ParsedTlsCaMode = {
  mode: TlsCaMode
  argv: string[]
}

let verifiedMode: TlsCaMode | undefined

export function assertTlsCaVerified(): void {
  if (!verifiedMode) {
    throw new Error(
      "OpenCode must be started through the TLS CA bootstrap. Direct execution of index.ts is not supported.",
    )
  }
}

export function parseTlsCaMode(args: readonly string[]): ParsedTlsCaMode {
  let found: TlsCaMode | undefined
  const dropIndices = new Set<number>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") break
    if (arg === "--tlsCaMode" || arg.startsWith("--tlsCaMode=")) {
      throw new Error(`Unsupported flag: ${arg}. Use --tls-ca-mode instead.`)
    }
    if (arg === "--tls-ca-mode") {
      i++
      if (i >= args.length) throw new Error("Missing value for --tls-ca-mode")
      const val = args[i]
      if (val.startsWith("--")) throw new Error("Missing value for --tls-ca-mode")
      if (val !== "system" && val !== "bundled") throw new Error(`Unknown TLS CA mode: ${val}`)
      if (found && found !== val) throw new Error(`Conflicting TLS CA mode values: ${found} and ${val}`)
      found = val
      dropIndices.add(i - 1)
      dropIndices.add(i)
    } else if (arg.startsWith("--tls-ca-mode=")) {
      const val = arg.slice("--tls-ca-mode=".length)
      if (val !== "system" && val !== "bundled") throw new Error(`Unknown TLS CA mode: ${val}`)
      if (found && found !== val) throw new Error(`Conflicting TLS CA mode values: ${found} and ${val}`)
      found = val
      dropIndices.add(i)
    }
  }
  const mode = found ?? "system"
  const argv = args.filter((_, i) => !dropIndices.has(i))
  return { mode, argv }
}

export function isBunVirtualEntrypoint(path: string | undefined): boolean {
  return path?.startsWith("/$bunfs/") === true
}

export function makeTlsBunOptions(mode: TlsCaMode): string {
  return mode === "bundled" ? "--use-bundled-ca" : "--use-system-ca"
}

export function sourceExecArgv(mode: TlsCaMode, execArgv: readonly string[]): string[] {
  const caFlag = mode === "bundled" ? "--use-bundled-ca" : "--use-system-ca"
  const conditions = execArgv.filter((arg) => arg === "--conditions=browser")
  return [...conditions, caFlag]
}

const bundledTlsEnvironmentKeys = [
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

export function sanitizeTlsCaEnvironment(
  mode: TlsCaMode,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...env }
  if (mode === "bundled") {
    for (const key of bundledTlsEnvironmentKeys) delete result[key]
  }
  if (result.NODE_TLS_REJECT_UNAUTHORIZED === "0") delete result.NODE_TLS_REJECT_UNAUTHORIZED
  return result
}

export function tlsCaSpawnUnsetEnvironment(
  mode: TlsCaMode,
): Partial<Record<(typeof bundledTlsEnvironmentKeys)[number], undefined>> {
  if (mode === "bundled") {
    const result: Record<string, undefined> = {}
    for (const key of bundledTlsEnvironmentKeys) result[key] = undefined
    return result
  }
  return { NODE_TLS_REJECT_UNAUTHORIZED: undefined }
}

export function assertTlsCaEnvironment(mode: TlsCaMode, env: NodeJS.ProcessEnv): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(`TLS CA mode ${mode} conflicts with NODE_TLS_REJECT_UNAUTHORIZED=0`)
  }
  if (mode !== "bundled") return
  const conflicts: Array<[string, string | undefined]> = [
    ["NODE_USE_SYSTEM_CA", env.NODE_USE_SYSTEM_CA],
    ["NODE_EXTRA_CA_CERTS", env.NODE_EXTRA_CA_CERTS],
    ["SSL_CERT_FILE", env.SSL_CERT_FILE],
    ["SSL_CERT_DIR", env.SSL_CERT_DIR],
  ]
  for (const [key, val] of conflicts) {
    if (val) throw new Error(`TLS CA mode bundled conflicts with ${key}=${val}`)
  }
}

function normalizePem(text: string): string {
  const clean = text.replace(/\r/g, "")
  const begin = "-----BEGIN CERTIFICATE-----"
  const end = "-----END CERTIFICATE-----"
  const startIdx = clean.indexOf(begin)
  const endIdx = clean.lastIndexOf(end)
  if (startIdx === -1 || endIdx === -1) return clean.trim()
  const b64 = clean.slice(startIdx + begin.length, endIdx).replace(/[\s]/g, "")
  return `${begin}\n${b64}\n${end}`
}

function pemSet(certs: string[]): Set<string> {
  return new Set(certs.map(normalizePem))
}

export function verifyTlsCaMode(mode: TlsCaMode): TlsCaMode {
  const tls = require("node:tls") as {
    getCACertificates?: (kind: "default" | "bundled" | "system" | "extra") => string[]
  }
  const getCA = tls.getCACertificates
  if (!getCA) throw new Error("getCACertificates is not available")

  const execArgs = process.execArgv
  const execModes = execArgs
    .filter((a) => /^--use-(system|bundled|openssl)-ca$/.test(a))
    .map((a) => a.match(/^--use-(.+)-ca$/)![1])
  if (execModes.length === 0) throw new Error("No Bun TLS CA flag in execArgv")
  if (execModes.length > 1) throw new Error(`Conflicting Bun TLS CA flags: ${execModes.join(", ")}`)

  const expectedFlag = mode === "system" ? "system" : "bundled"
  if (execModes[0] !== expectedFlag) {
    throw new Error(`Expected Bun TLS CA flag --use-${expectedFlag}-ca but got --use-${execModes[0]}-ca`)
  }

  assertTlsCaEnvironment(mode, process.env)

  if (mode === "bundled") {
    const bundledSet = pemSet(getCA("bundled"))
    const defaultSet = pemSet(getCA("default"))
    const extraSet = pemSet(getCA("extra"))
    if (bundledSet.size === 0) throw new Error("Bundled CA set is empty")
    if (defaultSet.size === 0) throw new Error("Default CA set is empty in bundled mode")
    if (extraSet.size !== 0) throw new Error("Extra CA certificates present in bundled mode")
    if (!setEquals(defaultSet, bundledSet)) throw new Error("Default CA set does not equal bundled set in bundled mode")
  } else {
    const bundledSet = pemSet(getCA("bundled"))
    const systemSet = pemSet(getCA("system"))
    const extraSet = pemSet(getCA("extra"))
    const defaultSet = pemSet(getCA("default"))
    const expected = unionSet(bundledSet, systemSet, extraSet)
    if (!setEquals(defaultSet, expected)) throw new Error("Default CA set does not equal bundled+system+extra union in system mode")
  }

  verifiedMode = mode
  return mode
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

function unionSet(...sets: Set<string>[]): Set<string> {
  const result = new Set<string>()
  for (const s of sets) for (const v of s) result.add(v)
  return result
}

export function getTlsCaMode(): TlsCaMode {
  if (!verifiedMode) throw new Error("TLS CA mode has not been verified yet")
  return verifiedMode
}
