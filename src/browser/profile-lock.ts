import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

interface LockRecord {
  pid: number;
  createdAt: string;
}

export class ProfileLock {
  private acquired = false;
  readonly path: string;

  constructor(profileDirectory: string) {
    this.path = resolve(`${profileDirectory}.lock`);
  }

  async acquire(): Promise<void> {
    try {
      const handle = await open(this.path, "wx");
      try {
        const record: LockRecord = { pid: process.pid, createdAt: new Date().toISOString() };
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      this.acquired = true;
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const record = await this.readRecord();
    if (record && isProcessAlive(record.pid)) {
      throw new Error(
        `Browser profile is already in use by PID ${record.pid} since ${record.createdAt}`,
      );
    }

    await unlink(this.path).catch(() => undefined);
    await this.acquire();
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    const record = await this.readRecord();
    if (record?.pid === process.pid) await unlink(this.path).catch(() => undefined);
    this.acquired = false;
  }

  private async readRecord(): Promise<LockRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<LockRecord>;
      return typeof value.pid === "number" && typeof value.createdAt === "string"
        ? { pid: value.pid, createdAt: value.createdAt }
        : null;
    } catch {
      return null;
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "EPERM"
    );
  }
}
