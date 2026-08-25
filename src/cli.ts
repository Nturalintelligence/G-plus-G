#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ChallengeRequiredError } from "./errors.js";
import { runProjectCommand } from "./project-cli.js";
import { createAdapter, parseProvider } from "./adapters/adapter-registry.js";
import { extractExpectedVerificationMarker } from "./verification-marker.js";
import {
  backupDatabase,
  resetProviderSession,
  restoreDatabase,
} from "./maintenance.js";
import { writeDiagnostic } from "./observability/logger.js";
import {
  createBackupBundle,
  getReleaseInfo,
  restoreBackupBundle,
  runPreflight,
  validateBackupBundle,
} from "./release/release-tools.js";

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
  return writeDiagnostic(reason, {
    operation: command,
    provider,
    providerDiagnostics: await adapter.collectDiagnostics().catch(() => ({})),
  });
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
  npm run preflight
  npm run release:info
  npm run backup -- --file "C:\\Backups"
  npm run backup:validate -- --file "C:\\Backups\\g-plus-g-backup-..."
  npm run restore -- --file "C:\\Backups\\g-plus-g-backup-..."

Профили и база хранятся в общей папке данных приложения.`);
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
  if (command === "backup:create") {
    if (!values.file) throw new Error("Передайте каталог для резервных копий через --file");
    console.log(`Резервная копия: ${await createBackupBundle({ destinationRoot: values.file })}`);
    return;
  }
  if (command === "backup:validate") {
    if (!values.file) throw new Error("Передайте каталог резервной копии через --file");
    const manifest = await validateBackupBundle(values.file);
    console.log(`PASS: ${manifest.database.quickCheck}, ${manifest.database.bytes} bytes`);
    return;
  }
  if (command === "backup:restore") {
    if (!values.file) throw new Error("Передайте каталог резервной копии через --file");
    console.log(`База восстановлена: ${await restoreBackupBundle(values.file)}`);
    return;
  }
  if (command === "release:info") {
    console.log(JSON.stringify(await getReleaseInfo(), null, 2));
    return;
  }
  if (command === "preflight") {
    const checks = await runPreflight();
    for (const check of checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
    if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
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
        extractExpectedVerificationMarker(result.response, token);
        console.log(`${index}/${count} PASS ${token}`);
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
