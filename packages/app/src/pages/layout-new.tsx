import { createEffect, onCleanup, onMount, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { getFilename } from "@opencode-ai/core/util/path"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { sessionHref } from "@/utils/session-route"
import { playSoundById } from "@/utils/sound"
import { dismissToast, setV2Toast, showToast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const permission = usePermission()
  const settings = useSettings()
  const language = useLanguage()
  const navigate = useNavigate()
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))

  onMount(() => {
    const toasts = new Map<string, number>()
    const alerted = new Map<string, number>()
    const dismiss = (key: string) => {
      const id = toasts.get(key)
      if (id === undefined) return
      dismissToast(id)
      toasts.delete(key)
    }
    const unsub = serverSDK().event.listen((event) => {
      const type = event.details?.type
      if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") {
        const request = event.details.properties as { sessionID: string }
        dismiss(`${event.name}:${request.sessionID}`)
        return
      }
      if (type !== "permission.asked" && type !== "question.asked") return
      const request = event.details.properties as { sessionID: string }
      if (type === "permission.asked" && permission.autoResponds(event.details.properties, event.name)) return
      const key = `${event.name}:${request.sessionID}`
      if (Date.now() - (alerted.get(key) ?? 0) < 5_000) return
      alerted.set(key, Date.now())
      const [store] = serverSync().child(event.name, { bootstrap: false })
      const session = store.session.find((item) => item.id === request.sessionID)
      const title = type === "permission.asked"
        ? language.t("notification.permission.title")
        : language.t("notification.question.title")
      const description = type === "permission.asked"
        ? language.t("notification.permission.description", { sessionTitle: session?.title ?? language.t("command.session.new"), projectName: getFilename(event.name) })
        : language.t("notification.question.description", { sessionTitle: session?.title ?? language.t("command.session.new"), projectName: getFilename(event.name) })
      const href = sessionHref(server.key, request.sessionID)
      if (type === "permission.asked") {
        if (settings.sounds.permissionsEnabled()) void playSoundById(settings.sounds.permissions())
        if (settings.notifications.permissions()) void platform.notify(title, description, () => navigate(href))
      }
      if (type === "question.asked" && settings.notifications.agent()) void platform.notify(title, description, () => navigate(href))
      if (window.location.pathname === href || (session?.parentID && window.location.pathname.endsWith(`/session/${session.parentID}`))) return
      dismiss(key)
      toasts.set(key, showToast({ persistent: true, icon: type === "permission.asked" ? "checklist" : "bubble-5", title,
        description, actions: [
          { label: language.t("notification.action.goToSession"), onClick: () => navigate(href) },
          { label: language.t("common.dismiss"), onClick: "dismiss" },
        ] }))
    })
    onCleanup(() => { unsub(); toasts.forEach((id) => dismissToast(id)) })
  })

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense>{props.children}</Suspense>
      </main>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
