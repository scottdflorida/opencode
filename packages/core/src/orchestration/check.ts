export * as OrchestrationCheck from "./check"

import path from "path"
import { realpathSync } from "fs"
import { Orchestration } from "@opencode-ai/schema/orchestration"

export function directory(root: string, check: Orchestration.Check) {
  const relative = check.workingDirectory?.trim() || "."
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error(`Check ${check.name} has an invalid working directory`)
  const source = realpathSync(root)
  const target = realpathSync(path.resolve(root, relative))
  const inside = path.relative(source, target)
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    throw new Error(`Check ${check.name} working directory leaves the workspace`)
  return target
}

export function displayDirectory(root: string, check: Orchestration.Check) {
  const relative = check.workingDirectory?.trim() || "."
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error(`Check ${check.name} has an invalid working directory`)
  return path.resolve(root, relative)
}
