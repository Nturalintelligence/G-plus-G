import { extname } from "node:path";

export const PROVIDER_FILE_SUPPORT: Record<string, ReadonlySet<string>> = {
  chatgpt: new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".pdf",
    ".txt",
    ".md",
    ".csv",
    ".docx",
    ".json",
  ]),
  gemini: new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".pdf",
    ".txt",
    ".md",
    ".csv",
    ".json",
  ]),
  deepseek: new Set([
    ".pdf",
    ".txt",
    ".md",
    ".docx",
    ".csv",
    ".json",
  ]),
};

export interface FileValidationResult {
  valid: boolean;
  unsupportedProviders: string[];
  extension: string;
}

export function validateFileForProviders(
  filename: string,
  providerIds: string[],
): FileValidationResult {
  const ext = extname(filename).toLowerCase();
  const unsupportedProviders: string[] = [];

  for (const providerId of providerIds) {
    const allowed = PROVIDER_FILE_SUPPORT[providerId];
    if (allowed && !allowed.has(ext)) {
      unsupportedProviders.push(providerId);
    }
  }

  return {
    valid: unsupportedProviders.length === 0,
    unsupportedProviders,
    extension: ext,
  };
}
