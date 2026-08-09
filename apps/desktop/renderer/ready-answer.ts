export interface ReadyTranscriptEntry {
  id: string;
  role: string;
  providerId?: string | null;
}

export function selectReadyAnswerEntries<T extends ReadyTranscriptEntry>(entries: T[]): {
  finalEntry?: T;
  visibleEntries: T[];
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
  return {
    ...(finalEntry ? { finalEntry } : {}),
    visibleEntries,
  };
}
