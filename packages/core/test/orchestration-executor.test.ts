import { expect, test } from "bun:test"
import { OrchestrationExecutor } from "@opencode-ai/core/orchestration/executor"

test("summarizes structured Git status without storing path names", () => {
  expect(OrchestrationExecutor.summarizeGitStatus(" M src/a.ts\nA  src/b.ts\n?? secret.txt\nMM src/c.ts\n")).toEqual({
    changed: 4,
    staged: 2,
    unstaged: 2,
    untracked: 1,
  })
})
