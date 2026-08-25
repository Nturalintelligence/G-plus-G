import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("provider management IPC security boundary", () => {
  const main = read("apps/desktop/main.ts");
  const preload = read("apps/desktop/preload.cjs");

  it("exposes only typed provider actions and allowlists web chat hosts", () => {
    expect(preload).toContain('ipcRenderer.invoke("provider:openWebChat"');
    expect(preload).toContain('ipcRenderer.invoke("provider:rebindConversation"');
    expect(main).toContain('new Set(["chatgpt.com", "chat.openai.com"])');
    expect(main).toContain('new Set(["gemini.google.com"])');
    expect(main).toContain('parsed.protocol !== "https:"');
    expect(main).not.toContain("provider:openArbitraryUrl");
  });
});
