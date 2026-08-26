import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("specification help caption geometry", () => {
  const css = readFileSync("apps/desktop/renderer/styles.css", "utf8");

  it("uses the Windows title-bar overlay metric for the application viewport", () => {
    expect(css).toMatch(/--titlebar-height:\s*env\(titlebar-area-height,\s*56px\)/);
    expect(css).toMatch(/\.spec-help-backdrop\s*\{[^}]*inset:\s*var\(--titlebar-height\)\s+0\s+0/s);
    expect(css).toMatch(/\.layout\s*\{[^}]*height:\s*calc\(100vh\s*-\s*var\(--titlebar-height\)\)/s);
  });

  it("keeps the modal close control outside the drag region", () => {
    expect(css).toMatch(/\.spec-help-header button\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });
});
