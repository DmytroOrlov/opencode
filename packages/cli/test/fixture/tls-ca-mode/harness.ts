import { readFile } from "node:fs/promises"
import path from "node:path"

export const fixtureDirectory = import.meta.dirname
export const bootstrapObservation = path.join(fixtureDirectory, "bootstrap-observation.ts")
export const hostilePreload = path.join(fixtureDirectory, "hostile-preload.ts")
export const hostilePreloadCjs = path.join(fixtureDirectory, "hostile-preload.cjs")

const removedEnvironment = [
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "BUN_BE_BUN",
  "OPENCODE_TLS_CA_BOOTSTRAPPED",
  "OPENCODE_TLS_CA_MODE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TLS_CA_TEST_UNRELATED",
  "TLS_CA_PRELOAD_MARKER",
  "TLS_CA_GUARD_MARKER",
]

export function cleanEnvironment(extra: Record<string, string | undefined> = {}) {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || removedEnvironment.includes(key)) continue
    environment[key] = value
  }
  return { ...environment, ...extra }
}

export function nodeExecutable() {
  const node = Bun.which("node")
  if (!node) throw new Error("The installed Node runtime is required for source TLS bootstrap coverage")
  return node
}

export async function runProcess(
  command: ReadonlyArray<string>,
  options: { readonly env?: Record<string, string | undefined>; readonly cwd?: string } = {},
) {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env ?? cleanEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { pid: child.pid, exitCode, stdout, stderr }
}

export function structuredLine(stdout: string, prefix: string) {
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith(`${prefix} `))
  if (!line) throw new Error(`Missing ${prefix} output in:\n${stdout}`)
  return JSON.parse(line.slice(prefix.length + 1)) as Record<string, unknown>
}

export async function markerPids(file: string) {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .flatMap((line) => (line.trim() ? [Number(line.trim())] : []))
  } catch {
    return []
  }
}
