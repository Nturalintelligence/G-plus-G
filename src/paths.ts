import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DATA_ROOT_ENV = "G_PLUS_G_USER_DATA";

export function dataRoot(): string {
  return resolve(process.env[DATA_ROOT_ENV] ?? defaultDataRoot());
}

export function dataPath(...segments: string[]): string {
  return resolve(dataRoot(), ...segments);
}

export function configureDataRoot(path: string): void {
  process.env[DATA_ROOT_ENV] = resolve(path);
}

function defaultDataRoot(): string {
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "multi-llm-orchestrator-feasibility");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "multi-llm-orchestrator-feasibility");
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "multi-llm-orchestrator-feasibility",
  );
}
