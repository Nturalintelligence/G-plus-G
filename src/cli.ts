#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ChallengeRequiredError } from "./errors.js";
import { runProjectCommand } from "./project-cli.js";
import { createAdapter, parseProvider } from "./adapters/adapter-registry.js";
import {
  backupDatabase,
  resetProviderSession,
  restoreDatabase,
} from "./maintenance.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    message: { type: "string", short: "m" },
    count: { type: "string", short: "n", default: "20" },
    timeout: { type: "string", default: "180000" },
    name: { type: "string" },
    id: { type: "string" },
    database: { type: "string" },
    provider: { type: "string", short: "p", default: "chatgpt" },
    file: { type: "string" },
  },
});

const command = positionals[0] ?? "help";
const timeoutMs = Number(values.timeout);
const provider = parseProvider(values.provider);
const adapter = createAdapter(provider, timeoutMs);

async function persistDiagnostic(reason: unknown): Promise<string> {
  const directory = resolve("user-data/logs");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `diagnostic-${Date.now()}.json`);
  const report = {
    error: reason instanceof Error ? { name: reason.name, message: reason.message } : reason,
    ...(await adapter.collectDiagnostics().catch(() => ({}))),
  };
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

async function run(): Promise<void> {
  if (command === "help") {
    console.log(`Команды:
  npm run login
  npm run send -- --message "Ваш запрос"
  npm run verify -- --count 20
  npm start -- project:create --name "Название проекта"
  npm start -- project:list
  npm start -- project:open --id "prj_..."

Профиль браузера хранится локально в user-data/profiles/chatgpt.`);
    return;
  }

  if (command.startsWith("project:")) {
    runProjectCommand(command, {
      ...(values.name ? { name: values.name } : {}),
      ...(values.id ? { id: values.id } : {}),
      ...(values.database ? { databasePath: values.database } : {}),
    });
    return;
  }

  if (command === "session:reset") {
    console.log(`Сброшен профиль: ${await resetProviderSession(provider)}`);
    return;
  }
  if (command === "database:backup") {
    if (!values.file) throw new Error("Передайте путь резервной копии через --file");
    console.log(`Резервная копия: ${await backupDatabase(values.file)}`);
    return;
  }
  if (command === "database:restore") {
    if (!values.file) throw new Error("Передайте путь резервной копии через --file");
    console.log(`База восстановлена: ${await restoreDatabase(values.file)}`);
    return;
  }

  await adapter.launch();
  try {
    if (command === "login") {
      await adapter.openLoginMode();
      console.log("Авторизация обнаружена и сохранена в persistent-профиле.");
      return;
    }

    if (command === "send") {
      const message = values.message ?? positionals.slice(1).join(" ");
      if (!message) throw new Error("Передайте сообщение через --message");
      const turn = await adapter.sendMessage({ content: message });
      const result = await adapter.getFinalResponse(turn);
      console.log(result.response);
      console.error(`\n[${result.elapsedMs} ms, ${result.responseFingerprint.slice(0, 12)}]`);
      return;
    }

    if (command === "verify") {
      const count = Number(values.count);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new Error("--count должен быть целым числом от 1 до 100");
      }
      const runId = Date.now();
      for (let index = 1; index <= count; index += 1) {
        const token = `S0-${runId}-${index}`;
        const prompt = `Ответь ровно этой строкой, без пояснений: ${token}`;
        const turn = await adapter.sendMessage({ content: prompt });
        const result = await adapter.getFinalResponse(turn);
        const passed = result.response.trim() === token;
        console.log(`${index}/${count} ${passed ? "PASS" : "FAIL"} ${token}`);
        if (!passed) {
          throw new Error(`Ответ не привязан корректно: ожидалось "${token}", получено "${result.response}"`);
        }
      }
      console.log(`PASS: ${count} последовательных запросов.`);
      return;
    }

    throw new Error(`Неизвестная команда: ${command}`);
  } catch (error) {
    const diagnosticPath = await persistDiagnostic(error);
    if (error instanceof ChallengeRequiredError) {
      console.error("Остановлено: обнаружена CAPTCHA/проверка пользователя.");
    }
    console.error(`Диагностика: ${diagnosticPath}`);
    throw error;
  } finally {
    await adapter.close();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
