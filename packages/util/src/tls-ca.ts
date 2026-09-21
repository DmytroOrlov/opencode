import tls from "node:tls"

export type TlsCaMode = "bundled" | "system"

export type ParsedTlsCaMode = {
  readonly mode: TlsCaMode
  readonly argv: string[]
}

let verifiedMode: TlsCaMode | undefined

export function parseTlsCaMode(args: readonly string[], fallback = "bundled"): ParsedTlsCaMode {
  let found: TlsCaMode | undefined
  const omitted = new Set<number>()

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--") break
    if (arg === "--tlsCaMode" || arg.startsWith("--tlsCaMode="))
      throw new Error(`Unsupported flag: ${arg}. Use --tls-ca-mode instead.`)
    if (arg === "--tls-ca-mode") {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) throw new Error("Missing value for --tls-ca-mode")
      index++
      omitted.add(index - 1)
      omitted.add(index)
      found = selectMode(found, value)
      continue
    }
    if (!arg.startsWith("--tls-ca-mode=")) continue
    omitted.add(index)
    found = selectMode(found, arg.slice("--tls-ca-mode=".length))
  }

  return { mode: found ?? selectMode(undefined, fallback), argv: args.filter((_, index) => !omitted.has(index)) }
}

export function replaceTlsCaFlags(mode: TlsCaMode, args: readonly string[]) {
  const caFlags = new Set(["--use-bundled-ca", "--use-system-ca", "--use-openssl-ca"])
  return [...args.filter((arg) => !caFlags.has(arg)), tlsCaFlag(mode)]
}

export function sanitizeTlsCaEnvironment(mode: TlsCaMode, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const certificateEnvironment = ["NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"]
  const result = { ...env }
  result.OPENCODE_TLS_CA_MODE = mode
  if (mode === "bundled") for (const key of certificateEnvironment) delete result[key]
  if (result.NODE_TLS_REJECT_UNAUTHORIZED === "0") delete result.NODE_TLS_REJECT_UNAUTHORIZED
  delete result.BUN_OPTIONS
  delete result.NODE_OPTIONS

  return result
}

export function isNodeSea() {
  if (process.versions.bun) return false
  const sea: unknown = process.getBuiltinModule?.("node:sea")
  if (typeof sea !== "object" || sea === null || !("isSea" in sea)) return process.argv[1] === process.execPath
  return typeof sea.isSea === "function" && sea.isSea()
}

export function verifyTlsCaMode(mode: TlsCaMode): TlsCaMode {
  const certificateEnvironment = ["NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"]
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS certificate verification is disabled by NODE_TLS_REJECT_UNAUTHORIZED=0")

  const getCA = tls.getCACertificates
  if (typeof getCA !== "function") throw new Error("Effective TLS CA verification is unavailable")

  const bundled = pemSet(getCA("bundled"))
  const system = pemSet(getCA("system"))
  const extra = pemSet(getCA("extra"))

  // Packaged Bun and Node standalone executables keep their runtime CA policy
  // in the artifact. Set the requested trust set through the TLS API, then
  // attest the resulting effective default set below.
  if (
    (process.versions.bun && process.argv[1]?.startsWith("/$bunfs/")) ||
    isNodeSea()
  ) {
    tls.setDefaultCACertificates(
      mode === "bundled" ? getCA("bundled") : [...new Set([...getCA("bundled"), ...getCA("system"), ...getCA("extra")])],
    )
  }

  const defaults = pemSet(getCA("default"))
  if (bundled.size === 0) throw new Error("Bundled CA set is empty")
  if (defaults.size === 0) throw new Error("Effective default CA set is empty")

  if (mode === "bundled") {
    if (extra.size !== 0 || certificateEnvironment.some((key) => process.env[key]))
      throw new Error("Bundled TLS CA mode includes ambient certificate overrides")
    if (!setEquals(defaults, bundled)) throw new Error("Effective default CA set does not equal bundled CA set")
  }

  if (mode === "system" && !setEquals(defaults, union(bundled, system, extra)))
    throw new Error("Effective default CA set does not equal bundled, system, and extra CA union")

  verifiedMode = mode
  return mode
}

export function getVerifiedTlsCaMode(): TlsCaMode {
  if (!verifiedMode) throw new Error("TLS CA mode has not been verified")
  return verifiedMode
}

export function assertTlsCaVerified() {
  getVerifiedTlsCaMode()
}

export const getTlsCaMode = getVerifiedTlsCaMode

export function tlsCaFlag(mode: TlsCaMode) {
  return mode === "system" ? "--use-system-ca" : "--use-bundled-ca"
}

function selectMode(previous: TlsCaMode | undefined, value: string): TlsCaMode {
  if (value !== "bundled" && value !== "system") throw new Error(`Unknown TLS CA mode: ${value}`)
  if (previous && previous !== value) throw new Error(`Conflicting TLS CA mode values: ${previous} and ${value}`)
  return value
}

function normalizePem(value: string) {
  const clean = value.replace(/\r/g, "")
  const begin = "-----BEGIN CERTIFICATE-----"
  const end = "-----END CERTIFICATE-----"
  const first = clean.indexOf(begin)
  const last = clean.lastIndexOf(end)
  if (first === -1 || last === -1) return clean.trim()
  const body = clean.slice(first + begin.length, last).replace(/\s/g, "")
  return `${begin}\n${body}\n${end}`
}

function pemSet(values: readonly string[]) {
  return new Set(values.map(normalizePem))
}

function setEquals(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function union(...sets: Set<string>[]) {
  return new Set(sets.flatMap((set) => [...set]))
}
