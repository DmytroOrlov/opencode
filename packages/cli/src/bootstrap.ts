import { spawn } from "node:child_process"
import {
  getVerifiedTlsCaMode,
  isNodeSea,
  parseTlsCaMode,
  replaceTlsCaFlags,
  sanitizeTlsCaEnvironment,
  verifyTlsCaMode,
} from "@opencode/util/tls-ca"

export async function runTlsCaBootstrap(afterVerified: () => Promise<unknown>) {
  const marker = "OPENCODE_TLS_CA_BOOTSTRAPPED"
  const parsed = parseTlsCaMode(process.argv.slice(2), process.env.OPENCODE_TLS_CA_MODE)
  const relaunching = process.env[marker] === "1"

  try {
    verifyTlsCaMode(parsed.mode)
  } catch (error) {
    if (relaunching) throw error
    await relaunch(parsed.mode, marker)
  }

  Object.assign(process.env, sanitizeTlsCaEnvironment(parsed.mode, process.env))
  delete process.env.BUN_OPTIONS
  delete process.env.NODE_OPTIONS
  delete process.env[marker]
  process.argv = [...process.argv.slice(0, 2), ...parsed.argv]
  getVerifiedTlsCaMode()
  await afterVerified()
}

async function relaunch(mode: "bundled" | "system", marker: string): Promise<never> {
  const env = sanitizeTlsCaEnvironment(mode, process.env)
  env[marker] = "1"
  const bun = process.versions.bun !== undefined
  const virtual = bun && process.argv[1]?.startsWith("/$bunfs/")
  const nodeSea = isNodeSea()
  const command = [
    process.execPath,
    ...(virtual || nodeSea ? [] : replaceTlsCaFlags(mode, process.execArgv)),
    ...(virtual ? process.argv.slice(2) : process.argv.slice(1)),
  ]
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
