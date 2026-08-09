import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(
  new URL("../apps/desktop/renderer/main.tsx", import.meta.url),
  "utf8",
);

describe("provider authentication wiring", () => {
  it("checks supported providers once and sequentially on application startup", () => {
    expect(rendererSource).toContain('await checkProviderStatus("chatgpt")');
    expect(rendererSource).toContain('await checkProviderStatus("gemini")');
    expect(rendererSource).toContain("window.setTimeout(resolve, 1_500)");
    expect(rendererSource.match(/window\.orchestrator\.provider\.status\(/g)).toHaveLength(1);
  });

  it("uses the explicit login result as the provider status", () => {
    expect(rendererSource).toContain("const session = await window.orchestrator.provider.login(provider)");
    expect(rendererSource).toContain('ready: session === "AUTHENTICATED"');
  });
});
