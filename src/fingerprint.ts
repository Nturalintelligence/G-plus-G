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
    if (knownFingerprints.has(item.fingerprint)) return false;
    // A new stable DOM id is authoritative even when a virtualized list reused
    // an old ordinal and kept the same total number of rendered messages.
    if (item.domId) return true;
    // Without an id, ordinal growth is the only safe evidence that this is not
    // an edited old block.
    return item.ordinal >= baselineLength;
  });

  // The newest assistant response is rendered last in conversation order.
  return candidates.length >= 1 ? candidates[candidates.length - 1]! : null;
}
