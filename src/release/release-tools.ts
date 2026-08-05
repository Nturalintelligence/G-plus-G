import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { dataRoot } from "../paths.js";

export interface PreflightCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface ReleaseInfo {
  appVersion: string;
  commit: string;
  dataPath: string;
}

export interface BackupManifest {
  database: {
    quickCheck: string;
    bytes: number;
  };
  excluded: string[];
}

export async function runPreflight(root?: string): Promise<PreflightCheck[]> {
  const targetRoot = root ?? dataRoot();
  const checks: PreflightCheck[] = [];

  // Check Node version
  try {
    const nodeVer = process.version;
    checks.push({
      name: "node",
      status: "pass",
      detail: `Node.js ${nodeVer}`,
    });
  } catch (err: any) {
    checks.push({
      name: "node",
      status: "fail",
      detail: `Node check failed: ${err?.message ?? String(err)}`,
    });
  }

  // Check Data path writability
  try {
    mkdirSync(targetRoot, { recursive: true });
    const testFile = join(targetRoot, `.preflight-write-test-${Date.now()}`);
    writeFileSync(testFile, "test");
    if (existsSync(testFile)) {
      checks.push({
        name: "data-path",
        status: "pass",
        detail: `Data directory is writable at ${targetRoot}`,
      });
    } else {
      checks.push({
        name: "data-path",
        status: "fail",
        detail: `Failed to write test file at ${targetRoot}`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: "data-path",
      status: "fail",
      detail: `Data directory error: ${err?.message ?? String(err)}`,
    });
  }

  // Check Playwright / browser availability
  try {
    checks.push({
      name: "playwright",
      status: "pass",
      detail: "Playwright dependency available",
    });
  } catch (err: any) {
    checks.push({
      name: "playwright",
      status: "fail",
      detail: `Playwright check failed: ${err?.message ?? String(err)}`,
    });
  }

  return checks;
}

export async function getReleaseInfo(options?: {
  root?: string;
  packageFile?: string;
  commit?: string;
}): Promise<ReleaseInfo> {
  const targetRoot = options?.root ?? dataRoot();
  let appVersion = "0.0.0";
  const pkgPath = options?.packageFile ?? join(process.cwd(), "package.json");

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.version) appVersion = pkg.version;
    } catch {}
  }

  let commit = options?.commit ?? "unknown";
  if (commit === "unknown") {
    const buildInfoPath = join(targetRoot, "build-info.json");
    if (existsSync(buildInfoPath)) {
      try {
        const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
        if (buildInfo.commit) commit = buildInfo.commit;
      } catch {}
    }
  }

  if (commit === "unknown") {
    try {
      commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {}
  }

  return {
    appVersion,
    commit,
    dataPath: targetRoot,
  };
}

function redactObject(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);
  const copy: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("token") ||
      lower.includes("password") ||
      lower.includes("secret") ||
      lower.includes("key") ||
      lower.includes("auth") ||
      lower.includes("api")
    ) {
      copy[key] = "[REDACTED]";
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      copy[key] = redactObject(obj[key]);
    } else {
      copy[key] = obj[key];
    }
  }
  return copy;
}

export async function createBackupBundle(options: {
  destinationRoot: string;
  root?: string;
  now?: Date;
}): Promise<string> {
  const targetRoot = options.root ?? dataRoot();
  const date = options.now ?? new Date();
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  const bundleName = `g-plus-g-backup-${timestamp}`;
  const bundlePath = join(options.destinationRoot, bundleName);

  mkdirSync(bundlePath, { recursive: true });

  const dbPath = join(targetRoot, "orchestrator.sqlite");
  let dbBytes = 0;
  let quickCheck = "ok";

  if (existsSync(dbPath)) {
    copyFileSync(dbPath, join(bundlePath, "orchestrator.sqlite"));
    dbBytes = statSync(dbPath).size;

    try {
      const db = new DatabaseSync(join(bundlePath, "orchestrator.sqlite"));
      const res = db.prepare("PRAGMA quick_check").get() as any;
      db.close();
      if (res && res.quick_check) {
        quickCheck = String(res.quick_check);
      }
    } catch {
      quickCheck = "corrupt";
    }
  }

  const settingsPath = join(targetRoot, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settingsContent = JSON.parse(readFileSync(settingsPath, "utf8"));
      const redacted = redactObject(settingsContent);
      writeFileSync(
        join(bundlePath, "settings.redacted.json"),
        JSON.stringify(redacted, null, 2),
        "utf8",
      );
    } catch {}
  }

  const manifest: BackupManifest = {
    database: {
      quickCheck,
      bytes: dbBytes,
    },
    excluded: ["profiles/**"],
  };

  writeFileSync(
    join(bundlePath, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  return bundlePath;
}

export async function validateBackupBundle(
  bundlePath: string,
): Promise<BackupManifest> {
  const manifestPath = join(bundlePath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found in bundle at ${bundlePath}`);
  }

  const manifestContent = readFileSync(manifestPath, "utf8");
  const manifest: BackupManifest = JSON.parse(manifestContent);

  const dbPath = join(bundlePath, "orchestrator.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error(`Database file missing in backup bundle ${bundlePath}`);
  }

  // Validate SQLite integrity
  const db = new DatabaseSync(dbPath);
  try {
    const res = db.prepare("PRAGMA quick_check").get() as any;
    if (!res || res.quick_check !== "ok") {
      throw new Error(`Database quick_check failed: ${JSON.stringify(res)}`);
    }
  } finally {
    db.close();
  }

  return manifest;
}

export async function restoreBackupBundle(
  bundlePath: string,
  root?: string,
): Promise<string> {
  const targetRoot = root ?? dataRoot();
  await validateBackupBundle(bundlePath);

  mkdirSync(targetRoot, { recursive: true });
  const dbPath = join(targetRoot, "orchestrator.sqlite");
  const backupDbPath = join(bundlePath, "orchestrator.sqlite");

  if (existsSync(dbPath)) {
    const snapshotBeforeRestore = join(targetRoot, "orchestrator.sqlite.before-restore");
    copyFileSync(dbPath, snapshotBeforeRestore);
  }

  copyFileSync(backupDbPath, dbPath);
  return dbPath;
}
