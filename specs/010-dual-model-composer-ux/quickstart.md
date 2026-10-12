# Quickstart: verifying the model-pair composer

## Manual verification (dev)

From the repository root, start the backend; then in another shell start the app against it:

```sh
bun dev serve --port 4096                 # backend
bun --cwd packages/app dev -- --port 4444 # app
```

Open `http://localhost:4444` (never `opencode dev web`, which proxies production and hides local UI changes). Do not restart either process to see changes; the app hot-reloads.

Walk the pair in this order, at desktop width (≥768px) and then at phone width (≤767px), in both LTR and an RTL locale:

1. Control row reads **primary model → primary variant → fallback model → fallback variant**, beside the agent control. No `⇄` or `×` buttons.
2. Hover away: each variant control showing `default` goes quiet independently; hovering or keyboard-focusing the composer reveals both.
3. Open the primary model picker and click the model currently shown in the fallback chip → both chips swap in one frame, each keeping its own variant; the fallback chip's label for a model the user hid stays readable.
4. Open the fallback picker and click the model currently shown in the primary chip → same swap.
5. Fallback picker "None" → chip reads "None"; reload the page → still "None" (no configured/default model returns).
6. Make the primary equal the configured fallback → the fallback chip reads "Same model", and the settings value is untouched (check with `GET /api/config` or Settings > Models); pick a different primary → the fallback model and its variant come back with no click.
7. Choose a model in neither slot, having previously used it with a variant → the variant it had recorded for *that model* returns; it never inherits the replaced model's variant or the other slot's. Works the same in a fresh draft (new session) and in an existing session — these are two owners, so check both.
8. Exchange through the variant flyout: open the primary picker, hover the row holding the fallback's model, and choose a variant in its flyout. The check mark next to the variant already matches what the chip will show after the exchange, and the clicked variant wins. Repeat using Tab + `Enter` instead of a mouse: same result.
9. Hide a model (Settings > Models, or `manage.tsx` visibility UI) that sits in the fallback slot, then exchange it from the primary picker → both chips swap, and the model you hid is still hidden in the Settings list afterwards. It is still offered in the primary picker as that one row.
10. Keyboard: Tab reaches every shown control in displayed order; Shift+Mod+D cycles the primary variant; `/model` from the command palette changes the primary slot and swaps when it names the fallback's model (this is the path that must not bypass the pair rule); Esc/back-arrow leaves a picker menu and returns focus as it does today.

## Automated validation

| Check | Command | Covers |
|---|---|---|
| Types | `bun run typecheck` and `bun run typecheck:tsc` (root, turbo) — plus `bun --cwd packages/app typecheck:e2e` when e2e specs change | Adapter contract change (`swap` → `exchange`), new view entries, new picker props; the e2e project is type-checked separately |
| Unit | `bun --cwd packages/app test:unit`, `bun --cwd packages/core test` | `session/composer/selection.test.ts` pair math, exchange phase (including the A/B → B/A → select C → old-failure case) and visibility capture/restore, `providers/models/variant.test.ts` recorded-variant selector, `composer/model-chip-machine.test.ts`, `selection-machine.test.ts` (unchanged assertions), core `session-runner.test.ts` fallback scenarios |
| Browser-conditioned integration | `bun --cwd packages/app test:browser` (runs `test-browser/model-selection.test.ts`, which spawns the fixture with `--conditions=browser`) | Primary/fallback owner behaviour with real providers: refusal, recorded variant in both draft and session, config-write failure, and an injected record failure (`setItem` returning `false` + `flushPersisted()`) with the pair restored |
| Component | `bun --cwd packages/app test:components` | Control-row order, quiet-at-rest parity, drawer, overflow story, focus |
| E2E | `bun --cwd packages/app test:e2e` (CI: `bun --cwd packages/app test:e2e:built --shard=… $PLAYWRIGHT_ARGS`) | `e2e/regression/composer.spec.ts`, `e2e/regression/mobile-model-pickers.spec.ts`, `e2e/regression/new-session.spec.ts`, `e2e/user-story/model-selection-flow.spec.ts` |
| Other packages | `bun --cwd packages/session-ui test:components` | Session-turn fallback status copy stays intact |
| Lint / generated surface | `bun run lint`, `bun --cwd packages/client check:generated`, `bun --cwd packages/protocol check:generated` | i18n and style rules; SDK/client generated files must be byte-identical |
| Perf (composer touched) | `strobe bench packages/app/perf/composer.bench.ts --base origin/dev --head .` then `navigation.bench.ts` | Control row and model-chip cost (per `packages/app/AGENTS.md` Priorities) |

If a check cannot run locally (no GPU/Chromium deps, Windows timing, strobe on a busy machine), record it in the completion notes with the reason, as the constitution's validation gate requires.

## Focused test entry points while iterating

```sh
bun --cwd packages/app test:unit --  selection           # path/name filter (note the space after --)
bun --cwd packages/app test:browser -- model-selection
bun --cwd packages/app test:components -- composer
bun --cwd packages/app test:e2e -- -g "model" e2e/user-story/model-selection-flow.spec.ts
bun --cwd packages/core test -- session-runner
```

Two harness prerequisites before scripting the failure and reload scenarios:

- The e2e mock server answers `PATCH /api/experimental/config` with a static `NoContent` (`e2e/utils/mock-server.ts:945`) while `GET /api/config` serves `configEntries` (`e2e/utils/mock-api.ts:118`): make that handler apply the PATCH to the config it later serves, or FR-012/013/021 reload assertions are vacuous. For the half-exchange failure scenario, make it reject once, then resume.
- A primary **record** failure is injected in the browser fixture, not in e2e: make the fixture's storage `setItem` return `false` (`runtime/persistence/storage.ts:159`) and drive the save with `flushPersisted()` (`runtime/persistence/persist.ts:20`). Never sleep to wait for it — the save window is `persistSaveDelay = 100` (`persist.ts:13`), and `persistStore` keeps the store dirty after a failure (`persist-machine.ts:108-112`), which is why the composer needs the added `recordFailure()` accessor to learn about it at all.
