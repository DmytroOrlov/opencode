import { describe, expect, test } from "bun:test"
import path from "path"
import net from "node:net"

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
    s.on("error", reject)
  })
}

const fixtureDir = path.join(import.meta.dirname, "fixture/tls-ca-mode")

describe("tls-ca-mode integration", () => {
  test("private CA POST is rejected with --use-bundled-ca", async () => {
    const serverCert = await Bun.file(path.join(fixtureDir, "server.pem")).text()
    const serverKey = await Bun.file(path.join(fixtureDir, "server.key")).text()
    const rootCert = await Bun.file(path.join(fixtureDir, "root.pem")).text()

    let handlerCallCount = 0

    const server = Bun.serve({
      port: 0,
      tls: {
        cert: serverCert,
        key: serverKey,
      },
      fetch(req) {
        handlerCallCount++
        return new Response("ok", { status: 200 })
      },
    })

    const port = server.port

    try {
      const positiveResponse = await fetch(`https://localhost:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ probe: true, ts: Date.now(), control: true }),
        tls: { ca: rootCert },
      })

      expect(positiveResponse.ok).toBe(true)
      expect(await positiveResponse.text()).toBe("ok")
      expect(handlerCallCount).toBe(1)

      handlerCallCount = 0

      const probeScript = path.join(fixtureDir, "probe.ts")
      const child = Bun.spawn(["bun", probeScript, `https://localhost:${port}`], {
        env: {
          BUN_OPTIONS: "--use-bundled-ca",
          NODE_USE_SYSTEM_CA: undefined,
          NODE_EXTRA_CA_CERTS: undefined,
          NODE_TLS_REJECT_UNAUTHORIZED: undefined,
          SSL_CERT_FILE: undefined,
          SSL_CERT_DIR: undefined,
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      const exitCode = await child.exited
      const stderr = await new Response(child.stderr).text()

      expect(exitCode).not.toBe(0)
      expect(stderr).not.toBe("")
      expect(handlerCallCount).toBe(0)
    } finally {
      server.stop(true)
    }
  })
})

describe("ambient TLS bootstrap sanitization", () => {
  const rootCertPath = path.join(fixtureDir, "root.pem")
  const bootstrapSource = path.join(import.meta.dirname, "../src/bootstrap.ts")

  const testCases = [
    { name: "NODE_EXTRA_CA_CERTS", env: { NODE_EXTRA_CA_CERTS: rootCertPath } },
    { name: "NODE_USE_SYSTEM_CA", env: { NODE_USE_SYSTEM_CA: "1" } },
    { name: "NODE_TLS_REJECT_UNAUTHORIZED", env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
    { name: "SSL_CERT_FILE", env: { SSL_CERT_FILE: rootCertPath } },
    { name: "SSL_CERT_DIR", env: { SSL_CERT_DIR: fixtureDir } },
  ]

  for (const { name, env } of testCases) {
    test(`ambient ${name} is sanitized through real bootstrap`, async () => {
      const child = Bun.spawn(
        [
          "bun",
          "--conditions=browser",
          bootstrapSource,
          "--tls-ca-mode=bundled",
          "--version",
        ],
        {
          env: {
            ...env,
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )

      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      expect(exitCode).toBe(0)
      expect(stdout).toBeTruthy()
      expect(stdout.trim()).not.toBe("")
      expect(stderr).not.toMatch(/TLS CA mode|conflict|getCACertificates/)
    })
  }
})

describe("direct entrypoint bypass guard", () => {
  const mainSource = path.join(import.meta.dirname, "../src/index.ts")

  test("direct index.ts invocation exits with bootstrap-required error", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        mainSource,
        "--version",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/must be started through the TLS CA bootstrap/i)
    expect(stdout).toBe("")
  })

  test("direct index.ts invocation does not produce requested command output", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        mainSource,
        "--help",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
  })
})

describe("direct main.ts bypass guard", () => {
  const mainTs = path.join(import.meta.dirname, "../src/main.ts")

  test("direct main.ts --version does not execute the CLI or print a version", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        mainTs,
        "--version",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })
})

describe("bootstrap bundled CA to private TLS server", () => {
  const fixtureDir = path.join(import.meta.dirname, "fixture/tls-ca-mode")
  const probeScript = path.join(fixtureDir, "bootstrap-probe.ts")

  test("real bootstrap → bundled mode → probe rejected before HTTP handling", async () => {
    const serverCert = await Bun.file(path.join(fixtureDir, "server.pem")).text()
    const serverKey = await Bun.file(path.join(fixtureDir, "server.key")).text()
    const rootCert = await Bun.file(path.join(fixtureDir, "root.pem")).text()

    let handlerCallCount = 0

    const server = Bun.serve({
      port: 0,
      tls: { cert: serverCert, key: serverKey },
      fetch(req) {
        handlerCallCount++
        return new Response("ok", { status: 200 })
      },
    })

    const url = `https://localhost:${server.port}`

    try {
      const positiveResponse = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ probe: true }),
        tls: { ca: rootCert },
      })
      expect(positiveResponse.ok).toBe(true)
      expect(handlerCallCount).toBe(1)

      handlerCallCount = 0

      const child = Bun.spawn(
        ["bun", probeScript, "--tls-ca-mode=bundled", "--", url],
        {
          env: {
            NODE_EXTRA_CA_CERTS: path.join(fixtureDir, "root.pem"),
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )

      const exitCode = await child.exited
      const stderr = await new Response(child.stderr).text()

      expect(exitCode).not.toBe(0)
      expect(handlerCallCount).toBe(0)
      expect(stderr).not.toBe("")
    } finally {
      server.stop(true)
    }
  })
})

