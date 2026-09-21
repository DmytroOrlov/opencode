import { expect, test } from "bun:test"
import net from "node:net"
import path from "node:path"

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

test("verified system policy trusts an allowed extra CA through ordinary HTTPS fetch", async () => {
  const fixture = path.join(import.meta.dirname, "fixture/tls-ca-mode")
  const cert = await Bun.file(path.join(fixture, "server.pem")).text()
  const key = await Bun.file(path.join(fixture, "server.key")).text()
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
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(fixture, "bootstrap-probe.ts"),
        "--tls-ca-mode=system",
        "--",
        url,
      ],
      {
        env: {
          ...process.env,
          BUN_OPTIONS: undefined,
          NODE_OPTIONS: undefined,
          NODE_EXTRA_CA_CERTS: path.join(fixture, "root.pem"),
          NODE_USE_SYSTEM_CA: undefined,
          NODE_TLS_REJECT_UNAUTHORIZED: undefined,
          SSL_CERT_FILE: undefined,
          SSL_CERT_DIR: undefined,
          OPENCODE_TLS_CA_MODE: undefined,
          OPENCODE_TLS_CA_BOOTSTRAPPED: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(handled).toBe(1)
  } finally {
    server.stop(true)
  }
}, 30_000)

test("verified bundled policy rejects an untrusted TLS root before HTTP handling", async () => {
  const fixture = path.join(import.meta.dirname, "fixture/tls-ca-mode")
  const cert = await Bun.file(path.join(fixture, "server.pem")).text()
  const key = await Bun.file(path.join(fixture, "server.key")).text()
  const root = await Bun.file(path.join(fixture, "root.pem")).text()
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

    const directProbe = Bun.spawn(
      [process.execPath, "--use-bundled-ca", path.join(fixture, "probe.ts"), url],
      {
        env: { ...process.env, BUN_OPTIONS: undefined, NODE_EXTRA_CA_CERTS: undefined },
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    const [directExit, directError] = await Promise.all([
      directProbe.exited,
      new Response(directProbe.stderr).text(),
    ])
    expect(directExit).not.toBe(0)
    expect(directError).not.toBe("")

    const child = Bun.spawn(
      [process.execPath, "--conditions=browser", path.join(fixture, "bootstrap-probe.ts"), "--tls-ca-mode=bundled", "--", url],
      {
        env: {
          ...process.env,
          BUN_OPTIONS: "--use-system-ca",
          NODE_OPTIONS: "--use-system-ca",
          NODE_EXTRA_CA_CERTS: path.join(fixture, "root.pem"),
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          SSL_CERT_FILE: path.join(fixture, "root.pem"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

    expect(exitCode).not.toBe(0)
    expect(stderr).not.toBe("")
    expect(handled).toBe(0)
  } finally {
    server.stop(true)
  }
}, 30_000)
