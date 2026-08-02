import { describe, expect, it } from "vitest";
import { validateFileForProviders } from "../src/files/file-manager.js";

describe("File Manager Support Matrix", () => {
  it("validates images for ChatGPT and Gemini", () => {
    const result = validateFileForProviders("image.png", ["chatgpt", "gemini"]);
    expect(result.valid).toBe(true);
    expect(result.unsupportedProviders).toEqual([]);
  });

  it("detects image incompatibility with DeepSeek", () => {
    const result = validateFileForProviders("photo.jpg", ["chatgpt", "deepseek"]);
    expect(result.valid).toBe(false);
    expect(result.unsupportedProviders).toEqual(["deepseek"]);
  });

  it("validates text and pdf files across all models", () => {
    const pdfResult = validateFileForProviders("doc.pdf", ["chatgpt", "gemini", "deepseek"]);
    expect(pdfResult.valid).toBe(true);

    const txtResult = validateFileForProviders("notes.txt", ["chatgpt", "gemini", "deepseek"]);
    expect(txtResult.valid).toBe(true);
  });
});
