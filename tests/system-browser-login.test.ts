import { describe, expect, it } from "vitest";
import { findSystemChrome } from "../src/browser/system-browser-login.js";

describe("system Chrome discovery", () => {
  it("selects installed Chrome without falling back to an embedded browser", () => {
    const expected = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    expect(
      findSystemChrome(
        { PROGRAMFILES: "C:\\Program Files" },
        (candidate) => candidate === expected,
      ),
    ).toBe(expected);
  });

  it("fails explicitly when Chrome is unavailable", () => {
    expect(() => findSystemChrome({}, () => false)).toThrow(/Chrome не найден/);
  });
});
