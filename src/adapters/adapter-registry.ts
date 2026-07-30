import type { ModelAdapter } from "./adapter-contract.js";
import { ChatGptAdapter } from "../chatgpt-adapter.js";
import { GeminiAdapter } from "../gemini-adapter.js";

export type ProviderId = "chatgpt" | "gemini";

export function createAdapter(provider: ProviderId, timeoutMs?: number): ModelAdapter {
  const options = timeoutMs === undefined ? {} : { timeoutMs };
  if (provider === "chatgpt") return new ChatGptAdapter(options);
  return new GeminiAdapter(options);
}

export function parseProvider(value: string | undefined): ProviderId {
  if (!value || value === "chatgpt") return "chatgpt";
  if (value === "gemini") return "gemini";
  throw new Error(`Неизвестный провайдер: ${value}`);
}
