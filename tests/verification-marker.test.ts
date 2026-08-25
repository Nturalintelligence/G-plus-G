import { describe, expect, it } from "vitest";
import { extractExpectedVerificationMarker, VerificationMarkerError } from "../src/verification-marker.js";

describe("provider verification marker parsing", () => {
  const expected = "S0-1787649676808-1";

  it.each([
    expected,
    `Ответ Gemini ${expected}`,
    `${expected}\nГотово`,
    `Пояснение\n${expected}\nКонец`,
  ])("extracts only the expected marker from provider prose", (response) => {
    expect(extractExpectedVerificationMarker(response, expected)).toBe(expected);
  });

  it.each([
    ["marker absent", "обычный ответ"],
    ["wrong run", "S0-1787649676809-1"],
    ["wrong step", "S0-1787649676808-2"],
    ["embedded token", `fake_${expected}_suffix`],
    ["conflicting markers", `${expected} S0-1787649676809-1`],
  ])("rejects %s", (_name, response) => {
    expect(() => extractExpectedVerificationMarker(response, expected)).toThrow(VerificationMarkerError);
  });

  it("does not return surrounding provider or user-controlled text", () => {
    const response = `user-content [[${expected}]] peer-content`;
    expect(extractExpectedVerificationMarker(response, expected)).toBe(expected);
  });
});
