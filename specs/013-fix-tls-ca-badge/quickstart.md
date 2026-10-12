# Quickstart: TLS CA Policy and Badge Parity

**Feature directory**: `specs/013-fix-tls-ca-badge`
**Actual checkout branch**: `011-restore-config-integrity`

Run after implementing [plan.md](./plan.md). This is a validation guide, not a replacement for `tasks.md`.

## Prerequisites

- Dependencies installed.
- Ports 3000, 4096 and 4097 available for Playwright; 4097 must be free for the compiled smoke.
- Chromium installed for Playwright.
- `curl`, `jq` and `lsof` available for the compiled smoke.
- No existing user server is stopped or modified by any command below.

## 1. Baseline before production edits

Run only existing applicable gates; do not require a new test file on HEAD:

```bash
bun run --cwd packages/app test:harness
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e
bun run --cwd packages/app test:unit
bun run --cwd packages/app test:e2e -- --project=chromium regression/multi-server.spec.ts
(cd packages/app && bun test --conditions=browser --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./test-browser/ssh-health.test.ts)
```

Record exact exit codes and counts. The documented feature-012 final full-suite baseline is:

- `bun run --cwd packages/sdk test` → exit 1, 44 pass / 10 fail, all `TLS CA mode has not been verified` at `packages/util/src/tls-ca.ts:104`, in `packages/sdk/test/instances.test.ts`, `packages/sdk/test/request-retention.test.ts` and `packages/sdk/test/instances-effect.test.ts`.
- `bun run --cwd packages/core test` → exit 1, 7636 pass / 38 skip / 3 fail: `packages/core/test/tool-shell.test.ts` ×2 ("conditional substitutions respect once/always", `/bin/bash: wait: pid N is not a child of this shell`, exit 127) and `packages/core/test/shell-scan/compound-parity.test.ts` ×1 (Bash 3.2 compound syntax parse error).

Re-capture them at the current baseline. They remain baseline evidence, never passes or waivers. Reassess SDK attestation failures against the expanded TLS scope.

## 2. Targeted unit tests after correction

From `packages/app`:

```bash
bun test --conditions=solid --only-failures --isolate \
  --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts \
  src/runtime/server/health-machine.test.ts \
  src/runtime/server/health.test.ts \
  src/shell/state/layout.test.ts \
  src/settings/route.test.ts \
  src/shell/titlebar/titlebar-ca-badge.test.ts
```

Expected:

- Layout binding projects the actual `home.server.focused` connection to its key, including an undefined guard and a hydration-time override; cleanup removes only its own binding.
- Session-before-tab, draft, project-navigation `loading` with a resolved connection, Settings project/root/source and exact 4096/4097/sidecar keys.
- Health state machine rejects a stale successful `bundled` and stale unauthorized answer after remove/relist, rejects a non-exact current attempt, emits zero stale notifications and accepts the current answer.
- Credential replacement keeps increasing attempts; a pending retry waiter settles through `answeredSince` on the current accepted answer while the superseded answer is rejected.
- Real driver with controlled promises ignores discarded incarnations; cache identity does not collide across incarnations, owner lifetimes or server keys, expires/clears within its bounds, coalesces within one lifetime and preserves non-owner endpoint-keyed consumers.
- Existing badge mapping assertions remain intact.

Run the existing real-driver browser gate from `packages/app` (also required in S1):

```sh
bun test --conditions=browser --isolate --preload ../ui/test/solid-jsx.ts --preload ./happydom.ts ./test-browser/ssh-health.test.ts
```

Preserve existing SSH stage, endpoint replacement, retry and disposal assertions. Add controlled remove/relist, staged→ready, credential replacement and stale-notification cases using the real `createServerHealth` seam.

## 3. App and typecheck gates

```bash
bun run --cwd packages/app test:harness
bun run --cwd packages/app typecheck
bun run --cwd packages/app typecheck:e2e
bun run --cwd packages/app test:unit
```

Expected: existing assertions preserved; new tests pass; exact exit codes recorded.

## 4. Production-wiring fixtures and e2e

```bash
bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts
bun run --cwd packages/app test:e2e -- --project=chromium regression/multi-server.spec.ts
PLAYWRIGHT_BUILD=1 PLAYWRIGHT_WORKERS=1 \
  bun run --cwd packages/app test:e2e -- --project=chromium regression/tls-ca-badge.spec.ts
```

