import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunMode } from "../orchestrator/orchestrator.js";
import {
  defaultLimits,
  validateLimits,
  type OrchestrationLimits,
} from "../orchestrator/limits.js";

export type ProviderId =
  | "chatgpt"
  | "gemini"
  | "deepseek"
  | "claude"
  | "copilot"
  | "perplexity"
  | "huggingchat"
  | "groq"
  | "duckduckgo"
  | "mistral";

export type Theme = "dark" | "light" | "system";
export type Density = "comfortable" | "compact";

export const PROVIDER_METADATA: Record<
  ProviderId,
  { name: string; url: string; requiresAuth: boolean }
> = {
  chatgpt: { name: "ChatGPT", url: "https://chatgpt.com/", requiresAuth: false },
  gemini: { name: "Gemini", url: "https://gemini.google.com/app", requiresAuth: false },
  deepseek: { name: "DeepSeek", url: "https://chat.deepseek.com/", requiresAuth: false },
  claude: { name: "Claude", url: "https://claude.ai/new", requiresAuth: true },
  copilot: { name: "Copilot", url: "https://copilot.microsoft.com/", requiresAuth: false },
  perplexity: { name: "Perplexity", url: "https://www.perplexity.ai/", requiresAuth: false },
  huggingchat: { name: "HuggingChat", url: "https://huggingface.co/chat/", requiresAuth: false },
  groq: { name: "Groq", url: "https://groq.com/", requiresAuth: true },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat", requiresAuth: false },
  mistral: { name: "Mistral", url: "https://chat.mistral.ai/", requiresAuth: true },
};

export interface AppSettings {
  schemaVersion: 1;
  profile: {
    displayName: string;
    realName: string;
    greetingStyle: "display" | "real" | "generic";
  };
  defaults: {
    mode: RunMode;
    providers: ProviderId[];
    limits: OrchestrationLimits;
  };
  appearance: {
    theme: Theme;
    density: Density;
    fontScale: number;
  };
}

export const defaultSettings: AppSettings = {
  schemaVersion: 1,
  profile: {
    displayName: "",
    realName: "",
    greetingStyle: "generic",
  },
  defaults: {
    mode: "DEBATE",
    providers: ["chatgpt", "gemini"],
    limits: { ...defaultLimits },
  },
  appearance: {
    theme: "dark",
    density: "comfortable",
    fontScale: 100,
  },
};

const modes: RunMode[] = ["MANUAL", "SEQUENTIAL", "PARALLEL", "DEBATE"];
const providerIds: ProviderId[] = [
  "chatgpt",
  "gemini",
  "deepseek",
  "claude",
  "copilot",
  "perplexity",
  "huggingchat",
  "groq",
  "duckduckgo",
  "mistral",
];
const themes: Theme[] = ["dark", "light", "system"];
const densities: Density[] = ["comfortable", "compact"];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function integer(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? value as number : fallback;
}

export function parseSettings(value: unknown): AppSettings {
  const root = record(value);
  const profile = record(root.profile);
  const defaults = record(root.defaults);
  const limits = record(defaults.limits);
  const appearance = record(root.appearance);
  const displayName =
    typeof profile.displayName === "string" ? profile.displayName.trim() : "";
  if (displayName.length > 80) throw new Error("Display name cannot exceed 80 characters");
  const realName =
    typeof profile.realName === "string" ? profile.realName.trim() : "";
  if (realName.length > 80) throw new Error("Real name cannot exceed 80 characters");
  const greetingStyles: Array<AppSettings["profile"]["greetingStyle"]> = ["display", "real", "generic"];
  const greetingStyle = greetingStyles.includes(profile.greetingStyle as any)
    ? profile.greetingStyle as AppSettings["profile"]["greetingStyle"]
    : defaultSettings.profile.greetingStyle;

  const mode = modes.includes(defaults.mode as RunMode)
    ? defaults.mode as RunMode
    : defaultSettings.defaults.mode;
  const requestedProviders = Array.isArray(defaults.providers)
    ? defaults.providers.filter(
        (item): item is ProviderId =>
          typeof item === "string" && providerIds.includes(item as ProviderId),
      )
    : defaultSettings.defaults.providers;
  const providers = [...new Set(requestedProviders)];
  if (providers.length === 0) throw new Error("Select at least one provider");

  const parsedLimits: OrchestrationLimits = {
    maxTurns: integer(limits.maxTurns, defaultLimits.maxTurns),
    maxTurnMs: integer(limits.maxTurnMs, defaultLimits.maxTurnMs),
    maxSessionMs: integer(limits.maxSessionMs, defaultLimits.maxSessionMs),
    maxRetries: integer(limits.maxRetries, defaultLimits.maxRetries),
    confirmationEvery: integer(limits.confirmationEvery, defaultLimits.confirmationEvery),
  };
  validateLimits(parsedLimits);
  if (parsedLimits.maxTurnMs > 1_800_000) throw new Error("Turn timeout cannot exceed 30 minutes");
  if (parsedLimits.maxSessionMs > 14_400_000) {
    throw new Error("Session timeout cannot exceed 4 hours");
  }
  if (parsedLimits.maxRetries > 10) throw new Error("Retries cannot exceed 10");
  if (parsedLimits.confirmationEvery > 50) {
    throw new Error("Confirmation interval cannot exceed 50");
  }

  const theme = themes.includes(appearance.theme as Theme)
    ? appearance.theme as Theme
    : defaultSettings.appearance.theme;
  const density = densities.includes(appearance.density as Density)
    ? appearance.density as Density
    : defaultSettings.appearance.density;
  const fontScale = integer(appearance.fontScale, defaultSettings.appearance.fontScale);
  if (fontScale < 80 || fontScale > 140) throw new Error("Font scale must be between 80 and 140");

  return {
    schemaVersion: 1,
    profile: { displayName, realName, greetingStyle },
    defaults: { mode, providers, limits: parsedLimits },
    appearance: { theme, density, fontScale },
  };
}

export class SettingsStore {
  constructor(private readonly filePath: string) {}

  load(): AppSettings {
    try {
      return parseSettings(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaultSettings);
      throw new Error(`Cannot read settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  save(value: unknown): AppSettings {
    const settings = parseSettings(value);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.filePath);
    return settings;
  }
}
