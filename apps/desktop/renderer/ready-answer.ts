export interface ReadyTranscriptEntry {
  id: string;
  role: string;
  providerId?: string | null;
  attachments?: Array<{ source: string }>;
}

export function selectReadyAnswerEntries<T extends ReadyTranscriptEntry>(entries: T[]): {
  finalEntry?: T;
  visibleEntries: T[];
  artifactEntries: T[];
} {
  const finalEntry = entries
    .slice()
    .reverse()
    .find((entry) => entry.role === "ASSISTANT" && entry.providerId === "final");
  const visibleEntries = entries.filter(
    (entry) =>
      entry.role === "USER" ||
      entry.providerId === "system" ||
      entry.id === finalEntry?.id,
  );
  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const artifactEntries = entries.filter((entry) =>
    !visibleIds.has(entry.id) &&
    entry.role === "ASSISTANT" &&
    (entry.providerId === "chatgpt" || entry.providerId === "gemini") &&
    entry.attachments?.some((attachment) => attachment.source === entry.providerId),
  );
  return {
    ...(finalEntry ? { finalEntry } : {}),
    visibleEntries,
    artifactEntries,
  };
}
