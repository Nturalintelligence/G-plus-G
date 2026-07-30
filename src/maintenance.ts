import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProviderId } from "./adapters/adapter-registry.js";

const DATABASE = resolve("user-data/database/orchestrator.sqlite");

export async function resetProviderSession(
  provider: ProviderId,
  profilesRoot = resolve("user-data/profiles"),
): Promise<string> {
  const profile = resolve(profilesRoot, provider);
  const allowedRoot = resolve(profilesRoot);
  if (!profile.startsWith(`${allowedRoot}\\`) && !profile.startsWith(`${allowedRoot}/`)) {
    throw new Error("Refusing to reset a profile outside user-data/profiles");
  }
  await rm(profile, { recursive: true, force: true });
  await rm(`${profile}.lock`, { force: true });
  return profile;
}

export async function backupDatabase(
  destination: string,
  databasePath = DATABASE,
): Promise<string> {
  await stat(databasePath);
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(databasePath, target);
  return target;
}

export async function restoreDatabase(
  source: string,
  databasePath = DATABASE,
): Promise<string> {
  const sourcePath = resolve(source);
  await stat(sourcePath);
  await mkdir(dirname(databasePath), { recursive: true });
  await copyFile(sourcePath, databasePath);
  return databasePath;
}
