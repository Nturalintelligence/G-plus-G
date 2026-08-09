import { describe, expect, it } from "vitest";
import {
  EXECUTION_BLOCK_END,
  EXECUTION_BLOCK_START,
  recognizeExecutionEnvelopes,
  replaceExecutionEnvelopesWithNotice,
} from "../src/execution/execution-recognition.js";

describe("experimental execution recognition", () => {
  it("does not treat Markdown code fences as execution proposals", () => {
    expect(recognizeExecutionEnvelopes("```python\nprint('safe snippet')\n```")).toEqual([]);
  });

  it("recognizes the exact protocol envelope without creating an executable job", () => {
    const text = `${EXECUTION_BLOCK_START}\n${JSON.stringify({
      protocol: "G_PLUS_G_EXECUTION_V1",
      envelopeId: "env-1",
      purpose: "Generate a report",
    })}\n${EXECUTION_BLOCK_END}`;
    expect(recognizeExecutionEnvelopes(text)).toEqual([expect.objectContaining({
      status: "RECOGNIZED_DISABLED",
      envelopeId: "env-1",
      purpose: "Generate a report",
    })]);
    const publicText = replaceExecutionEnvelopesWithNotice(text);
    expect(publicText).toContain("Выполнение отключено");
    expect(publicText).not.toContain("G_PLUS_G_EXECUTION_V1");
    expect(publicText).not.toContain("env-1");
  });

  it("rejects malformed, unclosed, and wrong-protocol blocks", () => {
    expect(recognizeExecutionEnvelopes(`${EXECUTION_BLOCK_START}{bad}${EXECUTION_BLOCK_END}`)[0]?.status)
      .toBe("INVALID_JSON");
    expect(recognizeExecutionEnvelopes(`${EXECUTION_BLOCK_START}{}`)[0]?.status).toBe("UNCLOSED");
    expect(recognizeExecutionEnvelopes(
      `${EXECUTION_BLOCK_START}{"protocol":"G_PLUS_G_CLI_TASK_V1"}${EXECUTION_BLOCK_END}`,
    )[0]?.status).toBe("INVALID_PROTOCOL");
  });
});