The `tls-ca-badge` keeper mounts the production-app fixture pattern (`AppInterface` with `servers` and a custom router) at `/e2e/utils/tls-ca-badge.html`; register that entry under the fixture-only Vite inputs for built mode. It exercises the real titlebar, registry and health path.

Expected:

- Three identities: 4096, 4097 and the sidecar shape `{ type: "sidecar", variant: "base", http: { url: endpoint } }`; key `"sidecar"` independent of URL.
- Initial resolved Home selection, hydration-time override, persistence completion and owner cleanup; both Home layouts capture their actual key before Settings opens, including project-navigation resolved loading/fallback.
- Two servers with the same mode: invalidate/change only the destination after switching; the badge follows the destination, not an unchanged label.
- Removed-route identity is unknown, never another server.
- Settings project route uses exact `view.server`, not the inventory fallback.
- Tabless Home/empty state, session-before-tab, draft, Settings selected/source/general and stale health/recovery.
- Healthy-without-mode; unresolved draft→resolved; Home A→session B→Home A; destination initially checking→accepted; Settings A→return B; same-endpoint sidecar/HTTP alias; unauthorized, refresh retention, loss/recovery and credential invalidation in tabless/session routes. Assert label, colour, tooltip and status role.
- Request accounting over equal controlled intervals: zero added `/api/info` requests, poll cycles or auth/retry attempts due to badge/context switches.
- Development and `PLAYWRIGHT_BUILD=1` runs produce identical badge behavior.

## 5. Compiled standalone acceptance

Run from the repository root after T021 and T022. T021 alone builds and tests the final embedded Bun artifact (see §8). T013 must not rebuild it. Use the exact T021 manifest path in `T021_ARTIFACT_MANIFEST` (T021 records the ready-to-run invocation with this environment variable set). The JSON manifest contains `binary` (absolute path to the retained tested executable) and `sha256` (lowercase SHA-256). Confirm the accepted build inputs are unchanged. Missing, mismatched or stale evidence returns to T021/T022; it is not permission to build inside T013.

Run the following as one command with that manifest environment variable set. It never modifies the invoking shell. The Python process owns the temporary environment and only the child it spawned; the browser check completes inside that lifetime. On failure, preserve the failure and print the smoke log before cleanup. The Playwright browser is fresh, uses the existing pairing link, and checks the binary-served frontend rather than Vite. Do not stop an existing listener on 4097.

