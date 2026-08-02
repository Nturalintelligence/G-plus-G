import { describe, expect, it } from "vitest";
import { FileSandbox } from "../src/artifacts/file-sandbox.js";

describe("File Sandbox (pre.15)", () => {
  const sandbox = new FileSandbox("C:/sandbox_dir");

  it("validates allowed vs forbidden file extensions", () => {
    expect(sandbox.isAllowedExtension("spec.md")).toBe(true);
    expect(sandbox.isAllowedExtension("data.json")).toBe(true);
    expect(sandbox.isAllowedExtension("script.exe")).toBe(false);
    expect(sandbox.isAllowedExtension("malware.sh")).toBe(false);
  });

  it("validates file size limits", () => {
    expect(sandbox.validateUpload("doc.txt", 1024).valid).toBe(true);
    expect(sandbox.validateUpload("huge.pdf", 20 * 1024 * 1024).valid).toBe(false);
  });

  it("prevents Path Traversal attacks", () => {
    expect(sandbox.isSafePath("C:/sandbox_dir/file.txt")).toBe(true);
    expect(sandbox.isSafePath("C:/sandbox_dir/sub/file.txt")).toBe(true);
  });
});
