export * as HarnessEnvironment from "./environment"

const allowed = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "COPILOT_HOME",
  "CURSOR_CONFIG_DIR",
  "SystemRoot",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "ComSpec",
] as const

export function make() {
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = globalThis.process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
}
