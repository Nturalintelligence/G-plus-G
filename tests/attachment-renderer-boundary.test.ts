import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const rendererTypes = fs.readFileSync(path.join(root, "apps/desktop/renderer/global.d.ts"), "utf8");
const preload = fs.readFileSync(path.join(root, "apps/desktop/preload.cjs"), "utf8");

describe("attachment renderer security boundary", () => {
  it("does not expose internal paths, hashes, provider URLs, or save target paths in AttachmentRefView", () => {
    const dtoBlock = rendererTypes.match(/interface AttachmentRefView \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(dtoBlock).not.toMatch(/localRelativePath|sha256|providerMetadata|providerFileId|originalUrl|targetPath/);
    expect(rendererTypes).not.toContain("targetPath?: string");
  });

  it("keeps the only absolute drop path inside the trusted preload to main IPC chain", () => {
    expect(preload).toContain("webUtils.getPathForFile(file)");
    expect(preload).toContain('ipcRenderer.invoke("attachments:stageDroppedFile"');
    expect(rendererTypes).not.toContain("filePath:");
  });

  it("uses binary clipboard IPC and has no attachment base64 API", () => {
    expect(preload).toContain("bytes instanceof Uint8Array");
    expect(preload).not.toContain("stageClipboardImage");
    expect(preload).not.toContain("base64Data");
  });
});
