import { describe, expect, it } from "vitest";
import { selectComposerIndex } from "../src/adapters/composer-selection.js";

describe("composer selection", () => {
  it("ignores hidden, disabled and technical composers", () => {
    expect(selectComposerIndex([
      { visible: false, editable: true, enabled: true, active: false, bottom: 900 },
      { visible: true, editable: true, enabled: false, active: false, bottom: 800 },
      { visible: true, editable: true, enabled: true, active: false, bottom: 700 },
    ])).toBe(2);
  });

  it("prefers the active composer, otherwise the lowest usable composer", () => {
    expect(selectComposerIndex([
      { visible: true, editable: true, enabled: true, active: true, bottom: 200 },
      { visible: true, editable: true, enabled: true, active: false, bottom: 900 },
    ])).toBe(0);
    expect(selectComposerIndex([
      { visible: true, editable: true, enabled: true, active: false, bottom: 200 },
      { visible: true, editable: true, enabled: true, active: false, bottom: 900 },
    ])).toBe(1);
  });
});