```bash
python3 - <<'PY'
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import quote

root = Path.cwd()
manifest = json.loads(Path(os.environ["T021_ARTIFACT_MANIFEST"]).read_text())
binary = Path(manifest["binary"])
if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
    raise RuntimeError("Missing or non-executable T021 artifact; return to T021/T022")
with binary.open("rb") as artifact:
    digest = hashlib.file_digest(artifact, "sha256").hexdigest()
if digest != manifest["sha256"]:
    raise RuntimeError("T021 artifact identity mismatch; return to T021/T022")
print(f"T021 artifact: {binary}; SHA-256={digest}", flush=True)
port = 4097
base = f"http://127.0.0.1:{port}"
with socket.socket() as sock:
    sock.bind(("127.0.0.1", port))  # Fail before allocating temp state if occupied.
password = secrets.token_urlsafe(24)
auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()

def request(path, method="GET"):
    req = urllib.request.Request(base + path, method=method,
                                 headers={"Authorization": auth})
    with urllib.request.urlopen(req, timeout=2) as response:
        return json.load(response)

browser = r"""
import { chromium } from '@playwright/test'
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.goto(process.env.SMOKE_PAIR_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-slot="home-panel"]').waitFor({ state: 'visible', timeout: 60000 })
  const badge = page.locator('[data-slot="titlebar-v2"]').getByRole('status').filter({ hasText: /^CA:BUNDLED$/ })
  await badge.waitFor({ state: 'visible', timeout: 30000 })
  if (await badge.count() !== 1) throw new Error('Expected one bundled badge')
  if (await page.locator('[data-slot="tab-label"]').count() !== 0) throw new Error('Expected tabless Home')
  console.log('Home badge: CA:BUNDLED, status role, zero tab labels')
} finally {
  await browser.close()
}
"""
with tempfile.TemporaryDirectory(prefix="opencode-ca-smoke-") as tmp:
    temp = Path(tmp)
    env = dict(os.environ, OPENCODE_PASSWORD=password,
               OPENCODE_DB=str(temp / "opencode.db"),
               OPENCODE_DISABLE_PROJECT_CONFIG="1")
    for key in (
        "OPENCODE_TLS_CA_MODE", "OPENCODE_TLS_CA_BOOTSTRAPPED",
        "BUN_OPTIONS", "NODE_OPTIONS", "BUN_BE_BUN",
        "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "NODE_TLS_REJECT_UNAUTHORIZED",
    ):
        env.pop(key, None)
    for key, subdir in {"HOME": "home", "USERPROFILE": "home",
                        "XDG_CACHE_HOME": "cache", "XDG_CONFIG_HOME": "config",
                        "XDG_DATA_HOME": "data", "XDG_STATE_HOME": "state"}.items():
        directory = temp / subdir
        directory.mkdir(exist_ok=True)
        env[key] = str(directory)
    log = temp / "server.log"
    with log.open("wb") as output:
        child = subprocess.Popen([str(binary), "serve", "--hostname", "127.0.0.1",
                                  "--port", str(port)], cwd=temp, env=env,
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 60
            while True:
                if child.poll() is not None:
                    raise RuntimeError(f"Smoke process exited: {child.returncode}")
                try:
                    info = request("/api/info")
                    break
                except (OSError, ValueError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.25)  # Real runtime smoke only, not a deterministic regression.
            listeners = subprocess.check_output(["lsof", "-nP", "-t", f"-iTCP:{port}",
                                                 "-sTCP:LISTEN"], text=True).splitlines()
            if str(child.pid) not in listeners:
                raise RuntimeError("Authenticated listener is not the smoke child")
            if info.get("tlsCaMode") != "bundled":
                raise RuntimeError(f"Expected bundled, got {info.get('tlsCaMode')!r}")
            print(f"Authenticated /api/info: bundled; PID={child.pid}; binary={binary}", flush=True)
            code = request("/api/pair", "POST")["code"]
            browser_env = dict(os.environ, SMOKE_PAIR_URL=base + "/auth/connect/" + quote(code, safe=""))
            for key in ("BUN_OPTIONS", "NODE_OPTIONS", "BUN_BE_BUN"):
                browser_env.pop(key, None)
            result = subprocess.run(["bun", "-e", browser], cwd=root / "packages/app",
                                    env=browser_env, timeout=120)
            print(f"Browser validation exit: {result.returncode}", flush=True)
            if result.returncode:
                raise SystemExit(result.returncode)
        except BaseException:
            print(log.read_text(errors="replace")[-12000:], flush=True)
            raise
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
PY
```

Record the authenticated-info observation and browser status separately. If pairing navigation or browser environment contradicts the checkout, report the actual failure and perform the same paired-browser check using the existing flow; do not substitute Vite or claim PASS without evidence. The T021 manifest supplies the actual platform-specific binary path; never substitute a different binary. The real smoke supplements deterministic dev/built keeper runs.

## 6. Gate reconciliation

Required after correction: targeted unit tests, app harness, app typecheck, e2e typecheck, full app unit suite, production-wiring fixture/e2e three-identity matrix, new CA badge keeper in development and compiled modes, existing multi-server keeper, and the isolated compiled-binary Home check.

New regression tests must fail decisively against old behavior where applicable. Record exact commands, exit codes, counts and preserved assertions. Any in-scope failure blocks completion. The documented SDK/Core baseline failures above are reported with exact files, reasons and counts; they are neither passes nor waivers.

## 7. Manual behavior check

1. Start the isolated compiled binary on 4097 with `--hostname 127.0.0.1`.
2. Open the application served by that binary and authenticate through the existing pairing flow.
3. Confirm Home with no session tabs shows green `CA:BUNDLED`.
4. Repeat with `system` and with a server that omits the field; confirm `CA:SYSTEM` and `CA:UNKNOWN`.
5. Switch between 4096, 4097 and the Desktop sidecar; confirm the badge follows the current context and never borrows another server's answer.

## 8. TLS launch parity gates (S3/S4)

