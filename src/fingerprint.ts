import { createHash } from "node:crypto";
import type { ResponseSnapshot } from "./types.js";

export function normalizeText(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}

export function selectNewResponse(
  before: readonly ResponseSnapshot[],
  after: readonly ResponseSnapshot[],
): ResponseSnapshot | null {
  const knownIds = new Set(before.flatMap((item) => (item.domId ? [item.domId] : [])));
  const knownFingerprints = new Set(before.map((item) => item.fingerprint));
  const baselineLength = before.length;

  const candidates = after.filter((item) => {
    if (item.domId && knownIds.has(item.domId)) return false;
    if (item.ordinal < baselineLength) return false;
    return !knownFingerprints.has(item.fingerprint) || item.ordinal >= baselineLength;
  });

  return candidates.length === 1 ? candidates[0]! : null;
}
