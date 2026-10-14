import { expect, test } from "bun:test"
import { ClaudeHarness } from "@opencode-ai/core/orchestration/harness/claude"

test("reads only Claude result metadata", () => {
  expect(
    ClaudeHarness.readResult(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "private answer",
        session_id: "session-1",
        duration_ms: 150,
        total_cost_usd: 0.02,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      }),
    ),
  ).toEqual({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "session-1",
    duration_ms: 150,
    total_cost_usd: 0.02,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
  })
})

test("rejects incomplete Claude output", () => {
  expect(ClaudeHarness.readResult("partial output")).toBeUndefined()
})
