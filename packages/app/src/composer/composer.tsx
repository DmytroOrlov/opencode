import { Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Keybind } from "@opencode/ui/keybind"
import { Slash } from "@opencode/ui/slash"
import { Tooltip } from "@opencode/ui/tooltip"
import { ComposerEditor } from "./editor/editor"
import { DialogSelectModel, ModelSelectorDrawer } from "@/providers/models/select-dialog"
import { DialogSelectModelUnpaid } from "@/providers/models/unpaid"
import { formatKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import type { ComposerModel } from "./model"
import type { ComposerModelLabel } from "./model-label"
import {
  createModelChipState,
  selectModelChipPending,
  transitionModelChip,
  type ModelChipEvent,
} from "./model-chip-machine"
import type { ComposerFallbackStatus } from "@/session/composer/selection"
import type { ModelKey, ModelSelection } from "@/providers/models/selection"

/**
 * What a chip says about a model it can identify while the workspace catalog cannot name it: the picker's existing
 * unavailable affordance, `dialog.model.unavailable` (FR-020 read with FR-030 — the chip must still name the model
 * identity, never go blank, because a blank chip hides a fallback that is configured). Undefined only when the slot
 * knows no model at all, which is where each chip falls back to its own empty-state copy.
 */
function modelIdentity(selection: ModelSelection, language: ReturnType<typeof useLanguage>) {
  const model = selection.current()

  if (model) return model.name
  const key = selection.key()

  return key ? language.t("dialog.model.unavailable", { model: key.modelID }) : undefined
}

/**
 * What the fallback chip says for each `ComposerFallbackStatus` (FR-029): the model recovery would use, that the
 * fallback is off, or that it would repeat the primary model. Always derived from the status, never a stored label.
 */
function fallbackChipLabel(
  status: ComposerFallbackStatus,
  fallback: ModelSelection & { enabled: () => boolean },
  language: ReturnType<typeof useLanguage>,
) {
  if (status === "model") return modelIdentity(fallback, language)

  if (status === "off") return language.t("ui.sessionTurn.status.fallback.none")

  return language.t("ui.sessionTurn.status.fallback.sameModel")
}

export function Composer(props: {
  class?: string
  model: ComposerModel
  borderUnderlay?: boolean
  readOnly?: boolean
  suggestionBoundary?: () => HTMLElement | undefined
}) {
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()

  const modelName = () => {
    const preview = props.model.model.preview

    if (preview) return preview.model
    const selection = props.model.model.selection

    // The identity rule is the chip's everywhere: a named model, else the catalog-missing affordance, else this
    // composer's empty-state copy (`dialog.model.select.title`).
    return modelIdentity(selection, language) ?? language.t("dialog.model.select.title")
  }

  const modelLabel = () => {
    const preview = props.model.model.preview
    const label = preview ? preview.label : props.model.model.label

    if (label) return label

    return { provider: preview ? preview.provider : props.model.model.providerName, model: modelName() }
  }

  return (
    <div class="flex flex-col gap-3">
      <ComposerEditor
        controller={props.model}
        borderUnderlay={props.borderUnderlay}
        readOnly={props.readOnly}
        class={props.class}
        modelControlsVisible={!props.model.model.loading || !!props.model.model.preview}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        alternateKeybind={[formatKeybind("mod", language.t), "↵"]}
        queueFirstKeybind={[formatKeybind("alt", language.t), "↵"]}
        queueFirstLabel={language.t("session.queue.first")}
        exitShellKeybind={[formatKeybind("esc", language.t)]}
        suggestionBoundary={props.suggestionBoundary}
        modelControl={
          <ComposerModelControl
            loading={props.model.model.loading}
            preview={!!props.model.model.preview}
            paid={props.model.model.paid}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.model.model.selection}
            label={modelLabel()}
            fallbackKey={props.model.model.fallback.key()}
            onClose={props.model.restoreFocus}
            onUnpaidClick={() => dialog.show(() => <DialogSelectModelUnpaid model={props.model.model.selection} />)}
          />
        }
        fallbackControl={
          <ComposerFallbackChip
            loading={props.model.model.loading}
            fallback={props.model.model.fallback}
            status={props.model.model.fallbackStatus}
            primaryKey={props.model.model.selection.key()}
            onClose={props.model.restoreFocus}
          />
        }
      />
    </div>
  )
}

