import { describe, expect, mock, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { render } from "solid-js/web"

;(globalThis as typeof globalThis & { React?: { createElement: (component: (props: unknown) => unknown, props: unknown) => unknown } }).React = {
  createElement: (component, props, ...children: unknown[]) => {
    if (props && children.length > 0) (props as { children?: unknown }).children = children.length === 1 ? children[0] : children
    if (typeof component === "function") return component(props)
    const element = document.createElement(component)
    const ref = (props as { ref?: (element: HTMLElement) => void } | null)?.ref
    if (ref) ref(element)
    return element
  },
}

const primary = { id: "primary", name: "primary", provider: { id: "provider", name: "provider" } }
const fallback = { id: "fallback", name: "fallback", provider: { id: "provider", name: "provider" } }

let paidSelector: { items?: () => unknown[]; onSelect?: (item: unknown) => unknown } | undefined
let unpaidDialog: { onSelect?: (item: unknown) => unknown } | undefined
let variantSelect: { onSelect?: (value: string) => unknown } | undefined
let modelButton: { onClick?: () => unknown } | undefined
const legacyCapture = globalThis as typeof globalThis & {
  __legacyPaidSelector?: typeof paidSelector
  __legacyUnpaidDialog?: typeof unpaidDialog
}

const noop = () => null

mock.module("@/components/dialog-select-model", () => ({
  ModelSelectorPopover: (props: typeof paidSelector) => {
    paidSelector = props ?? undefined
    legacyCapture.__legacyPaidSelector = paidSelector
    return null
  },
  ModelSelectorPopoverV2: noop,
  DialogSelectModel: noop,
}))
mock.module("@/components/dialog-select-model-unpaid", () => ({
  DialogSelectModelUnpaid: (props: typeof unpaidDialog) => {
    unpaidDialog = props ?? undefined
    legacyCapture.__legacyUnpaidDialog = unpaidDialog
    return null
  },
}))
mock.module("@/components/dialog-select-model-unpaid-v2", () => ({ DialogSelectModelUnpaidV2: noop }))
mock.module("@/context/file", () => ({
  selectionFromLines: () => undefined,
  useFile: () => ({
    pathFromTab: (tab: string) => tab,
    tab: (path: string) => path,
    load: async () => {},
    searchFilesAndDirectories: async () => [],
  }),
}))
mock.module("@/context/layout", () => ({
  useLayout: () => ({
    fileTree: { setTab: () => {} },
  }),
}))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ directory: "/repo" }) }))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    data: {
      session_diff: {},
      session_working: () => false,
      message: {},
      reference: [],
      mcp_resource: {},
      command: [],
    },
    session: { get: () => undefined },
  }),
}))
mock.module("@/context/comments", () => ({
  useComments: () => ({
    all: () => [],
    setActive: () => {},
    setFocus: () => {},
    focus: () => undefined,
    replace: () => {},
  }),
}))
mock.module("@/context/command", () => ({
  useCommand: () => ({
    register: () => {},
    options: [],
    keybind: () => undefined,
    keybindParts: () => [],
    trigger: () => {},
  }),
}))
mock.module("@/context/permission", () => ({
  usePermission: () => ({ isAutoAcceptingDirectory: () => false, isAutoAccepting: () => false }),
}))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web", os: "linux", openAttachmentPickerDialog: async () => {} }),
}))
mock.module("@/context/prompt", () => ({
  DEFAULT_PROMPT: [{ type: "text", content: "", start: 0, end: 0 }],
  isCommentItem: () => false,
  isPromptEqual: () => true,
  usePrompt: () => ({
    ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
    current: () => [],
    cursor: () => 0,
    dirty: () => false,
    context: { items: () => [], replaceComments: () => {} },
    capture: () => ({ current: () => [] }),
    set: () => {},
  }),
}))
mock.module("@/components/prompt-input/editor-dom", () => ({
  createTextFragment: () => document.createTextNode(""),
  getCursorPosition: () => 0,
  setCursorPosition: () => {},
  setRangeEdge: () => {},
}))
mock.module("@/components/prompt-input/attachments", () => ({ createPromptAttachments: () => ({}) }))
mock.module("@/components/prompt-input/files", () => ({
  ACCEPTED_FILE_TYPES: [],
  pickAttachmentFiles: () => {},
}))
mock.module("@/components/prompt-input/history", () => ({
  canNavigateHistoryAtCursor: () => false,
  navigatePromptHistory: () => undefined,
  promptLength: () => 0,
}))
mock.module("@/components/prompt-input/history-store", () => ({
  createPersistedPromptInputHistory: () => ({}),
  createPromptInputHistory: () => ({}),
}))
mock.module("@/components/prompt-input/submit", () => ({
  createPromptSubmit: () => ({ abort: async () => {}, handleSubmit: async () => {} }),
}))
mock.module("@/components/prompt-input/slash-popover", () => ({ PromptPopover: noop }))
mock.module("@/components/prompt-input/context-items", () => ({ PromptContextItems: noop }))
mock.module("@/components/prompt-input/image-attachments", () => ({ PromptImageAttachments: noop }))
mock.module("@/components/prompt-input/drag-overlay", () => ({ PromptDragOverlay: noop }))
mock.module("@/components/prompt-input/placeholder", () => ({ promptPlaceholder: () => "placeholder" }))
mock.module("@/components/prompt-input/transient-state", () => ({
  createPromptInputTransientState: () => [
    { mode: "normal", placeholder: 0, popover: null, slashMenu: false, slashMenuQuery: "", historyIndex: -1, applyingHistory: false },
    () => {},
  ],
}))
mock.module("@/utils/toast", () => ({ showToast: () => {} }))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props: { "data-action"?: string; onClick?: () => unknown }) => {
    if (props["data-action"] === "prompt-model") modelButton = props
    return null
  },
}))
mock.module("@opencode-ai/ui/dock-surface", () => ({ DockShellForm: noop, DockTray: noop }))
mock.module("@opencode-ai/ui/icon", () => ({ Icon: noop }))
mock.module("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: noop }))
mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: noop, TooltipKeybind: noop }))
mock.module("@opencode-ai/ui/v2/button-v2", () => ({ ButtonV2: noop }))
mock.module("@opencode-ai/ui/v2/icon", () => ({ Icon: noop }))
mock.module("@opencode-ai/ui/v2/icon-button-v2", () => ({ IconButtonV2: noop }))
mock.module("@opencode-ai/ui/v2/keybind-v2", () => ({ KeybindV2: noop }))
mock.module("@opencode-ai/ui/v2/menu-v2", () => ({ MenuV2: noop }))
mock.module("@opencode-ai/ui/v2/tooltip-v2", () => ({ TooltipV2: noop }))
mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: noop }))
mock.module("@opencode-ai/ui/select", () => ({
  Select: (props: { triggerProps?: { "data-action"?: string }; onSelect?: (value: string) => unknown }) => {
    if (props.triggerProps?.["data-action"] === "prompt-model-variant") variantSelect = props
    return null
  },
}))
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: async (render: () => unknown) => render(),
  }),
}))
mock.module("@opencode-ai/ui/image-preview", () => ({ ImagePreview: noop }))
mock.module("@/pages/session/helpers", () => ({
  createSessionTabs: () => ({ activeFileTab: () => undefined }),
}))
mock.module("@/utils/model-fallback", () => ({}))

