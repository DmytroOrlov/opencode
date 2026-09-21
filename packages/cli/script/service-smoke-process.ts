import { ServerInfo } from "@opencode/protocol/groups/server"
import { Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"

export async function waitForRegistration(directory: string, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const files = await fs.readdir(directory).catch(() => [])
    const file = files.find((file) => file === "service.json" || (file.startsWith("service-") && file.endsWith(".json")))
    if (file) return path.join(directory, file)
    await Bun.sleep(25)
  }
  throw new Error(`Service did not publish registration in ${directory}`)
}

export async function waitForReady(url: string, headers: HeadersInit, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/info", url), {
      headers,
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    if (response?.ok) {
      return Schema.decodeUnknownPromise(ServerInfo)(await response.json())
    }
    await Bun.sleep(25)
  }
  throw new Error(`Server at ${url} did not become ready`)
}

export function exitsWithin(process: Bun.Subprocess, milliseconds: number) {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), milliseconds)
    process.exited.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

export function processRunning(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForProcessExit(pid: number, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!processRunning(pid)) return true
    await Bun.sleep(25)
  }
  return !processRunning(pid)
}

/**
 * Stop one owned process and report whether its exit was actually established.
 * A signal error counts only when the process is gone; a still-running process is a cleanup failure.
 */
export async function stopOwnedProcess(pid: number, timeout = 10_000) {
  if (!processRunning(pid)) return true
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    if (!processRunning(pid)) return true
    return false
  }
  if (await waitForProcessExit(pid, timeout)) return true
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    if (!processRunning(pid)) return true
    return false
  }
  return waitForProcessExit(pid, 2_000)
}
