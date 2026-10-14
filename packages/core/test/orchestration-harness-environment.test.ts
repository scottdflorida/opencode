import { expect, test } from "bun:test"
import { HarnessEnvironment } from "@opencode-ai/core/orchestration/harness/environment"

test("passes CLI setup variables without unrelated API credentials", () => {
  const environment = HarnessEnvironment.make()
  expect(environment).not.toHaveProperty("TYPESAFE_API_KEY")
  expect(environment).not.toHaveProperty("OPENAI_API_KEY")
  expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY")
  if (process.env.PATH) expect(environment).toHaveProperty("PATH", process.env.PATH)
})