function ComposerModelControl(props: {
  loading: boolean
  preview: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: ComposerModel["model"]["selection"]
  label: ComposerModelLabel
  /** The model held in the fallback slot, offered here as an ordinary row (FR-024/FR-033). */
  fallbackKey: ModelKey | undefined
  onClose: () => void
  onUnpaidClick: () => void
}) {
  // A preview paints the chip in its resting state, and the loaded names replace it in place.
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? (props.loading && !props.preview))
  const mobile = createMediaQuery("(max-width: 767px)")
  const dialog = useDialog()

  const open = (detail: number) => {
    if (!props.paid) return props.onUnpaidClick()
    // A pointer open keeps focus in the composer, so the dialog returns it to the caret. A keyboard open
    // (a click with no pointer presses) returns focus to this trigger instead of moving it to the editor.
    void dialog.show(
      () => <DialogSelectModel model={props.model} include={() => props.fallbackKey} />,
      detail === 0 ? undefined : props.onClose,
    )
  }

  // A previewed chip is visible before the catalog loads, so a click on it opens the dialog once loading finishes,
  // unless the user moved on first.
  const [chip, setChip] = createSignal(createModelChipState())
  const pending = createMemo(() => selectModelChipPending(chip()))
  let timer: ReturnType<typeof setTimeout> | undefined
  let trigger: HTMLButtonElement | undefined

  const dispatch = (event: ModelChipEvent) => {
    const next = transitionModelChip(chip(), event)
    setChip(next.state)
    next.effects.forEach((effect) => {
      if (effect.type === "open") return open(effect.detail)
      clearTimeout(timer)

      if (effect.type === "timer.start")
        timer = setTimeout(() => dispatch({ type: "timed-out", attempt: effect.attempt }), effect.delayMs)
    })
  }

  createEffect(() => {
    if (!props.loading) untrack(() => dispatch({ type: "loaded", mobile: mobile(), dialogOpen: !!dialog.active }))
  })

  createEffect(() => {
    if (mobile() || dialog.active) untrack(() => dispatch({ type: "cancelled" }))
  })

  // Any other press, key or window switch means the user moved on, so the late catalog must not pop the dialog.
  createEffect(() => {
    if (!pending()) return
    const cancel = () => dispatch({ type: "cancelled" })
    makeEventListener(
      document,
      "pointerdown",
      (event) => {
        if (!(event.target instanceof Node && trigger?.contains(event.target))) cancel()
      },
      { capture: true },
    )
    makeEventListener(document, "keydown", cancel, { capture: true })
    makeEventListener(window, "blur", cancel)
  })

  onCleanup(() => dispatch({ type: "disposed" }))

  const content = () => (
    <>
      <span class="flex min-w-0 whitespace-nowrap leading-4">
        <Show when={props.label.provider}>
          {(name) => (
            <>
              <bdi class="min-w-0 shrink-[2] truncate text-v2-text-text-faint">{name()}</bdi>
              <Slash />
              <span class="sr-only">{" / "}</span>
            </>
          )}
        </Show>
        <bdi class="min-w-0 truncate">{props.label.model}</bdi>
      </span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )

  return (
    <Show when={!props.loading || props.preview}>
      <div class="flex min-w-0 items-center gap-2">
        <Tooltip
          inactive={mobile()}
          placement="top"
          value={
            <>
              {props.title}
              <Keybind keys={props.keybind} variant="neutral" />
            </>
          }
        >
          {/* While loading, the drawer would open on a catalog that isn't there yet, so the inert chip stands in. */}
          <Show
            when={mobile() && !props.loading}
            fallback={
              <Button
                ref={trigger}
                data-action="composer-model"
                data-control-type="dialog"
                variant="ghost-muted"
                size="normal"
                class="min-w-0 max-w-[60cqw] justify-start ![font-weight:440] !px-0"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                style={{ height: "28px" }}
                aria-busy={pending() || undefined}
                onMouseDown={(event: MouseEvent) => event.preventDefault()}
                onClick={(event: MouseEvent) =>
                  dispatch({
                    type: "clicked",
                    detail: event.detail,
                    loading: props.loading,
                    mobile: mobile(),
                    dialogOpen: !!dialog.active,
                  })
                }
              >
                {content()}
              </Button>
            }
          >
            <ModelSelectorDrawer
              model={props.model}
              include={() => props.fallbackKey}
              trigger={(triggerProps) => (
                <Button
                  {...triggerProps}
                  variant="ghost-muted"
                  size="normal"
                  style={{ height: "28px" }}
                  class="min-w-0 max-w-[60cqw] justify-start ![font-weight:440] !px-0"
                  classList={{ "animate-in fade-in": shouldAnimate() }}
                  data-action="composer-model"
                  data-control-type="drawer"
                >
                  {content()}
                </Button>
              )}
              onClose={props.onClose}
            />
          </Show>
        </Tooltip>
        {/* The fallback chip is its own row item (`ComposerFallbackChip` below), so the row reads model → variant →
          fallback model → fallback variant, and nothing here acts on the pair: a row click in either picker does
          (FR-004). */}
      </div>
    </Show>
  )
}

