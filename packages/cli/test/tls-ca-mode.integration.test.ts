import { afterAll, beforeAll, expect, test } from "bun:test"
import net from "node:net"
import path from "node:path"
import {
  bootstrapObservation,
  cleanEnvironment,
  fixtureDirectory,
  nodeExecutable,
  runProcess,
  structuredLine,
} from "./fixture/tls-ca-mode/harness"
import { buildNodeBootstrapObservation } from "./fixture/tls-ca-mode/node-bundle"

function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("No test port was allocated"))
      server.close(() => resolve(address.port))
    })
    server.on("error", reject)
  })
}

const mixedArguments = [
  "command",
  "",
  "argument with spaces",
  "--flag=value",
  "--",
  "--tls-ca-mode=system",
  "literal tail",
]

let nodeBundle: Awaited<ReturnType<typeof buildNodeBootstrapObservation>>

beforeAll(async () => {
  nodeBundle = await buildNodeBootstrapObservation()
}, 30_000)

afterAll(async () => {
  await nodeBundle?.dispose()
})

function tlsErrorMatches(value: unknown) {
  const serialized = JSON.stringify(value)
  return /UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|certificate|unable to verify|UnknownIssuer/i.test(serialized)
}

test("verified system policy trusts an allowed extra CA through ordinary HTTPS fetch", async () => {
  const cert = await Bun.file(path.join(fixtureDirectory, "server.pem")).text()
  const key = await Bun.file(path.join(fixtureDirectory, "server.key")).text()
  let handled = 0
  const server = Bun.serve({
    port: await findFreePort(),
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch() {
      handled++
      return new Response("ok")
    },
  })
  const url = `https://localhost:${server.port}`

  try {
    const result = await runProcess(
      [
        process.execPath,
        "--conditions=browser",
        path.join(fixtureDirectory, "bootstrap-probe.ts"),
        "--tls-ca-mode=system",
        "--",
        url,
      ],
      {
        env: cleanEnvironment({
          NODE_EXTRA_CA_CERTS: path.join(fixtureDirectory, "root.pem"),
        }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(handled).toBe(1)
    expect(structuredLine(result.stdout, "TLS_ATTEMPT")).toMatchObject({
      runtime: expect.stringMatching(/^bun\//),
      mode: "system",
      url,
    })
    expect(structuredLine(result.stdout, "TLS_RESPONSE")).toMatchObject({ status: 200, body: "ok" })
  } finally {
    server.stop(true)
  }
}, 30_000)

test("verified bundled policy rejects an untrusted TLS root before HTTP handling", async () => {
  const cert = await Bun.file(path.join(fixtureDirectory, "server.pem")).text()
  const key = await Bun.file(path.join(fixtureDirectory, "server.key")).text()
  const root = await Bun.file(path.join(fixtureDirectory, "root.pem")).text()
  let handled = 0
  const server = Bun.serve({
    port: await findFreePort(),
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch() {
      handled++
      return new Response("ok")
    },
  })
  const url = `https://localhost:${server.port}`

  try {
    const control = await fetch(url, { tls: { ca: root } })
    expect(control.status).toBe(200)
    expect(handled).toBe(1)
    handled = 0

    const directProbe = await runProcess(
      [process.execPath, "--use-bundled-ca", path.join(fixtureDirectory, "probe.ts"), url],
      { env: cleanEnvironment() },
    )
    expect(directProbe.exitCode).not.toBe(0)
    expect(directProbe.stderr).not.toBe("")

    const result = await runProcess(
      [
        process.execPath,
        "--conditions=browser",
        path.join(fixtureDirectory, "bootstrap-probe.ts"),
        "--tls-ca-mode=bundled",
        "--",
        url,
      ],
      {
        env: cleanEnvironment({
          BUN_OPTIONS: "--use-system-ca",
          NODE_OPTIONS: "--use-system-ca",
          NODE_EXTRA_CA_CERTS: path.join(fixtureDirectory, "root.pem"),
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          SSL_CERT_FILE: path.join(fixtureDirectory, "root.pem"),
        }),
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).not.toBe("")
    expect(structuredLine(result.stdout, "TLS_ATTEMPT")).toMatchObject({
      runtime: expect.stringMatching(/^bun\//),
      mode: "bundled",
      url,
    })
    const failure = structuredLine(result.stdout, "TLS_ERROR")
    expect(tlsErrorMatches(failure.error)).toBe(true)
    expect(handled).toBe(0)
  } finally {
    server.stop(true)
  }
}, 30_000)

test("Node source system policy trusts an allowed extra CA through ordinary HTTPS fetch", async () => {
  const cert = await Bun.file(path.join(fixtureDirectory, "server.pem")).text()
  const key = await Bun.file(path.join(fixtureDirectory, "server.key")).text()
  let handled = 0
  const server = Bun.serve({
    port: await findFreePort(),
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch() {
      handled++
      return new Response("ok")
    },
  })
  const url = `https://localhost:${server.port}`

  try {
    const result = await runProcess(
      [
        nodeExecutable(),
        nodeBundle.file,
        "--tls-ca-mode=system",
        `--https-probe=${url}`,
      ],
      {
        env: cleanEnvironment({
          NODE_EXTRA_CA_CERTS: path.join(fixtureDirectory, "root.pem"),
        }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(handled).toBe(1)
    expect(structuredLine(result.stdout, "TLS_ATTEMPT")).toMatchObject({
      runtime: expect.stringMatching(/^node\//),
      mode: "system",
      url,
    })
    expect(structuredLine(result.stdout, "TLS_RESPONSE")).toMatchObject({ status: 200, body: "ok" })
  } finally {
    server.stop(true)
  }
}, 30_000)

test("Node source bundled policy rejects an untrusted TLS root before HTTP handling", async () => {
  const cert = await Bun.file(path.join(fixtureDirectory, "server.pem")).text()
  const key = await Bun.file(path.join(fixtureDirectory, "server.key")).text()
  const root = await Bun.file(path.join(fixtureDirectory, "root.pem")).text()
  let handled = 0
  const server = Bun.serve({
    port: await findFreePort(),
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch() {
      handled++
      return new Response("ok")
    },
  })
  const url = `https://localhost:${server.port}`

  try {
    const control = await fetch(url, { tls: { ca: root } })
    expect(control.status).toBe(200)
    expect(handled).toBe(1)
    handled = 0

    const result = await runProcess(
      [
        nodeExecutable(),
        nodeBundle.file,
        "--tls-ca-mode=bundled",
        `--https-probe=${url}`,
      ],
      {
        env: cleanEnvironment({
          NODE_EXTRA_CA_CERTS: path.join(fixtureDirectory, "root.pem"),
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          SSL_CERT_FILE: path.join(fixtureDirectory, "root.pem"),
        }),
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(structuredLine(result.stdout, "TLS_ATTEMPT")).toMatchObject({
      runtime: expect.stringMatching(/^node\//),
      mode: "bundled",
      url,
    })
    const failure = structuredLine(result.stdout, "TLS_ERROR")
    expect(tlsErrorMatches(failure.error)).toBe(true)
    expect(handled).toBe(0)
  } finally {
    server.stop(true)
  }
}, 30_000)

test("Bun source recovery preserves exact application arguments and an explicit selection", async () => {
  const result = await runProcess(
    [
      process.execPath,
      "--use-system-ca",
      bootstrapObservation,
      "--tls-ca-mode=bundled",
      ...mixedArguments,
    ],
    {
      env: cleanEnvironment({
        OPENCODE_TLS_CA_MODE: "system",
      }),
    },
  )

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe("")
  const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
  expect(evidence.pid).not.toBe(result.pid)
  expect(evidence).toMatchObject({
    mode: "bundled",
    argv: mixedArguments,
    execArgv: ["--use-bundled-ca"],
    environment: {
      OPENCODE_TLS_CA_MODE: "bundled",
      OPENCODE_TLS_CA_BOOTSTRAPPED: null,
      BUN_OPTIONS: null,
      NODE_OPTIONS: null,
    },
  })
}, 30_000)

test("Node source recovery preserves exact application arguments and an explicit selection", async () => {
  const result = await runProcess(
    [
      nodeExecutable(),
      "--use-system-ca",
      nodeBundle.file,
      "--tls-ca-mode=bundled",
      ...mixedArguments,
    ],
    {
      env: cleanEnvironment({
        OPENCODE_TLS_CA_MODE: "system",
      }),
    },
  )

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe("")
  const evidence = structuredLine(result.stdout, "BOOTSTRAP_EVIDENCE")
  expect(evidence.pid).not.toBe(result.pid)
  expect(evidence).toMatchObject({
    mode: "bundled",
    argv: mixedArguments,
    execArgv: ["--use-bundled-ca"],
    environment: {
      OPENCODE_TLS_CA_MODE: "bundled",
      OPENCODE_TLS_CA_BOOTSTRAPPED: null,
      BUN_OPTIONS: null,
      NODE_OPTIONS: null,
    },
  })
}, 30_000)

test("a single marked Bun inspector with a clean launch is accepted", async () => {
  const cli = path.join(import.meta.dirname, "../src/index.ts")
  const result = await runProcess(
    [
      process.execPath,
      "--use-system-ca",
      "--inspect=127.0.0.1:0",
      "--conditions=browser",
      cli,
      "--tls-ca-mode=system",
      "--version",
    ],
    {
      cwd: path.join(import.meta.dirname, ".."),
      env: cleanEnvironment({
        OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
        OPENCODE_TLS_CA_MODE: "system",
      }),
    },
  )

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toMatch(/opencode v/)
  const combined = `${result.stdout}\n${result.stderr}`
  expect(combined.match(/Listening:/g)).toHaveLength(1)
  expect(combined).not.toContain("EADDRINUSE")
  expect(combined.toLowerCase()).not.toContain("failed to start inspector")
}, 30_000)
