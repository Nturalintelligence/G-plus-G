import { describe, expect, it } from "vitest";
import { createAdapter } from "../src/adapters/adapter-registry.js";
import { DeepSeekAdapter } from "../src/deepseek-adapter.js";
import { GenericWebAdapter } from "../src/generic-web-adapter.js";
import { PROVIDER_METADATA } from "../src/settings/settings.js";

describe("Browser Adapter Isolation & Headless Contract", () => {
  it("DeepSeekAdapter accepts and respects headless flag in constructor", () => {
    const defaultAdapter = new DeepSeekAdapter();
    expect(defaultAdapter.headless).toBe(true);

    const interactiveAdapter = new DeepSeekAdapter({ headless: false });
    expect(interactiveAdapter.headless).toBe(false);
  });

  it("GenericWebAdapter accepts and respects headless flag in constructor", () => {
    const defaultAdapter = new GenericWebAdapter("claude");
    expect(defaultAdapter.headless).toBe(true);

    const interactiveAdapter = new GenericWebAdapter("claude", { headless: false });
    expect(interactiveAdapter.headless).toBe(false);
  });

  it("createAdapter forwards headless option to adapter instances", () => {
    const deepseekHeadless = createAdapter("deepseek", 30_000, true) as DeepSeekAdapter;
    expect(deepseekHeadless.headless).toBe(true);

    const deepseekVisible = createAdapter("deepseek", 180_000, false) as DeepSeekAdapter;
    expect(deepseekVisible.headless).toBe(false);

    const genericHeadless = createAdapter("claude", 30_000, true) as GenericWebAdapter;
    expect(genericHeadless.headless).toBe(true);

    const genericVisible = createAdapter("claude", 180_000, false) as GenericWebAdapter;
    expect(genericVisible.headless).toBe(false);
  });

  it("PROVIDER_METADATA marks only supported statusProbe targets as true", () => {
    expect(PROVIDER_METADATA.chatgpt.statusProbe).toBe(true);
    expect(PROVIDER_METADATA.gemini.statusProbe).toBe(true);

    // DeepSeek and experimental adapters MUST NOT probe automatically
    expect(PROVIDER_METADATA.deepseek.statusProbe).toBe(false);
    expect(PROVIDER_METADATA.claude.statusProbe).toBe(false);
    expect(PROVIDER_METADATA.copilot.statusProbe).toBe(false);
    expect(PROVIDER_METADATA.perplexity.statusProbe).toBe(false);
  });
});
