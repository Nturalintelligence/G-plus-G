import type { ModelAdapter } from "./adapter-contract.js";
import { ChatGptAdapter } from "../chatgpt-adapter.js";
import { GeminiAdapter } from "../gemini-adapter.js";
import { DeepSeekAdapter } from "../deepseek-adapter.js";
import { GenericWebAdapter } from "../generic-web-adapter.js";
import { type ProviderId, PROVIDER_METADATA } from "../settings/settings.js";

export { ProviderId };

export function createAdapter(provider: ProviderId, timeoutMs?: number, headless?: boolean): ModelAdapter {
  const options = { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(headless !== undefined ? { headless } : {}) };
  if (provider === "chatgpt") return new ChatGptAdapter(options);
  if (provider === "gemini") return new GeminiAdapter(options);
  if (provider === "deepseek") return new DeepSeekAdapter(options);
  return new GenericWebAdapter(provider, options);
}

export function parseProvider(value: string | undefined): ProviderId {
  if (!value) return "chatgpt";
  if (value in PROVIDER_METADATA) {
    return value as ProviderId;
  }
  throw new Error(`Неизвестный провайдер: ${value}`);
}
