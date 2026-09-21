import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { ServiceConfig } from "../src/services/service-config"
import { isolatedEnv } from "./fixture/environment"

const tlsFixture = path.join(import.meta.dir, "fixture/tls-ca-mode")

test("standalone server exits when its owner is killed", async () => {
  // Windows can hold the server's files briefly after it exits; the fixture retries removal on EBUSY.
  await using root = await tmpdir("opencode-cli-standalone-")
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/standalone-owner.ts")], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root.path, { OPENCODE_SERVER_USERNAME: "custom" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const line = await Promise.race([
    readLine(owner.stdout, "STANDALONE_READY "),
    Bun.sleep(10_000).then(() => undefined),
  ])
  const [, rawPID, url, status, tlsCaMode] = line?.split(" ") ?? []
  const pid = Number(rawPID)

  try {
    expect(pid).toBeGreaterThan(0)
    expect(url).toStartWith("http://127.0.0.1:")
    expect(status).toBe("200")
    expect(tlsCaMode).toBe("bundled")
    expect(running(pid)).toBe(true)

    owner.kill("SIGKILL")
    await owner.exited

    expect(await waitForExit(pid)).toBe(true)
  } finally {
    owner.kill("SIGKILL")
    await owner.exited
    if (running(pid)) process.kill(pid, "SIGKILL")
  }
})

test.each(["bundled", "system"] as const)(
  "normal CLI standalone %s resolution ignores hostile saved managed configuration",
  async (mode) => {
    await using root = await tmpdir(`opencode-cli-standalone-${mode}-`)
    const config = path.join(root.path, "config", ServiceConfig.filename())
    await fs.mkdir(path.dirname(config), { recursive: true })
    await fs.writeFile(
      config,
      JSON.stringify({
        disabled: true,
        env: {
          OPENCODE_TLS_CA_MODE: mode === "bundled" ? "system" : "openssl",
          OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
          BUN_OPTIONS: "--smol --use-system-ca",
          NODE_OPTIONS: "--trace-warnings --require ./saved-hostile.js",
          BUN_BE_BUN: "1",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          NODE_EXTRA_CA_CERTS: path.join(tlsFixture, "root.pem"),
          SSL_CERT_DIR: tlsFixture,
          OPENCODE_STANDALONE_SAVED_SENTINEL: "keep",
        },
      }),
    )

    const command = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../src/index.ts"),
        `--tls-ca-mode=${mode}`,
        "api",
        "get",
        "/api/info",
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: isolatedEnv(root.path),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ])

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const info = JSON.parse(stdout)
    expect(info).toMatchObject({ tlsCaMode: mode })
    expect(info.pid).toBeGreaterThan(0)
    expect(info.pid).not.toBe(command.pid)
    expect(info.urls).toHaveLength(1)
    expect(info.urls[0]).toStartWith("http://127.0.0.1:")
    expect(await waitForExit(info.pid)).toBe(true)
    expect(await Bun.file(path.join(root.path, "state", "opencode", ServiceConfig.filename())).exists()).toBe(false)
  },
  30_000,
)

async function readLine(stream: ReadableStream<Uint8Array>, prefix: string) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(decoder.decode(result.value, { stream: true }))
    const output = chunks.join("")
    const line = output.split("\n").find((line) => line.startsWith(prefix))
    if (line) {
      reader.releaseLock()
      return line
    }
  }
  reader.releaseLock()
  return (chunks.join("") + decoder.decode()).split("\n").find((line) => line.startsWith(prefix))
}

async function waitForExit(pid: number, attempts = 100): Promise<boolean> {
  if (!running(pid)) return true
  if (attempts === 0) return false
  await Bun.sleep(50)
  return waitForExit(pid, attempts - 1)
}

function running(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