/**
 * The fallback chip: it names what recovery would use, or why it would not, without opening a picker (FR-029/FR-030).
 * Its content is the derived `fallbackStatus`, never a stored flag, and its picker writes config while offering this
 * composer's primary model as an ordinary row (FR-024/FR-033) and the "None" action that turns the fallback off
 * (FR-012).
 */
function ComposerFallbackChip(props: {
  loading: boolean
  fallback: ModelSelection & { enabled: () => boolean }
  status: ComposerFallbackStatus
  primaryKey: ModelKey | undefined
  onClose: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const mobile = createMediaQuery("(max-width: 767px)")

  const content = () => (
    <>
      <bdi class="min-w-0 truncate">
        {fallbackChipLabel(props.status, props.fallback, language)}
      </bdi>
      <span class="-ms-0.5 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )

  // The two-word label is never the only carrier of that meaning: a fallback that would repeat the primary model says
  // so, and why (FR-029).
  const description = () =>
    props.status === "inactive" ? language.t("ui.sessionTurn.status.fallback.inactiveDescription") : undefined

  return (
    <Show when={!props.loading}>
      <Tooltip placement="top" value={language.t("ui.sessionTurn.status.fallback")}>
        <Show
          when={mobile()}
          fallback={
            <Button
              variant="ghost-muted"
              size="normal"
              style={{ height: "28px" }}
              class="min-w-0 max-w-[170px] justify-start ![font-weight:440] !px-0"
              aria-label={language.t("ui.sessionTurn.status.fallback")}
              aria-description={description()}
              data-action="composer-fallback-model"
              data-control-type="dialog"
              // The chip's variant control needs the picker's own name: the row has two of them, and a shared
              // `ModelSelector` control falls back to a generic "Switch model" otherwise (FR-034's naming rule).
              title={language.t("ui.promptInput.chooseFallbackVariant")}
              onMouseDown={(event: MouseEvent) => event.preventDefault()}
              onClick={(event: MouseEvent) =>
                void dialog.show(
                  () => (
                    <DialogSelectModel
                      model={props.fallback}
                      include={() => props.primaryKey}
                      none={() => !props.fallback.enabled()}
                    />
                  ),
                  event.detail === 0 ? undefined : props.onClose,
                )
              }
            >
              {content()}
            </Button>
          }
        >
          <ModelSelectorDrawer
            model={props.fallback}
            include={() => props.primaryKey}
            none={() => !props.fallback.enabled()}
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                variant="ghost-muted"
                size="normal"
                style={{ height: "28px" }}
                class="min-w-0 max-w-[170px] justify-start ![font-weight:440] !px-0"
                aria-label={language.t("ui.sessionTurn.status.fallback")}
                aria-description={description()}
                data-action="composer-fallback-model"
                data-control-type="drawer"
                title={language.t("ui.promptInput.chooseFallbackVariant")}
              >
                {content()}
              </Button>
            )}
            onClose={props.onClose}
          />
        </Show>
      </Tooltip>
    </Show>
  )
}
