import { createAdapter } from "../src/adapters/adapter-registry.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { writeDiagnostic } from "../src/observability/logger.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

const TURN_COUNT = 40;
const PROVIDERS = ["chatgpt", "gemini"] as const;
const providerSequence = Array.from(
  { length: TURN_COUNT },
  (_, index) => PROVIDERS[index % PROVIDERS.length]!,
);

const task = `Совместно проведите технический аудит приложения G plus G — локального
desktop-оркестратора диалога ChatGPT Web и Gemini Web без API. Обсудите, как повысить
надёжность продолжительных диалогов, устойчивость DOM-автоматизации, наблюдаемость,
безопасность, производительность и удобство интерфейса. Каждый следующий участник
должен отвечать на конкретные тезисы предыдущего, исправлять ошибки и развивать
проектное решение. Каждый ответ должен быть конкретным и не длиннее 1 500 символов.
Не повторяйте всю историю и не завершайте обсуждение раньше,
чем обе модели выполнят по 20 содержательных ответов.`;

async function run(): Promise<void> {
  const database = new AppDatabase();
  database.migrate();
  const repository = new ProjectRepository(database);
  const project = repository.createProject(
    `Endurance 20x20 ${new Date().toISOString()}`,
    [...PROVIDERS],
  );
  const adapters = new Map(
    PROVIDERS.map((provider) => [provider, createAdapter(provider, 600_000)]),
  );

  console.log(`ENDURANCE_PROJECT_ID=${project.id}`);
  console.log(`ENDURANCE_PROJECT_NAME=${project.name}`);

  try {
    for (const [provider, adapter] of adapters) {
      const startedAt = Date.now();
      console.log(`[launch] ${provider}`);
      await adapter.launch();
      const state = await adapter.checkSession();
      console.log(`[ready] ${provider} state=${state} elapsedMs=${Date.now() - startedAt}`);
      if (state !== "AUTHENTICATED") {
        throw new Error(`${provider} is not authenticated: ${state}`);
      }
    }

    const orchestrator = new Orchestrator(database, adapters);
    const output = await orchestrator.run(
      project.id,
      "SEQUENTIAL",
      task,
      providerSequence,
      {
        maxTurns: TURN_COUNT,
        maxTurnMs: 600_000,
        maxSessionMs: 14_400_000,
        maxRetries: 1,
        confirmationEvery: 50,
      },
      {
        onResponseUpdate(providerId, text) {
          console.log(`[stream] ${providerId} chars=${text.length}`);
        },
      },
    );

    const entries = repository.conversationEntries(project.id);
    const counts = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        entries.filter(
          (entry) => entry.role === "ASSISTANT" && entry.providerId === provider,
        ).length,
      ]),
    );
    const refs = database.raw
      .prepare(
        `SELECT provider_id, external_ref
         FROM conversations
         WHERE project_id = ?
         ORDER BY provider_id`,
      )
      .all(project.id);

    console.log(JSON.stringify({
      status: output.status,
      responseCount: output.responses.length,
      counts,
      refs,
    }, null, 2));

    if (
      output.status !== "COMPLETED" ||
      output.responses.length !== TURN_COUNT ||
      counts.chatgpt !== 20 ||
      counts.gemini !== 20 ||
      refs.length !== 2 ||
      refs.some((row) => !row.external_ref)
    ) {
      throw new Error(`Endurance acceptance failed: ${JSON.stringify({ counts, refs })}`);
    }

    console.log("ENDURANCE_ACCEPTANCE=PASS");
  } catch (error) {
    const diagnosticPath = writeDiagnostic(error, {
      operation: "endurance:20x20",
      projectId: project.id,
      expectedTurns: TURN_COUNT,
    });
    console.error(`ENDURANCE_ACCEPTANCE=FAIL diagnostic=${diagnosticPath}`);
    throw error;
  } finally {
    await Promise.allSettled([...adapters.values()].map((adapter) => adapter.close()));
    database.close();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
