import { Show, createMemo } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Keybind } from "@opencode/ui/keybind"
import { ProviderModelIcon } from "@/providers/models/provider-group"
import { Tooltip } from "@opencode/ui/tooltip"
import { ComposerEditor } from "./editor/editor"
import { ModelSelectorPopover } from "@/providers/models/select-dialog"
import { DialogSelectModelUnpaid } from "@/providers/models/unpaid"
import { formatKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import type { ComposerModel } from "./model"
import type { ModelSelection } from "@/providers/models/selection"

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

  return (
    <div class="flex flex-col gap-3">
      <ComposerEditor
        controller={props.model}
        borderUnderlay={props.borderUnderlay}
        readOnly={props.readOnly}
        class={props.class}
        modelControlsVisible={!props.model.model.loading}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        alternateKeybind={[formatKeybind("mod", language.t), "↵"]}
        exitShellKeybind={[formatKeybind("esc", language.t)]}
        suggestionBoundary={props.suggestionBoundary}
        modelControl={
          <ComposerModelControl
            loading={props.model.model.loading}
            paid={props.model.model.paid}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.model.model.selection}
            provider={props.model.model.selection.current()?.provider}
            modelName={props.model.model.selection.current()?.name ?? language.t("dialog.model.select.title")}
            fallback={props.model.model.fallback}
            swap={props.model.model.swap}
            onClose={props.model.restoreFocus}
            onUnpaidClick={() => dialog.show(() => <DialogSelectModelUnpaid model={props.model.model.selection} />)}
          />
        }
      />
    </div>
  )
}

function ComposerModelControl(props: {
  loading: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: ComposerModel["model"]["selection"]
  fallback: ModelSelection & { enabled: () => boolean }
  swap: () => void
  provider?: { id: string; canonical?: string; name: string }
  modelName: string
  onClose: () => void
  onUnpaidClick: () => void
}) {
  const language = useLanguage()
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? props.loading)
  const mobile = createMediaQuery("(max-width: 767px)")

  const content = () => (
    <>
      <Show when={props.provider}>
        {(provider) => (
          <ProviderModelIcon
            provider={provider()}
            class="shrink-0 opacity-40 transition-opacity duration-150 group-hover:opacity-100"
          />
        )}
      </Show>
      <span class="truncate leading-4">{props.modelName}</span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )

  return (
    <Show when={!props.loading}>
      <div class="flex min-w-0 items-center gap-2">
        <Tooltip
          inactive={mobile()}
          placement="top"
          gutter={4}
          value={
            <>
              {props.title}
              <Keybind keys={props.keybind} variant="neutral" />
            </>
          }
        >
          <Show
            when={props.paid || mobile()}
            fallback={
              <Button
                data-action="composer-model"
                data-control-type="dialog"
                variant="ghost-muted"
                size="normal"
                class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group !px-0"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                style={{ height: "28px" }}
                onClick={props.onUnpaidClick}
              >
                {content()}
              </Button>
            }
          >
            <ModelSelectorPopover
              model={props.model}
              unpaid={!props.paid}
              trigger={(triggerProps) => (
                <Button
                  {...triggerProps}
                  variant="ghost-muted"
                  size="normal"
                  style={{ height: "28px" }}
                  class="min-w-0 max-w-[220px] justify-start ![font-weight:440] group !px-0"
                  classList={{ "animate-in fade-in": shouldAnimate() }}
                  data-action="composer-model"
                  data-control-type={mobile() ? "drawer" : "popover"}
                >
                  {content()}
                </Button>
              )}
              onClose={props.onClose}
            />
          </Show>
        </Tooltip>
        <div class="flex min-w-0 items-center gap-1">
          <Tooltip placement="top" gutter={4} value={language.t("ui.sessionTurn.status.fallback")}>
            <ModelSelectorPopover
              model={props.fallback}
              trigger={(triggerProps) => (
                <Button
                  {...triggerProps}
                  variant="ghost-muted"
                  size="normal"
                  style={{ height: "28px" }}
                  class="min-w-0 max-w-[170px] justify-start truncate ![font-weight:440] group !px-0"
                  aria-label={language.t("ui.sessionTurn.status.fallback")}
                  data-action="composer-fallback-model"
                >
                  <span class="truncate">
                    {props.fallback.current()?.name ?? language.t("ui.sessionTurn.status.fallback")}
                  </span>
                  <span class="-ml-0.5 -mr-1 flex shrink-0">
                    <Icon name="chevron-down" />
                  </span>
                </Button>
              )}
              onClose={props.onClose}
            />
          </Tooltip>
          <Button
            variant="ghost-muted"
            size="normal"
            style={{ height: "28px" }}
            class="!px-1"
            disabled={!props.fallback.current()}
            aria-label={language.t("ui.sessionTurn.action.swapFallback")}
            title={language.t("ui.sessionTurn.action.swapFallback")}
            data-action="composer-fallback-swap"
            onClick={props.swap}
          >
            ⇄
          </Button>
          <Button
            variant="ghost-muted"
            size="normal"
            style={{ height: "28px" }}
            class="!px-1"
            disabled={!props.fallback.enabled()}
            aria-label={`${language.t("ui.sessionTurn.status.fallback")} · ${language.t("common.clear")}`}
            title={language.t("common.clear")}
            data-action="composer-fallback-clear"
            onClick={() => props.fallback.set(undefined)}
          >
            ×
          </Button>
        </div>
      </div>
    </Show>
  )
}
