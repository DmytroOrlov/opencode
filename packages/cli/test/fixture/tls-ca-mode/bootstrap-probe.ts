import { runTlsCaBootstrap } from "../../../src/bootstrap"

const args = process.argv.slice(2)
const separator = args.indexOf("--")
const url = separator >= 0 ? args[separator + 1] : args[args.length - 1]
if (!url || !url.startsWith("https://")) {
  console.error("Usage: bootstrap-probe.ts [flags] [--] <url>")
  process.exit(1)
}

await runTlsCaBootstrap(async () => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: true, timestamp: Date.now() }),
  })
  if (!response.ok || (await response.text()) !== "ok") process.exit(1)
  process.exit(0)
})
