import { runTlsCaBootstrap } from "../../../src/bootstrap"

const args = process.argv.slice(2)
const sepIdx = args.indexOf("--")
const url = sepIdx >= 0 ? args[sepIdx + 1] : args[args.length - 1]
if (!url || !url.startsWith("https://")) {
  console.error("Usage: bootstrap-probe.ts [flags] [--] <url>")
  process.exit(1)
}

await runTlsCaBootstrap(async () => {
  if (process.env.OPENCODE_TLS_CA_BOOTSTRAPPED) {
    console.error("OPENCODE_TLS_CA_BOOTSTRAPPED leaked into verified child:", process.env.OPENCODE_TLS_CA_BOOTSTRAPPED)
    process.exit(3)
  }
  if (process.env.BUN_OPTIONS) {
    console.error("BUN_OPTIONS leaked into verified child:", process.env.BUN_OPTIONS)
    process.exit(2)
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: true, ts: Date.now() }),
  })
  if (!response.ok) process.exit(1)
  process.exit(0)
})
