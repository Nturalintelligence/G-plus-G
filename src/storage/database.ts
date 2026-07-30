import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.js";
import { dataPath } from "../paths.js";

export class AppDatabase {
  readonly raw: DatabaseSync;
  readonly path: string;

  constructor(path = dataPath("orchestrator.sqlite")) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.raw = new DatabaseSync(this.path);
    this.raw.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
    `);
    if (this.path !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL;");
  }

  migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.raw
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => Number(row.version)),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
      });
    }
  }

  transaction<T>(operation: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}
