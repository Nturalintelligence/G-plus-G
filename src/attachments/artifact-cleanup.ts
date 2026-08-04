import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { LocalArtifactStore } from "./artifact-store.js";

export interface CleanupReport {
  scannedFilesCount: number;
  referencedFilesCount: number;
  deletedOrphanFilesCount: number;
  freedBytes: number;
}

export class ArtifactCleanupManager {
  private store: LocalArtifactStore;

  constructor(private db: DatabaseSync, customStore?: LocalArtifactStore) {
    this.store = customStore || new LocalArtifactStore();
  }

  /**
   * Reference-safe crash-safe orphan file cleanup.
   * Scans store directory and deletes unreferenced files older than gracePeriodMs.
   */
  public performOrphanCleanup(gracePeriodMs: number = 24 * 3600 * 1000): CleanupReport {
    const baseDir = this.store.getBaseDir();
    let scannedFilesCount = 0;
    let referencedFilesCount = 0;
    let deletedOrphanFilesCount = 0;
    let freedBytes = 0;

    if (!fs.existsSync(baseDir)) {
      return { scannedFilesCount, referencedFilesCount, deletedOrphanFilesCount, freedBytes };
    }

    // Query all referenced local_relative_paths from SQLite
    const activeMsgRows = this.db.prepare("SELECT local_relative_path FROM message_attachments WHERE local_relative_path IS NOT NULL").all() as Array<{ local_relative_path: string }>;
    const activeDlRows = this.db.prepare("SELECT local_relative_path FROM downloaded_artifacts WHERE local_relative_path IS NOT NULL").all() as Array<{ local_relative_path: string }>;

    const activePathsSet = new Set<string>();
    for (const row of activeMsgRows) {
      if (row.local_relative_path) activePathsSet.add(path.normalize(row.local_relative_path));
    }
    for (const row of activeDlRows) {
      if (row.local_relative_path) activePathsSet.add(path.normalize(row.local_relative_path));
    }

    const now = Date.now();

    const walkDir = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          scannedFilesCount += 1;
          const relativePath = path.normalize(path.relative(baseDir, fullPath));

          if (activePathsSet.has(relativePath)) {
            referencedFilesCount += 1;
          } else {
            // Check file age against grace period
            const stat = fs.statSync(fullPath);
            const ageMs = now - stat.mtimeMs;

            if (ageMs > gracePeriodMs) {
              freedBytes += stat.size;
              fs.unlinkSync(fullPath);
              deletedOrphanFilesCount += 1;
            }
          }
        }
      }
    };

    walkDir(baseDir);

    return {
      scannedFilesCount,
      referencedFilesCount,
      deletedOrphanFilesCount,
      freedBytes,
    };
  }
}
