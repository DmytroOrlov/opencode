import { runTlsCaBootstrap } from "../bootstrap"

await runTlsCaBootstrap(async () => {
  await import("./plugin-runtime.promise")
  await import("./plugin-runtime.effect")

  process.stdout.on("error", (error) => {
    if ("code" in error && error.code === "EPIPE") return
    throw error
  })

  const { runCli } = await import("../main")
  return runCli()
})