describe("hostile BUN_OPTIONS in bundled mode", () => {
  const bootstrapSource = path.join(import.meta.dirname, "../src/bootstrap.ts")

  test("bundled mode drops hostile --smol and --use-system-ca from ambient BUN_OPTIONS", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        bootstrapSource,
        "--tls-ca-mode=bundled",
        "--version",
      ],
      {
        env: {
          BUN_OPTIONS: "--smol --degug --use-system-ca",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBeTruthy()
    expect(stdout.trim()).not.toBe("")
    expect(stderr).not.toMatch(/TLS CA mode|conflict|getCACertificates/)
  })
})

describe("NODE_TLS_REJECT_UNAUTHORIZED hostile bootstrap", () => {
  const bootstrapSource = path.join(import.meta.dirname, "../src/bootstrap.ts")

  test("bundled mode sanitizes NODE_TLS_REJECT_UNAUTHORIZED=0 and child succeeds", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        bootstrapSource,
        "--tls-ca-mode=bundled",
        "--version",
      ],
      {
        env: {
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBeTruthy()
    expect(stderr).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/)
  })

  test("system mode sanitizes NODE_TLS_REJECT_UNAUTHORIZED=0 and child succeeds", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        bootstrapSource,
        "--tls-ca-mode=system",
        "--version",
      ],
      {
        env: {
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBeTruthy()
    expect(stderr).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/)
  })

  test("system mode succeeds with all five CA variables intact and NODE_TLS_REJECT_UNAUTHORIZED absent", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        bootstrapSource,
        "--tls-ca-mode=system",
        "--version",
      ],
      {
        env: {
          NODE_USE_SYSTEM_CA: "1",
          NODE_EXTRA_CA_CERTS: "/does/not/exist.pem",
          SSL_CERT_FILE: "/does/not/exist.pem",
          SSL_CERT_DIR: "/does/not/exist",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBeTruthy()
    expect(stderr).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/)
  })
})

describe("camelCase TLS mode rejection", () => {
  const bootstrapSource = path.join(import.meta.dirname, "../src/bootstrap.ts")

  test("--tlsCaMode=bundled is rejected with non-zero exit and no version output", async () => {
    const child = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        bootstrapSource,
        "--tlsCaMode=bundled",
        "--version",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe("")
    expect(stderr.toLowerCase()).toMatch(/--tls-ca-mode/)
  })
})

describe("BUN_OPTIONS cleanup in verified child", () => {
  const probeScript = path.join(fixtureDir, "bootstrap-env-probe.ts")

  test("verified child deletes BUN_OPTIONS before afterVerified callback", async () => {
    const child = Bun.spawn(
      ["bun", probeScript, "--tls-ca-mode=bundled"],
      {
        env: {
          OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
          BUN_OPTIONS: "--use-bundled-ca",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("verified environment is clean")
    expect(stderr).not.toContain("BUN_OPTIONS leaked")
    expect(stderr).not.toContain("OPENCODE_TLS_CA_BOOTSTRAPPED leaked")
  })
})

describe("debug inspector start with OPENCODE_TLS_CA_BOOTSTRAPPED=1", () => {
  const bootstrapSource = path.join(import.meta.dirname, "../src/bootstrap.ts")

  test("inspector starts once without EADDRINUSE when marker is set", async () => {
    const port = await findFreePort()

    const child = Bun.spawn(
      [
        "bun",
        "--use-system-ca",
        `--inspect=127.0.0.1:${port}`,
        "--conditions=browser",
        bootstrapSource,
        "--tls-ca-mode=system",
        "--version",
      ],
      {
        env: {
          OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
          NODE_EXTRA_CA_CERTS: undefined,
          NODE_USE_SYSTEM_CA: undefined,
          NODE_TLS_REJECT_UNAUTHORIZED: undefined,
          SSL_CERT_FILE: undefined,
          SSL_CERT_DIR: undefined,
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBeTruthy()
    expect(stdout.trim()).not.toBe("")

    const listeningMatches = stderr.match(/Listening:/gi) ?? []
    expect(listeningMatches.length).toBe(1)
    expect(stderr).not.toMatch(/EADDRINUSE/)
    expect(stderr).not.toMatch(/Failed to start inspector/)
  })
})
