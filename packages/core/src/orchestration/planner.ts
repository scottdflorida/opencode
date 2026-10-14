export * as OrchestrationPlanner from "./planner"

import { Orchestration } from "@opencode-ai/schema/orchestration"

/** Limits apply after schema decoding, before a proposal becomes durable. */
export function validate(output: Orchestration.PlanOutput): string | undefined {
  if (output.tasks.length < 1 || output.tasks.length > 16) return "A plan must contain 1 to 16 tasks"
  if (output.rationale && output.rationale.length > 2_000) return "Plan rationale is too long"
  if (output.clauses && (output.clauses.length < 1 || output.clauses.length > 8))
    return "A plan must contain 1 to 8 delivery clauses"
  if (
    output.clauses?.some(
      (clause) =>
        !/^[a-z][a-z0-9-]{0,39}$/.test(clause.key) ||
        !clause.description.trim() ||
        clause.description.length > 500,
    ) ||
    (output.clauses && new Set(output.clauses.map((clause) => clause.key)).size !== output.clauses.length)
  )
    return "Delivery clauses must have unique keys and bounded descriptions"

  const keys = new Set(output.tasks.map((task) => task.key))
  if (keys.size !== output.tasks.length) return "Task keys must be unique"

  const invalidTask = output.tasks.find((task) => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(task.key)) return true
    if (!task.title.trim() || task.title.length > 120) return true
    if (task.description && task.description.length > 4_000) return true
    if (task.routeProfile && (!task.routeProfile.trim() || task.routeProfile.length > 80)) return true
    if (task.capabilityTier && task.capabilityTier.length > 80) return true
    if (task.checks.length > 8 || task.dependsOn.length > 15) return true
    if (task.acceptanceCriteria && (task.acceptanceCriteria.length < 1 || task.acceptanceCriteria.length > 8))
      return true
    if (
      task.acceptanceCriteria?.some(
        (criterion) =>
          !/^[a-z][a-z0-9-]{0,39}$/.test(criterion.key) ||
          !criterion.description.trim() ||
          criterion.description.length > 500,
      )
    )
      return true
    if (
      task.acceptanceCriteria &&
      new Set(task.acceptanceCriteria.map((criterion) => criterion.key)).size !== task.acceptanceCriteria.length
    )
      return true
    if (
      task.checks.some(
        (check) =>
          !check.name.trim() || check.name.length > 80 || !check.command.trim() || check.command.length > 1_000 ||
          (check.workingDirectory !== undefined && (
            !check.workingDirectory.trim() || check.workingDirectory.length > 256 ||
            check.workingDirectory.split(/[\\/]/).includes("..") ||
            check.workingDirectory.startsWith("/") || /^[A-Za-z]:[\\/]/.test(check.workingDirectory)
          )),
      )
    )
      return true
    if (new Set(task.dependsOn).size !== task.dependsOn.length) return true
    return task.dependsOn.some((key) => key === task.key || !keys.has(key))
  })
  if (invalidTask) return `Task ${invalidTask.key || "<missing key>"} has invalid fields or dependencies`

  const byKey = new Map(output.tasks.map((task) => [task.key, task]))
  const reaches = (start: string, current: string, visited: ReadonlySet<string>): boolean => {
    if (current === start) return true
    if (visited.has(current)) return false
    const next = new Set(visited).add(current)
    return byKey.get(current)?.dependsOn.some((key) => reaches(start, key, next)) ?? false
  }
  if (output.tasks.some((task) => task.dependsOn.some((key) => reaches(task.key, key, new Set()))))
    return "Task dependencies must be acyclic"
}
