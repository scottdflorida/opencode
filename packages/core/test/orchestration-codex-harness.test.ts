import { expect, test } from "bun:test"
import { CodexHarness } from "@opencode-ai/core/orchestration/harness/codex"

test("retains only Codex thread and usage metadata from JSON events", () => {
  expect(
    CodexHarness.readEvents(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "private answer" } }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 8, reasoning_output_tokens: 3 },
        }),
      ].join("\n"),
    ),
  ).toEqual({
    threadID: "thread-1",
    completed: true,
    usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 8, reasoning_output_tokens: 3 },
  })
})

test("incomplete output cannot appear as a successful Codex turn", () => {
  expect(CodexHarness.readEvents('{"type":"thread.started","thread_id":"thread-2"}\ntruncated')).toEqual({
    threadID: "thread-2",
    completed: false,
    usage: undefined,
  })
})
