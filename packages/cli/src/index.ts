import { runTlsCaBootstrap } from "./bootstrap"

await runTlsCaBootstrap(async () => {
  const { runCli } = await import("./main")
  return runCli()
})
