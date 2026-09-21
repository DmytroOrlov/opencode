import path from "node:path"
import {
  TLS_CA_CERTIFICATE_ENVIRONMENT,
  getVerifiedTlsCaMode,
  isNodeSea,
  replaceTlsCaFlags,
  tlsCaFlag,
  type TlsCaMode,
} from "@opencode/util/tls-ca"

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined

export function selfCommand() {
  const mode = getVerifiedTlsCaMode()
  const selector = `--tls-ca-mode=${mode}`
  const bun = process.versions.bun !== undefined
  const virtual = bun && process.argv[1]?.startsWith("/$bunfs/") === true

  if (virtual || isNodeSea()) return [process.execPath, selector]

  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")

  if (bun) {
    return [
      process.execPath,
      ...bunRecoveryFlags(process.execArgv, mode),
      entrypoint,
      selector,
    ]
  }

  return [
    process.execPath,
    ...nodeFlags(process.execArgv, mode),
    entrypoint,
    selector,
  ]
}

const forbiddenSelfLaunchEnvironment = [
  "OPENCODE_TLS_CA_BOOTSTRAPPED",
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "BUN_BE_BUN",
] as const

// A minimal overlay for CLI-owned child processes. Deleting a saved key is not enough because the generic spawn
// merge inherits the parent environment; an own undefined entry is what removes an inherited key at the child
// boundary. Permitted system trust inputs and unrelated saved settings stay untouched.
export function selfLaunchEnvironment(
  mode: TlsCaMode,
  inherited: NodeJS.ProcessEnv,
  saved?: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {
    ...saved,
  }

  const forbidden = [
    ...forbiddenSelfLaunchEnvironment,
    ...(mode === "bundled" ? TLS_CA_CERTIFICATE_ENVIRONMENT : []),
  ]

  for (const key of forbidden) {
    delete result[key]

    if (Object.hasOwn(inherited, key)) {
      result[key] = undefined
    }
  }

  // A saved selector has no authority. The explicit CLI selector
  // determines the verified child's mode.
  delete result.OPENCODE_TLS_CA_MODE

  if (
    Object.hasOwn(inherited, "OPENCODE_TLS_CA_MODE") &&
    inherited.OPENCODE_TLS_CA_MODE !== mode
  ) {
    result.OPENCODE_TLS_CA_MODE = undefined
  }

  // Ignore a saved disabled-verification override rather than
  // replacing a legitimate inherited value of "1".
  if (result.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    delete result.NODE_TLS_REJECT_UNAUTHORIZED
  }

  if (
    inherited.NODE_TLS_REJECT_UNAUTHORIZED === "0" &&
    result.NODE_TLS_REJECT_UNAUTHORIZED !== "1"
  ) {
    result.NODE_TLS_REJECT_UNAUTHORIZED = undefined
  }

  return result
}

const caFlags = new Set(["--use-bundled-ca", "--use-system-ca", "--use-openssl-ca"])

// The pure Node allowlist shared by self-launch replay and clean-launch classification. An inherited `--inspect`,
// `--require`, `--loader` or test-runner flag must never run inside a long-lived service process or be mistaken for
// a clean startup. CA selectors stay here so classification can see them; `nodeFlags` replaces them with the mode
// this process actually verified.
export function nodeRuntimeFlags(execArgv: readonly string[]) {
  return execArgv.flatMap((arg, index, args) => {
    if (index > 0 && args[index - 1] === "--conditions") return []
    if (arg === "--conditions") return args[index + 1] ? [arg, args[index + 1]] : []
    if (arg.startsWith("--conditions=")) return [arg]
    if (
      arg === "--experimental-ffi" ||
      arg === "--enable-source-maps" ||
      arg === "--no-addons"
    )
      return [arg]
    if (arg === "--no-warnings" || arg.startsWith("--disable-warning=")) return [arg]
    if (caFlags.has(arg)) return [arg]
    return []
  })
}

export function nodeFlags(execArgv: readonly string[], mode: TlsCaMode) {
  return replaceTlsCaFlags(mode, nodeRuntimeFlags(execArgv))
}

// Bun source recovery keeps only the browser condition the CLI relies on and installs the selected CA flag.
// Preloads, inspectors and every other startup option are deliberately not replayed.
export function bunRecoveryFlags(execArgv: readonly string[], mode: TlsCaMode) {
  const conditions: string[] = []
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]
    if (arg === "--conditions" && execArgv[index + 1] === "browser") {
      conditions.push(arg, "browser")
      index++
      continue
    }
    if (arg === "--conditions=browser") conditions.push(arg)
  }
  return [...conditions, tlsCaFlag(mode)]
}

// The pure Bun clean-launch allowlist. The compiled artifact bakes `--smol`, its user agent and `--no-warnings`;
// accepting those is not permission for arbitrary options on a native runtime.
export function bunRuntimeFlags(execArgv: readonly string[]) {
  return execArgv.flatMap((arg, index, args) => {
    if (index > 0 && args[index - 1] === "--conditions") return []
    if (arg === "--conditions") return args[index + 1] === "browser" ? [arg, args[index + 1]] : []
    if (arg === "--conditions=browser") return [arg]
    if (arg === "--smol" || arg === "--no-warnings" || arg === "--") return [arg]
    if (arg.startsWith("--user-agent=opencode/")) return [arg]
    if (caFlags.has(arg)) return [arg]
    return []
  })
}
