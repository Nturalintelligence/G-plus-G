import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { arch, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dataPath, dataRoot } from "../paths.js";
import { bundledChromiumExecutable } from "../browser/runtime.js";
import { findSystemChrome } from "../browser/system-browser-login.js";

export interface ReleaseInfo {
  appVersion: string;
  commit: string;
  nodeVersion: string;
  platform: string;
  dataPath: string;
  generatedAt: string;
}

export interface PreflightCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface BackupManifest {
  format: 1;
  createdAt: string;
  app: ReleaseInfo;
  database: { file: string; bytes: number; sha256: string; quickCheck: string };
  metadata: {
    logs: Array<{ name: string; bytes: number; modifiedAt: string }>;
    settingsFile?: string;
  };
  excluded: string[];
}

function packageJsonPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "..", "..", "package.json"),
    resolve(moduleDirectory, "..", "..", "..", "package.json"),
    resolve(process.cwd(), "package.json"),
  ];
  return candidates.find(existsSync) ?? resolve(moduleDirectory, "..", "..", "package.json");
}

export async function getReleaseInfo(
  options: { root?: string; packageFile?: string; commit?: string } = {},
): Promise<ReleaseInfo> {
  const packageFile = options.packageFile ?? packageJsonPath();
  const pkg = JSON.parse(await readFile(packageFile, "utf8")) as { version?: string };
  let commit = options.commit;
  if (!commit) {
    const buildInfoPath = resolve(dirname(packageFile), "build-info.json");
    try {
      const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8")) as {
        commit?: unknown;
      };
      if (typeof buildInfo.commit === "string" && buildInfo.commit.trim()) {
        commit = buildInfo.commit.trim();
      }
    } catch {
      // Development runs can read the repository directly below.
    }
  }
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
        cwd: dirname(packageFile),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      commit = "unknown";
    }
  }
  return {
    appVersion: pkg.version ?? "unknown",
    commit,
    nodeVersion: process.version,
    platform: `${platform()} ${release()} ${arch()}`,
    dataPath: resolve(options.root ?? dataRoot()),
    generatedAt: new Date().toISOString(),
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function inspectDatabase(path: string): { bytes: number; sha256: string; quickCheck: string } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA quick_check").get() as { quick_check?: string };
    const quickCheck = String(row.quick_check ?? "");
    if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed: ${quickCheck}`);
    const bytes = Number(database.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get()?.bytes ?? 0);
    const sha256 = createHash("sha256").update(readFileSyncCompat(path)).digest("hex");
    return { bytes, sha256, quickCheck };
  } finally {
    database.close();
  }
}

function readFileSyncCompat(path: string): Buffer {
  // Kept local so hashing remains synchronous while the SQLite read handle is closed promptly.
  return requireNodeFs().readFileSync(path);
}

function requireNodeFs(): typeof import("node:fs") {
  // eslint-free ESM-compatible indirection.
  return (process.getBuiltinModule("node:fs") as typeof import("node:fs"));
}

async function safeSettings(root: string, bundle: string): Promise<string | undefined> {
  const candidates = ["settings.json", "preferences.json"];
  for (const name of candidates) {
    const source = join(root, name);
    if (!existsSync(source)) continue;
    const parsed = JSON.parse(await readFile(source, "utf8")) as unknown;
    const redact = (value: unknown, key = ""): unknown => {
      if (/token|secret|password|cookie|authorization|api.?key/i.test(key)) return "[REDACTED]";
      if (Array.isArray(value)) return value.map((item) => redact(item));
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
            childKey,
            redact(child, childKey),
          ]),
        );
      }
      return value;
    };
    const target = "settings.redacted.json";
    await writeFile(join(bundle, target), `${JSON.stringify(redact(parsed), null, 2)}\n`, "utf8");
    return target;
  }
  return undefined;
}

export async function createBackupBundle(options: {
  destinationRoot: string;
  root?: string;
  now?: Date;
}): Promise<string> {
  const root = resolve(options.root ?? dataRoot());
  const source = join(root, "orchestrator.sqlite");
  await stat(source);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const destinationRoot = resolve(options.destinationRoot);
  await mkdir(destinationRoot, { recursive: true });
  const bundle = resolve(destinationRoot, `g-plus-g-backup-${stamp}`);
  await mkdir(bundle, { recursive: false });
  const snapshot = join(bundle, "orchestrator.sqlite");
  const sourceDb = new DatabaseSync(source);
  try {
    sourceDb.exec(`VACUUM INTO ${sqlString(snapshot)}`);
  } finally {
    sourceDb.close();
  }
  const inspected = inspectDatabase(snapshot);
  const logMetadata: BackupManifest["metadata"]["logs"] = [];
  const logDir = join(root, "logs");
  if (existsSync(logDir)) {
    for (const entry of requireNodeFs().readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const info = await stat(join(logDir, entry.name));
      logMetadata.push({
        name: entry.name,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }
  const settingsFile = await safeSettings(root, bundle);
  const manifest: BackupManifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    app: await getReleaseInfo({ root }),
    database: { file: basename(snapshot), ...inspected },
    metadata: { logs: logMetadata, ...(settingsFile ? { settingsFile } : {}) },
    excluded: ["profiles/**", "logs/* contents", "cookies", "credentials", "tokens"],
  };
  await writeFile(join(bundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return bundle;
}

export async function validateBackupBundle(bundlePath: string): Promise<BackupManifest> {
  const bundle = resolve(bundlePath);
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.format !== 1 || manifest.database.file !== "orchestrator.sqlite") {
    throw new Error("Unsupported or malformed backup manifest");
  }
  const databasePath = join(bundle, manifest.database.file);
  const inspected = inspectDatabase(databasePath);
  if (inspected.sha256 !== manifest.database.sha256) throw new Error("Backup checksum mismatch");
  return manifest;
}

export async function restoreBackupBundle(
  bundlePath: string,
  root = dataRoot(),
): Promise<string> {
  const manifest = await validateBackupBundle(bundlePath);
  const source = join(resolve(bundlePath), manifest.database.file);
  const destination = join(resolve(root), "orchestrator.sqlite");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.restore-${process.pid}`;
  await rm(temporary, { force: true });
  requireNodeFs().copyFileSync(source, temporary, constants.COPYFILE_EXCL);
  inspectDatabase(temporary);
  const previous = `${destination}.before-restore`;
  await rm(previous, { force: true });
  if (existsSync(destination)) await rename(destination, previous);
  try {
    await rename(temporary, destination);
    await rm(`${destination}-wal`, { force: true });
    await rm(`${destination}-shm`, { force: true });
  } catch (error) {
    if (existsSync(previous)) await rename(previous, destination);
    throw error;
  }
  return destination;
}

export async function runPreflight(root = dataRoot()): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  checks.push({
    name: "node",
    status: Number(process.versions.node.split(".")[0]) >= 20 ? "pass" : "fail",
    detail: process.version,
  });
  try {
    await mkdir(root, { recursive: true });
    await access(root, constants.R_OK | constants.W_OK);
    const probe = join(root, `.preflight-${process.pid}`);
    await writeFile(probe, "ok", { flag: "wx" });
    await rm(probe);
    checks.push({ name: "data-path", status: "pass", detail: resolve(root) });
  } catch (error) {
    checks.push({ name: "data-path", status: "fail", detail: String(error) });
  }
  let browser: string | undefined = bundledChromiumExecutable();
  if (!browser) {
    try {
      browser = findSystemChrome();
    } catch {
      // Reported below.
    }
  }
  checks.push({
    name: "browser",
    status: browser ? "pass" : "warn",
    detail: browser ?? "No bundled Chromium or system Chrome detected",
  });
  try {
    await import("playwright");
    checks.push({ name: "playwright", status: "pass", detail: "module available" });
  } catch (error) {
    checks.push({ name: "playwright", status: "fail", detail: String(error) });
  }
  return checks;
}
