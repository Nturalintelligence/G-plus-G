import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(
  new URL("../apps/desktop/renderer/main.tsx", import.meta.url),
  "utf8",
);

describe("provider authentication wiring", () => {
  it("does not probe providers automatically on application startup", () => {
    expect(rendererSource).not.toContain("refreshAllSupportedStatuses");
    expect(rendererSource).not.toContain("void refreshProviderStatus(provider)");
    expect(rendererSource).not.toContain("window.orchestrator.provider.status(");
  });

  it("uses the explicit login result as the provider status", () => {
    expect(rendererSource).toContain("const session = await window.orchestrator.provider.login(provider)");
    expect(rendererSource).toContain('ready: session === "AUTHENTICATED"');
  });
});
