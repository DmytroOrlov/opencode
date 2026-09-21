const url = process.argv[2]
if (!url) {
  console.error("Usage: probe.ts <url>")
  process.exit(1)
}

const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ probe: true, ts: Date.now() }),
})

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${await response.text()}`)
  process.exit(1)
}

console.log(await response.text())
