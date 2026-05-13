import { test } from "node:test";
import assert from "node:assert/strict";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { streamLlmAndExtractToolCalls } from "./llm-stream-tool-calls";

// `dispatchCustomEvent` from `@langchain/core/callbacks/dispatch` is a
// no-op when called outside a LangGraph runnable context (no manager
// is registered). We rely on that here so the test can drive the
// helper without standing up a real graph: every emit becomes a
// silent no-op, but we still assert the shape of the returned
// AIMessageChunk + that tool_calls were re-assembled correctly from
// the streamed `tool_call_chunks`.

function makeStreamingLlm(
  chunks: Array<{
    content?: string;
    tool_call_chunks?: Array<{
      index?: number;
      id?: string;
      name?: string;
      args?: string;
    }>;
  }>,
): Runnable<BaseMessage[], AIMessageChunk> {
  // Minimal implementation of the slice of `Runnable` the helper
  // uses (`stream(messages) → AsyncIterable<AIMessageChunk>`).
  return {
    async stream() {
      async function* gen() {
        for (const c of chunks) {
          yield new AIMessageChunk({
            content: c.content ?? "",
            tool_call_chunks: (c.tool_call_chunks ?? []).map((tc) => ({
              index: tc.index,
              id: tc.id,
              name: tc.name,
              args: tc.args,
              type: "tool_call_chunk" as const,
            })),
          });
        }
      }
      return gen();
    },
  } as unknown as Runnable<BaseMessage[], AIMessageChunk>;
}

test("streamLlmAndExtractToolCalls passes through plain text content", async () => {
  const llm = makeStreamingLlm([
    { content: "Hello " },
    { content: "world" },
  ]);
  const result = await streamLlmAndExtractToolCalls(llm, [], { node: "chat" });
  assert.ok(result, "should return an accumulated chunk");
  assert.equal(result?.content, "Hello world");
  assert.equal((result?.tool_calls ?? []).length, 0);
});

test(
  "streamLlmAndExtractToolCalls reconstructs tool_calls from streamed chunks",
  async () => {
    const llm = makeStreamingLlm([
      // First chunk introduces the tool call (id + name).
      { tool_call_chunks: [{ index: 0, id: "call-1", name: "list_lessons" }] },
      // Subsequent chunks stream args one piece at a time.
      { tool_call_chunks: [{ index: 0, args: "{\"thread" }] },
      { tool_call_chunks: [{ index: 0, args: "_id\":\"abc\"}" }] },
    ]);
    const result = await streamLlmAndExtractToolCalls(llm, [], { node: "chat" });
    assert.ok(result);
    const calls = result?.tool_calls ?? [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "call-1");
    assert.equal(calls[0].name, "list_lessons");
    assert.deepEqual(calls[0].args, { thread_id: "abc" });
  },
);

test(
  "streamLlmAndExtractToolCalls handles parallel tool calls multiplexed by index",
  async () => {
    const llm = makeStreamingLlm([
      {
        tool_call_chunks: [
          { index: 0, id: "call-a", name: "get_lesson" },
          { index: 1, id: "call-b", name: "list_lessons" },
        ],
      },
      {
        tool_call_chunks: [
          { index: 0, args: "{\"lesson_id\":\"l1\"}" },
          { index: 1, args: "{\"thread_id\":\"t1\"}" },
        ],
      },
    ]);
    const result = await streamLlmAndExtractToolCalls(llm, [], { node: "chat" });
    assert.ok(result);
    const calls = result?.tool_calls ?? [];
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((c) => [c.id, c.name, c.args]),
      [
        ["call-a", "get_lesson", { lesson_id: "l1" }],
        ["call-b", "list_lessons", { thread_id: "t1" }],
      ],
    );
  },
);

test("streamLlmAndExtractToolCalls returns undefined for an empty stream", async () => {
  const llm = makeStreamingLlm([]);
  const result = await streamLlmAndExtractToolCalls(llm, [], { node: "chat" });
  assert.equal(result, undefined);
});