const selection = {
  current: () => primary,
  variant: {
    list: () => ["high", "low"],
    current: () => "high",
  },
}

const controls = (paid: boolean, pair: { primaryModels: () => unknown[]; selectPrimary: (item: unknown) => unknown; selectVariant: (value: string | undefined) => unknown }) => ({
  agents: { available: [], options: [], current: "build", loading: false, visible: true, select: () => {} },
  model: { selection, pair, paid, loading: false },
  session: {
    id: "session",
    tabs: { active: () => undefined, all: () => [], open: async () => {}, setActive: () => {} },
    reviewPanel: { opened: () => false, open: () => {} },
  },
})

describe("legacy PromptInput model-pair seam", () => {
  test("paid primary and variant controls use the supplied pair authority", async () => {
    const primaryModels = () => [primary, fallback]
    let selected: unknown
    let selectedVariant: string | undefined
    const pair = {
      primaryModels,
      selectPrimary: (item: unknown) => {
        selected = item
      },
      selectVariant: (value: string | undefined) => {
        selectedVariant = value
      },
    }
    const { PromptInput } = await import("@/components/prompt-input")

    await createRoot(async (dispose) => {
      const mounted = document.createElement("div")
      document.body.append(mounted)
      const unmount = render(() => createComponent(PromptInput, { controls: controls(true, pair) }), mounted)
      await Promise.resolve()
      const paid = paidSelector ?? legacyCapture.__legacyPaidSelector
      expect(paid?.items).toBe(primaryModels)
      expect(paid?.onSelect).toBe(pair.selectPrimary)
      paid?.onSelect?.(fallback)
      variantSelect?.onSelect?.("low")
      expect(selected).toBe(fallback)
      expect(selectedVariant).toBe("low")
      unmount()
      mounted.remove()
      dispose()
    })
  })

  test("unpaid primary uses the same pair callback and never direct selection.set", async () => {
    let directSet = 0
    let selected: unknown
    const pair = {
      primaryModels: () => [primary, fallback],
      selectPrimary: (item: unknown) => {
        selected = item
      },
      selectVariant: () => {},
    }
    const unpaidSelection = { ...selection, set: () => directSet++ }
    const { PromptInput } = await import("@/components/prompt-input")

    await createRoot(async (dispose) => {
      const mounted = document.createElement("div")
      document.body.append(mounted)
      const unmount = render(
        () => createComponent(PromptInput, { controls: { ...controls(false, pair), model: { ...controls(false, pair).model, selection: unpaidSelection } } }),
        mounted,
      )
      await Promise.resolve()
      modelButton?.onClick?.()
      const unpaid = unpaidDialog ?? legacyCapture.__legacyUnpaidDialog
      unpaid?.onSelect?.(fallback)
      expect(selected).toBe(fallback)
      expect(directSet).toBe(0)
      unmount()
      mounted.remove()
      dispose()
    })
  })
})
