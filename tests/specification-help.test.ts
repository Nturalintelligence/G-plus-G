import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "apps/desktop/renderer/components/SpecificationHelpModal.tsx"), "utf8");

describe("specification help content", () => {
  it("keeps every help section, safety boundary and version", () => {
    for (const id of ["about", "requirements", "constraints", "decisions", "rejected", "questions", "acceptance", "sources", "json", "example", "mistakes"]) expect(source).toContain(`id: "${id}"`);
    expect(source).toContain('SPEC_HELP_VERSION = "1.0.0"');
    expect(source).toContain("не запускает команды и код");
    expect(source).not.toContain("eval(");
    expect(source).not.toContain("data:image");
  });

  it("references existing managed screenshot assets", () => {
    for (const file of ["phase-e-spec-1366x768-light.png", "phase-e-spec-1100x700-dark.png"]) expect(existsSync(join(process.cwd(), "docs/screenshots", file))).toBe(true);
  });
});
