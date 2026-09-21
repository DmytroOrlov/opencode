import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import {
  TLS_CA_CERTIFICATE_ENVIRONMENT,
  getVerifiedTlsCaMode,
  isNodeSea,
  parseTlsCaMode,
  sanitizeTlsCaEnvironment,
  verifyTlsCaMode,
  type ParsedTlsCaMode,
  type TlsCaMode,
} from "@opencode/util/tls-ca"
import { bunRecoveryFlags, bunRuntimeFlags, nodeFlags, nodeRuntimeFlags } from "./util/process"

export async function runTlsCaBootstrap(afterVerified: () => Promise<unknown>) {
  const marker = "OPENCODE_TLS_CA_BOOTSTRAPPED"
  const parsed = parseTlsCaMode(process.argv.slice(2))
  const relaunching = process.env[marker] === "1"

  if (hasDisallowedStartupOptions(relaunching)) {
    if (relaunching) throw new Error("Disallowed runtime options in TLS CA recovery")
    await relaunch(parsed, marker)
  }

  try {
    verifyTlsCaMode(parsed.mode)
  } catch (error) {
    if (relaunching) throw error
    await relaunch(parsed, marker)
  }

  applyVerifiedEnvironment(parsed.mode, marker)

  process.argv = [...process.argv.slice(0, 2), ...parsed.argv]
  getVerifiedTlsCaMode()
  await afterVerified()
}

function runtimeInfo() {
  const bun = process.versions.bun !== undefined
  const virtual = bun && process.argv[1]?.startsWith("/$bunfs/") === true
  return { bun, packaged: virtual || isNodeSea() }
}

function inspectorFlags(execArgv: readonly string[]) {
  return execArgv.filter(
    (arg) =>
      arg === "--inspect" ||
      arg.startsWith("--inspect=") ||
      arg === "--inspect-brk" ||
      arg.startsWith("--inspect-brk="),
  )
}

function hasDisallowedStartupOptions(relaunching: boolean) {
  const nonEmpty = (value: string | undefined) => value !== undefined && value !== ""
  if (
    nonEmpty(process.env.BUN_OPTIONS) ||
    nonEmpty(process.env.NODE_OPTIONS) ||
    nonEmpty(process.env.BUN_BE_BUN)
  )
    return true

  const { bun, packaged } = runtimeInfo()
  const approved = bun ? bunRuntimeFlags(process.execArgv) : nodeRuntimeFlags(process.execArgv)
  // A marked Bun source launch may keep exactly one intentional debugger flag. It is not replayed by recovery and
  // never permits a preload, loader or arbitrary environment option alongside it.
  const inspectors = bun && !packaged && relaunching ? inspectorFlags(process.execArgv) : []
  if (inspectors.length > 1) return true
  return approved.length + inspectors.length !== process.execArgv.length
}

function applyVerifiedEnvironment(mode: TlsCaMode, marker: string) {
  Object.assign(process.env, sanitizeTlsCaEnvironment(mode, process.env))

  if (mode === "bundled") {
    for (const key of TLS_CA_CERTIFICATE_ENVIRONMENT) delete process.env[key]
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  delete process.env.BUN_OPTIONS
  delete process.env.NODE_OPTIONS
  delete process.env.BUN_BE_BUN
  delete process.env[marker]
}

async function relaunch(parsed: ParsedTlsCaMode, marker: string): Promise<never> {
  const { bun, packaged } = runtimeInfo()
  const command = [process.execPath]

  if (!packaged) {
    const entrypoint = process.argv[1]
    if (!entrypoint || !existsSync(entrypoint))
      throw new Error("Failed to resolve CLI entrypoint for TLS CA recovery")
    command.push(
      ...(bun
        ? bunRecoveryFlags(process.execArgv, parsed.mode)
        : nodeFlags(process.execArgv, parsed.mode)),
      entrypoint,
    )
  }

  // The explicit mode comes immediately after the source entrypoint or packaged executable, before every
  // application argument and any original `--` separator. Packaged runtimes omit argv's synthetic entrypoint slot.
  command.push(`--tls-ca-mode=${parsed.mode}`, ...parsed.argv)

  const env = sanitizeTlsCaEnvironment(parsed.mode, process.env)
  env[marker] = "1"

  const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" })
  const forward = (signal: NodeJS.Signals) => child.kill(signal)
  process.on("SIGINT", forward)
  process.on("SIGTERM", forward)

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  }).finally(() => {
    process.off("SIGINT", forward)
    process.off("SIGTERM", forward)
  })

  if (result.signal) process.kill(process.pid, result.signal)
  process.exit(result.code ?? 1)
}
