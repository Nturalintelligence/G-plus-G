export const EXECUTION_BLOCK_START = "<G_PLUS_G_EXECUTION_V1>";
export const EXECUTION_BLOCK_END = "</G_PLUS_G_EXECUTION_V1>";
export const MAX_EXECUTION_ENVELOPE_CHARS = 64_000;

export type ExecutionRecognitionStatus =
  | "RECOGNIZED_DISABLED"
  | "INVALID_JSON"
  | "INVALID_PROTOCOL"
  | "TOO_LARGE"
  | "UNCLOSED";

export interface RecognizedExecutionEnvelope {
  status: ExecutionRecognitionStatus;
  rawJson: string;
  envelopeId?: string;
  purpose?: string;
}

export function recognizeExecutionEnvelopes(text: string): RecognizedExecutionEnvelope[] {
  const results: RecognizedExecutionEnvelope[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(EXECUTION_BLOCK_START, cursor);
    if (start === -1) break;
    const contentStart = start + EXECUTION_BLOCK_START.length;
    const end = text.indexOf(EXECUTION_BLOCK_END, contentStart);
    if (end === -1) {
      results.push({ status: "UNCLOSED", rawJson: text.slice(contentStart).trim() });
      break;
    }
    const rawJson = text.slice(contentStart, end).trim();
    if (rawJson.length > MAX_EXECUTION_ENVELOPE_CHARS) {
      results.push({ status: "TOO_LARGE", rawJson: "" });
    } else {
      try {
        const parsed: unknown = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          results.push({ status: "INVALID_PROTOCOL", rawJson });
        } else {
          const record = parsed as Record<string, unknown>;
          if (record.protocol !== "G_PLUS_G_EXECUTION_V1") {
            results.push({ status: "INVALID_PROTOCOL", rawJson });
          } else {
            results.push({
              status: "RECOGNIZED_DISABLED",
              rawJson,
              ...(typeof record.envelopeId === "string" ? { envelopeId: record.envelopeId } : {}),
              ...(typeof record.purpose === "string" ? { purpose: record.purpose } : {}),
            });
          }
        }
      } catch {
        results.push({ status: "INVALID_JSON", rawJson });
      }
    }
    cursor = end + EXECUTION_BLOCK_END.length;
  }
  return results;
}

export function replaceExecutionEnvelopesWithNotice(text: string): string {
  let output = text;
  let cursor = 0;
  while (cursor < output.length) {
    const start = output.indexOf(EXECUTION_BLOCK_START, cursor);
    if (start === -1) break;
    const contentStart = start + EXECUTION_BLOCK_START.length;
    const end = output.indexOf(EXECUTION_BLOCK_END, contentStart);
    const replacement = end === -1
      ? "\n> Экспериментальное задание с кодом отклонено: машинный блок не закрыт. Выполнение отключено.\n"
      : "\n> Экспериментальное задание с кодом обнаружено. Выполнение отключено до утверждения полной схемы и безопасного sandbox.\n";
    output = end === -1
      ? output.slice(0, start) + replacement
      : output.slice(0, start) + replacement + output.slice(end + EXECUTION_BLOCK_END.length);
    cursor = start + replacement.length;
  }
  return output.trim();
}
