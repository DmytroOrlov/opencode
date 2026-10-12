# Contracts

This feature changes no product-facing API, protocol, SDK, schema, or persisted record shape:

- `PATCH /api/experimental/config` (`packages/protocol/src/groups/config.ts`, `packages/client/src/promise/generated/client.ts:1788`) already carries `{ shell, fallback }`, and `packages/server/test/config.test.ts:94-115` already proves a fallback write, a variant-bearing write, and an explicit `null` write. `bun run check:generated` must stay clean.
- The session commit path (`ModelSelected`, `trackSessionCommit`) is unchanged.
- Settings storage (`Persistence` records) is unchanged, so `packages/app/test-browser/schema-persistence.test.ts` and `settings-keybinds.test.ts` are untouched.

What *is* specified here is the internal contract between the composer and its model controls — the surface `ComposerControls["model"]` in `packages/app/src/composer/adapter.ts`, the pickers in `packages/app/src/providers/models/select-dialog.tsx`, and the control row in `packages/app/src/composer/editor/editor.tsx`. See [composer-model-controls.md](./composer-model-controls.md).
