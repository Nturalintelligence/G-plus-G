import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { Page } from "playwright";
import { LocalArtifactStore, sniffMimeType } from "./artifact-store.js";
import { AttachmentRefV1 } from "./attachments.js";

export interface DownloadedArtifactRecord {
  id: string;
  messageId: string;
  projectId: string;
  providerId: string;
  originalUrl: string;
  sha256: string;
  localRelativePath: string;
  status: "READY" | "DOWNLOAD_EXPIRED" | "FAILED" | "QUARANTINED";
  downloadedAt: string;
}

export function isUrlSsrfSafe(targetUrl: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(targetUrl);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== "https:" && protocol !== "http:") {
      return { safe: false, reason: `Blocked unsafe protocol: ${protocol}` };
    }

    const rawHostname = parsed.hostname.toLowerCase();
    const hostname = rawHostname.replace(/^\[|\]$/g, "");

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    ) {
      return { safe: false, reason: "Blocked loopback address" };
    }

    // IP address checks
    if (net.isIP(hostname)) {
      if (
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        hostname.startsWith("169.254.") ||
        (hostname.startsWith("172.") &&
          (() => {
            const secondOctet = parseInt(hostname.split(".")[1] || "0", 10);
            return secondOctet >= 16 && secondOctet <= 31;
          })())
      ) {
        return { safe: false, reason: `Blocked private IP range: ${hostname}` };
      }
    }

    return { safe: true };
  } catch (err: any) {
    return { safe: false, reason: `Invalid URL: ${err.message}` };
  }
}

export class ResponseArtifactDownloader {
  private store: LocalArtifactStore;

  constructor(private db: DatabaseSync, customStore?: LocalArtifactStore) {
    this.store = customStore || new LocalArtifactStore();
  }

  /**
   * Scans the latest assistant turn in Playwright DOM for images and downloadable links.
   */
  public async extractTurnArtifactsFromPage(
    page: Page,
    turnSelector: string
  ): Promise<Array<{ label: string; url: string; isImage: boolean }>> {
    try {
      const turnLocator = page.locator(turnSelector).last();
      if ((await turnLocator.count().catch(() => 0)) === 0) return [];

      const artifacts = await turnLocator.evaluate((el) => {
        const results: Array<{ label: string; url: string; isImage: boolean }> = [];
        const imgs = el.querySelectorAll("img");
        imgs.forEach((img) => {
          const src = img.src || img.getAttribute("data-src");
          if (src && (src.startsWith("http") || src.startsWith("https"))) {
            results.push({ label: img.alt || "Generated Image", url: src, isImage: true });
          }
        });

        const links = el.querySelectorAll("a[href]");
        links.forEach((a) => {
          const href = a.getAttribute("href");
          if (href && (href.startsWith("http") || href.startsWith("https"))) {
            results.push({ label: a.textContent?.trim() || "Downloadable Link", url: href, isImage: false });
          }
        });

        return results;
      });

      return artifacts;
    } catch {
      return [];
    }
  }

  /**
   * Safely downloads an artifact from a web provider URL using authenticated page context.
   */
  public async downloadArtifactSsrfSafe(
    page: Page,
    options: {
      projectId: string;
      messageId: string;
      providerId: string;
      url: string;
      label?: string;
    }
  ): Promise<DownloadedArtifactRecord> {
    const ssrfCheck = isUrlSsrfSafe(options.url);
    if (!ssrfCheck.safe) {
      throw new Error(`SSRF Blocked: ${ssrfCheck.reason}`);
    }

    const artifactId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const downloadedAt = new Date().toISOString();

    try {
      // Download bytes in browser context
      const bufferBase64 = await page.evaluate(async (fetchUrl) => {
        const resp = await fetch(fetchUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(",")[1] || "");
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, options.url);

      const buf = Buffer.from(bufferBase64, "base64");
      const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      const fileName = options.label ? `${options.label.replace(/[^a-zA-Z0-9_\.]/g, "_")}.bin` : `artifact_${artifactId}.bin`;

      const ref = this.store.storeBuffer(buf, {
        projectId: options.projectId,
        messageId: options.messageId,
        source: options.providerId as any,
        originalFileName: fileName,
      });

      const record: DownloadedArtifactRecord = {
        id: artifactId,
        messageId: options.messageId,
        projectId: options.projectId,
        providerId: options.providerId,
        originalUrl: options.url,
        sha256,
        localRelativePath: ref.localRelativePath,
        status: ref.status === "QUARANTINED" ? "QUARANTINED" : "READY",
        downloadedAt,
      };

      this.db.prepare(`
        INSERT OR REPLACE INTO downloaded_artifacts
        (id, message_id, project_id, provider_id, original_url, sha256, local_relative_path, status, downloaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.messageId,
        record.projectId,
        record.providerId,
        record.originalUrl,
        record.sha256,
        record.localRelativePath,
        record.status,
        record.downloadedAt
      );

      return record;
    } catch (err: any) {
      const record: DownloadedArtifactRecord = {
        id: artifactId,
        messageId: options.messageId,
        projectId: options.projectId,
        providerId: options.providerId,
        originalUrl: options.url,
        sha256: "",
        localRelativePath: "",
        status: "FAILED",
        downloadedAt,
      };

      this.db.prepare(`
        INSERT OR REPLACE INTO downloaded_artifacts
        (id, message_id, project_id, provider_id, original_url, sha256, local_relative_path, status, downloaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.messageId,
        record.projectId,
        record.providerId,
        record.originalUrl,
        "",
        "",
        "FAILED",
        downloadedAt
      );

      return record;
    }
  }
}