Before production edits, retain the already captured app baseline; add the existing CLI TLS, self-command, service and standalone tests, existing server process test and affected-package typechecks. Use explicit `./` paths from their package directories and the existing package-specific runner/options; confirm exact commands from current package manifests before the baseline, not newly invented scripts. Record exact exits/counts. Complete the missing Core evidence. Newly discovered red app gates remain blockers for their affected acceptance unless explicitly reconciled; SDK TLS attestation failures must be attributed rather than suppressed.

S3: run the actual CLI TLS unit and integration suites with the existing timeout (`bun test --timeout 30000 ./test/tls-ca-mode.test.ts ./test/tls-ca-mode.integration.test.ts` from `packages/cli`), affected util/CLI typechecks and the existing unverified-server/metadata assertions. Preserve and extend the old tests. S4: run the exact existing focused CLI gate with the existing timeout:

```sh
(
  cd packages/cli &&
  bun test --timeout 30000 \
    ./test/tls-ca-mode.test.ts \
    ./test/tls-ca-mode.integration.test.ts \
    ./test/self-command.test.ts \
    ./test/service.test.ts \
    ./test/standalone.test.ts \
    ./test/server-connection.test.ts
)
```

The `service.test.ts` port-owner conflict regression captures the real OS `lsof`/`ps` answers while its listener is alive and replays them through an exact-argument child PATH fixture. This keeps the production lookup, parsing and diagnostic construction under test without depending on a live OS-wide scan completing inside the best-effort deadline. All six files, every test, all assertions and the timeout requirement remain mandatory. S4 also runs all affected typechecks and must exercise normal launch owners in both modes, not just injected commands. Use the existing build and smoke entrypoints (`build`, `build:node`, `script/service-smoke.ts`); verify their current host-build options before execution. Both native artifacts must execute clean default and explicit bundled/system, actual recovery, normal child propagation and ordinary controlled HTTPS; source Bun and Node execute the same applicable semantics. For rejected bundled requests assert zero HTTP invocations after a successful positive control and prove that the verified callback attempted TLS. Record runtime, artifact identity, selected and reported mode, actual exits and counts. Preserve real Node SEA recovery argument and FFI evidence. Do not report a source/bundle run as native artifact evidence.

S3 SDK disposition: run `bun run --cwd packages/sdk test` and affected server/SDK typechecks; the ten baseline failures are in scope. A fresh process for each public Promise/Effect SDK host must create and make ordinary in-process requests without CLI bootstrap or a verification preload; assert absent optional mode when unattested and exact mode when attested. Keep the existing strict unverified-listener rejection and authenticated verified-listener assertions. Do not change host TLS or weaken the verifier.

T021 production drivers (both native artifacts): use real `service start` through `commands/handlers/service/start.ts` (not just direct `serve --service`), and a normal standalone CLI resolution through `services/server-connection.ts::resolve` / `Standalone.start()` in isolated state. Hold the lease/command alive, capture its endpoint and authenticated child PID/mode, and clean up only owned processes. Reuse the `service-smoke.ts` plugin installation path for a fixture plugin performing ordinary `fetch` in the artifact process; record the attempt marker, PID, successful control and specific certificate-rejection outcome with zero rejected HTTP handler calls. Force SEA recovery with `NODE_TLS_REJECT_UNAUTHORIZED=0`; assert exact application args and exercise required FFI in the recovered native process. Include no-flag launches with ambient `OPENCODE_TLS_CA_MODE=system` and an invalid value as well as the clean launch and both explicit selectors. No injected command or test-only production bypass as evidence. Exact fixture invocation and lifecycle APIs come from the current targeted implementation bundle.

T021 alone runs `bun run --cwd packages/cli build --single --skip-install` for the final embedded Bun artifact (do not skip web UI). Run its native matrix against this binary, record the successful build and relevant input identity, and retain the executable and the JSON manifest (`binary`, `sha256`) outside the worktree for handoff (the binary may remain at its build output path). Supply the exact manifest path in the T013 invocation. Do not replace the binary between acceptance runs.

Run T013 once with that retained artifact after S4/T022, without any build; the script in §5 clears ambient selectors, certificate overrides and runtime options, including empty values, and preserves the clean no-flag bundled and listener-PID assertions. Reuse sufficient gate/build evidence only when all relevant inputs are unchanged; no in-scope red gate is waived.
