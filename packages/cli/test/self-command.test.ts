import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { verifyTlsCaMode, type TlsCaMode } from "@opencode/util/tls-ca"
import { nodeFlags, nodeRuntimeFlags, selfCommand } from "../src/util/process"
import {
  cleanEnvironment,
  hostilePreload,
  hostilePreloadCjs,
  nodeExecutable,
  runProcess,
  structuredLine,
} from "./fixture/tls-ca-mode/harness"
import { buildNodeSelfCommandObservation } from "./fixture/tls-ca-mode/node-bundle"

// The service-spawn boundary refuses to build a command until this process attests its CA policy.
verifyTlsCaMode("bundled")

const approved = [
  "--conditions",
  "browser",
  "--conditions=devel",
  "--experimental-ffi",
  "--enable-source-maps",
  "--no-addons",
  "--no-warnings",
  "--disable-warning=ExperimentalWarning",
]

test.each([
  {
    name: "keeps approved flags in their original order",
    argv: approved,
    mode: "bundled" as const,
    flags: [...approved, "--use-bundled-ca"],
  },
  {
    name: "drops a --conditions flag that has no value",
    argv: ["--conditions=browser", "--conditions"],
    mode: "bundled" as const,
    flags: ["--conditions=browser", "--use-bundled-ca"],
  },
  {
    name: "passes the token after --conditions through as that flag's value",
    argv: ["--conditions", "--inspect"],
    mode: "bundled" as const,
    flags: ["--conditions", "--inspect", "--use-bundled-ca"],
  },
  {
    name: "never replays inspection, loader, require, profiling or test-runner flags",
    argv: [
      "--inspect",
      "--inspect-brk=127.0.0.1:9999",
      "--require",
      "./instrument.js",
      "-r",
      "./preload.cjs",
      "--loader",
      "./hook.mjs",
      "--test",
      "--test-only",
      "--trace-warnings",
      "--max-old-space-size=4096",
      "--use-openssl-ca",
    ],
    mode: "bundled" as const,
    flags: ["--use-bundled-ca"],
  },
  {
    name: "replaces an inherited system CA flag with the verified bundled mode",
    argv: ["--experimental-ffi", "--use-system-ca"],
    mode: "bundled" as const,
    flags: ["--experimental-ffi", "--use-bundled-ca"],
  },
  {
    name: "replaces inherited CA flags with the verified system mode",
    argv: ["--experimental-ffi", "--use-bundled-ca", "--use-openssl-ca"],
    mode: "system" as const,
    flags: ["--experimental-ffi", "--use-system-ca"],
  },
  {
    name: "adds the verified system selector when the parent set none",
    argv: ["--conditions", "browser"],
    mode: "system" as const,
    flags: ["--conditions", "browser", "--use-system-ca"],
  },
])("$name", ({ argv, mode, flags }) => expect(nodeFlags(argv, mode)).toEqual([...flags]))

test("the shared Node allowlist keeps CA selectors but drops execution hooks", () => {
  expect(
    nodeRuntimeFlags([
      ...approved,
      "--use-system-ca",
      "--inspect=127.0.0.1:0",
      "--require",
      "./instrument.js",
      "--loader",
      "./hook.mjs",
      "--test",
    ]),
  ).toEqual([...approved, "--use-system-ca"])
})

test("a service child inherits no unapproved parent flags", () => {
  const inherited = process.execArgv
  process.execArgv = ["--inspect", "--require", "./instrument.js", "--test"]

  try {
    expect(selfCommand()).toEqual([
      process.execPath,
      "--use-bundled-ca",
      path.resolve(process.argv[1]),
      "--tls-ca-mode=bundled",
    ])
  } finally {
    process.execArgv = inherited
  }
})

const probe = path.join(import.meta.dirname, "fixture/tls-ca-mode/self-command-probe.ts")

function assertSourceCommand(
  command: ReadonlyArray<string>,
  entrypoint: string,
  mode: TlsCaMode,
  options: { readonly runtime: "bun" | "node" },
) {
  const selector = `--tls-ca-mode=${mode}`
  expect(command.filter((argument) => argument.startsWith("--tls-ca-mode="))).toEqual([selector])
  expect(command[command.indexOf(entrypoint) + 1]).toBe(selector)
  expect(command).not.toContain("--inspect=127.0.0.1:0")
  expect(command).not.toContain("--require")
  expect(command).not.toContain(hostilePreload)
  expect(command).not.toContain(hostilePreloadCjs)
  expect(command).not.toContain("--preload")
  if (options.runtime === "bun") {
    expect(command).toContain("--conditions=browser")
    expect(command).toContain(mode === "system" ? "--use-system-ca" : "--use-bundled-ca")
  } else {
    expect(command.slice(1, 6)).toEqual([
      "--experimental-ffi",
      "--conditions",
      "browser",
      "--no-warnings",
      "--disable-warning=ExperimentalWarning",
    ])
    expect(command).toContain(mode === "system" ? "--use-system-ca" : "--use-bundled-ca")
  }
}

test.each([
  ["bundled", "system"],
  ["system", "bundled"],
] as const)("a fresh Bun source process builds an explicit %s command", async (mode, ambient) => {
  const result = await runProcess(
    [
      process.execPath,
      "--conditions=browser",
      "--no-warnings",
      "--inspect=127.0.0.1:0",
      "--preload",
      hostilePreload,
      mode === "system" ? "--use-system-ca" : "--use-bundled-ca",
      probe,
      mode,
    ],
    { env: cleanEnvironment({ OPENCODE_TLS_CA_MODE: ambient }) },
  )

  expect(result.exitCode).toBe(0)
  expect(result.stderr).not.toMatch(/TLS CA|verification is disabled/)
  const evidence = structuredLine(result.stdout, "SELF_COMMAND_EVIDENCE")
  const entrypoint = path.resolve(probe)
  expect(evidence).toMatchObject({ mode, entrypoint })
  assertSourceCommand(evidence.command as string[], entrypoint, mode, { runtime: "bun" })
}, 30_000)

describe("fresh Node source self-command", () => {
  let bundle: Awaited<ReturnType<typeof buildNodeSelfCommandObservation>>

  beforeAll(async () => {
    bundle = await buildNodeSelfCommandObservation()
  }, 30_000)

  afterAll(async () => {
    await bundle?.dispose()
  })

  test.each([
    ["bundled", "system"],
    ["system", "bundled"],
  ] as const)("builds an explicit %s command with required flags", async (mode, ambient) => {
    const result = await runProcess(
      [
        nodeExecutable(),
        "--experimental-ffi",
        "--conditions",
        "browser",
        "--no-warnings",
        "--disable-warning=ExperimentalWarning",
        "--require",
        hostilePreloadCjs,
        mode === "system" ? "--use-system-ca" : "--use-bundled-ca",
        bundle.file,
        mode,
      ],
      { env: cleanEnvironment({ OPENCODE_TLS_CA_MODE: ambient }) },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const evidence = structuredLine(result.stdout, "SELF_COMMAND_EVIDENCE")
    const entrypoint = path.resolve(bundle.file)
    expect(evidence).toMatchObject({ mode, entrypoint })
    assertSourceCommand(evidence.command as string[], entrypoint, mode, { runtime: "node" })
  }, 30_000)

  test("the strict getter fails in a fresh unattested process", async () => {
    const result = await runProcess([nodeExecutable(), bundle.file, "unattested"], {
      env: cleanEnvironment(),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(structuredLine(result.stdout, "SELF_COMMAND_EVIDENCE")).toEqual({
      ok: false,
      message: "TLS CA mode has not been verified",
    })
  }, 30_000)
})
