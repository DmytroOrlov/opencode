import {
  type ParsedTlsCaMode,
  parseTlsCaMode,
  isBunVirtualEntrypoint,
  makeTlsBunOptions,
  sourceExecArgv,
  sanitizeTlsCaEnvironment,
  tlsCaSpawnUnsetEnvironment,
  verifyTlsCaMode,
} from "./tls-ca-mode"

async function waitForChild(child: Bun.Subprocess): Promise<never> {
  const onSigint = () => child.kill("SIGINT")
  const onSigterm = () => child.kill("SIGTERM")
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  const exitCode = await child.exited
  process.off("SIGINT", onSigint)
  process.off("SIGTERM", onSigterm)
  process.exit(exitCode)
}

export async function runTlsCaBootstrap(
  afterVerified: () => Promise<unknown>,
): Promise<never | void> {
  const parsed = parseTlsCaMode(process.argv)

  if (process.env.OPENCODE_TLS_CA_BOOTSTRAPPED !== "1") {
    const childEnv = sanitizeTlsCaEnvironment(parsed.mode, process.env)

    if (isBunVirtualEntrypoint(process.argv[1])) {
      const bunOptions = makeTlsBunOptions(parsed.mode)
      const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
        env: {
          ...childEnv,
          BUN_OPTIONS: bunOptions,
          OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
          ...tlsCaSpawnUnsetEnvironment(parsed.mode),
        },
        stdio: ["inherit", "inherit", "inherit"],
      })
      await waitForChild(child)
    }

    const execArgv = sourceExecArgv(parsed.mode, process.execArgv)
    const { BUN_OPTIONS: _dropped, ...restEnv } = childEnv as Record<string, string | undefined>
    const child = Bun.spawn([process.execPath, ...execArgv, ...process.argv.slice(1)], {
      env: {
        ...restEnv,
        BUN_OPTIONS: undefined,
        OPENCODE_TLS_CA_BOOTSTRAPPED: "1",
        ...tlsCaSpawnUnsetEnvironment(parsed.mode),
      },
      stdio: ["inherit", "inherit", "inherit"],
    })
    await waitForChild(child)
  }

  verifyTlsCaMode(parsed.mode)
  delete process.env.BUN_OPTIONS
  delete process.env.OPENCODE_TLS_CA_BOOTSTRAPPED
  process.argv = parsed.argv
  await afterVerified()
}

if (import.meta.main) {
  await runTlsCaBootstrap(() => import("./index"))
}
