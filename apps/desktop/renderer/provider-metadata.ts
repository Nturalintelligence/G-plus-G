export interface ProviderMetadata {
  id: string;
  displayName: string;
  shortName: string;
  isSupported: boolean;
  statusProbe: boolean;
  availabilityNote: string;
  color: string;
}

export const PROVIDER_METADATA_MAP: Record<string, ProviderMetadata> = {
  chatgpt: {
    id: "chatgpt",
    displayName: "ChatGPT",
    shortName: "ChatGPT",
    isSupported: true,
    statusProbe: true,
    availabilityNote: "Подключён через Playwright Web",
    color: "#10a37f",
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini",
    shortName: "Gemini",
    isSupported: true,
    statusProbe: true,
    availabilityNote: "Подключён через Playwright Web",
    color: "#1a73e8",
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    shortName: "DeepSeek",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#4d6bfe",
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    shortName: "Claude",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#d97757",
  },
  copilot: {
    id: "copilot",
    displayName: "GitHub Copilot",
    shortName: "Copilot",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#24292e",
  },
  perplexity: {
    id: "perplexity",
    displayName: "Perplexity",
    shortName: "Perplexity",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#22b8cf",
  },
  huggingchat: {
    id: "huggingchat",
    displayName: "HuggingChat",
    shortName: "HuggingChat",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#ffb703",
  },
  groq: {
    id: "groq",
    displayName: "Groq",
    shortName: "Groq",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#f35b04",
  },
  duckduckgo: {
    id: "duckduckgo",
    displayName: "DuckDuckGo AI Chat",
    shortName: "DuckDuckGo",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#de5833",
  },
  mistral: {
    id: "mistral",
    displayName: "Mistral",
    shortName: "Mistral",
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Экспериментальный провайдер",
    color: "#ff70a6",
  },
};

export function getProviderMetadata(id: string): ProviderMetadata {
  const normalized = id.toLowerCase().trim();
  if (PROVIDER_METADATA_MAP[normalized]) {
    return PROVIDER_METADATA_MAP[normalized];
  }
  const formattedFallback = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return {
    id: normalized,
    displayName: formattedFallback,
    shortName: formattedFallback,
    isSupported: false,
    statusProbe: false,
    availabilityNote: "Неизвестный адаптер",
    color: "#6b7280",
  };
}

export function getProviderDisplayName(id: string, includeWebSuffix = false): string {
  const meta = getProviderMetadata(id);
  return includeWebSuffix ? `${meta.displayName} Web` : meta.displayName;
}

export function formatProviderList(ids: string[]): string {
  if (!ids || ids.length === 0) return "Не выбраны";
  return ids.map((id) => getProviderDisplayName(id)).join(", ");
}
