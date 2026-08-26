import crypto from "node:crypto";
import net from "node:net";
import { lookup } from "node:dns/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "playwright";
import { LocalArtifactStore, sniffMimeType } from "./artifact-store.js";
import type { AttachmentSource } from "./attachments.js";

export interface DownloadedArtifactRecord {
  id: string;
  messageId: string;
  projectId: string;
  providerId: string;
  originalUrl: string;
  sha256: string;
  localRelativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: "READY" | "DOWNLOAD_EXPIRED" | "FAILED" | "QUARANTINED";
  downloadedAt: string;
  failureReason?: ArtifactFailureReason;
  failureDetail?: string;
}

export type ArtifactFailureReason =
  | "EMPTY_RESPONSE_BODY"
  | "DOWNLOAD_URL_EXPIRED"
  | "DOWNLOAD_CONTROL_MISSING"
  | "PREVIEW_NOT_ORIGINAL"
  | "AUTHENTICATED_FETCH_FAILED"
  | "MIME_VALIDATION_FAILED"
  | "INTEGRITY_VALIDATION_FAILED";

class ArtifactDownloadFailure extends Error {
  constructor(readonly reason: ArtifactFailureReason, message: string) {
    super(message);
    this.name = "ArtifactDownloadFailure";
  }
}

export interface DownloadUrlPolicy {
  allowedDomainSuffixes: readonly string[];
  resolveHostname?: HostnameResolver;
}

export interface ArtifactDownloadOptions {
  projectId: string;
  messageId: string;
  providerId: string;
  url: string;
  label?: string;
  allowedDomainSuffixes?: readonly string[];
  maxBytes?: number;
  allowedMimeTypes?: readonly string[];
  expectedSha256?: string;
  maxRedirects?: number;
  downloadEventTimeoutMs?: number;
  expectArtifact?: boolean;
}

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const PROVIDER_DOWNLOAD_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  chatgpt: ["chatgpt.com", "openai.com", "oaiusercontent.com", "oaistatic.com"],
  gemini: ["gemini.google.com", "googleusercontent.com"],
};
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = normalizeHostname(ip);
  const family = net.isIP(normalized);
  if (family === 4) {
    const octets = parseIpv4(normalized);
    if (!octets) return true;
    const [a, b, c] = octets as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return mapped?.[1] ? isPrivateOrReservedIp(mapped[1]) : false;
  }
  return true;
}

export function isUrlSsrfSafe(targetUrl: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol.toLowerCase() !== "https:") {
      return { safe: false, reason: `Blocked unsafe protocol: ${parsed.protocol.toLowerCase()}` };
    }
    if (parsed.username || parsed.password) return { safe: false, reason: "Credential-bearing URLs are blocked" };
    const hostname = normalizeHostname(parsed.hostname);
    if (
      BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")
    ) return { safe: false, reason: `Blocked local or metadata hostname: ${hostname}` };
    if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
      return { safe: false, reason: `Blocked private or reserved IP: ${hostname}` };
    }
    return { safe: true };
  } catch (error) {
    return { safe: false, reason: `Invalid URL: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function isAllowedDomain(hostname: string, suffixes: readonly string[]): boolean {
  const normalized = normalizeHostname(hostname);
  return suffixes.some((candidate) => {
    const suffix = normalizeHostname(candidate);
    return normalized === suffix || normalized.endsWith(`.${suffix}`);
  });
}

const systemResolver: HostnameResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

export async function validateDownloadUrl(targetUrl: string, policy: DownloadUrlPolicy): Promise<URL> {
  const initial = isUrlSsrfSafe(targetUrl);
  if (!initial.safe) throw new Error(`SSRF Blocked: ${initial.reason}`);
  const parsed = new URL(targetUrl);
  const hostname = normalizeHostname(parsed.hostname);
  if (!isAllowedDomain(hostname, policy.allowedDomainSuffixes)) {
    throw new Error(`Download domain is not allowlisted: ${hostname}`);
  }

  const addresses = net.isIP(hostname)
    ? [hostname]
    : await (policy.resolveHostname ?? systemResolver)(hostname);
  if (addresses.length === 0) throw new Error(`Download hostname did not resolve: ${hostname}`);
  const unsafeAddress = addresses.find(isPrivateOrReservedIp);
  if (unsafeAddress) throw new Error(`SSRF Blocked after DNS resolution: ${unsafeAddress}`);
  return parsed;
}

function contentTypeWithoutParameters(value: string | undefined): string {
  return (value || "").split(";", 1)[0]!.trim().toLowerCase();
}

function urlWithoutCredentialsOrTokens(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function filenameFromHeadersOrUrl(headers: Record<string, string>, url: URL, label?: string): string {
  if (label?.trim()) return label.trim();
  const disposition = headers["content-disposition"] || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const candidate = encoded ? decodeURIComponent(encoded) : plain;
  if (candidate?.trim()) return candidate.trim();
  const basename = path.posix.basename(url.pathname);
  try {
    return decodeURIComponent(basename || "downloaded_artifact");
  } catch {
    return basename || "downloaded_artifact";
  }
}

function validateDownloadedContent(
  buffer: Buffer,
  fileName: string,
  declaredMime: string,
  allowedMimeTypes: ReadonlySet<string>,
  maxBytes: number,
  expectedSha256?: string,
): { sha256: string; sniffedMime: string } {
  if (buffer.length === 0) throw new ArtifactDownloadFailure("EMPTY_RESPONSE_BODY", "Provider returned an empty response body");
  if (buffer.length > maxBytes) throw new Error(`Downloaded artifact exceeds ${maxBytes} bytes`);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (expectedSha256 && sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new ArtifactDownloadFailure("INTEGRITY_VALIDATION_FAILED", "Downloaded artifact SHA-256 does not match the approved value");
  }
  const sniffedMime = sniffMimeType(buffer, fileName);
  if (!allowedMimeTypes.has(sniffedMime)) throw new ArtifactDownloadFailure("MIME_VALIDATION_FAILED", `Downloaded artifact MIME is blocked: ${sniffedMime}`);
  if (declaredMime && declaredMime !== "application/octet-stream" && !allowedMimeTypes.has(declaredMime)) {
    throw new ArtifactDownloadFailure("MIME_VALIDATION_FAILED", `Response Content-Type is blocked: ${declaredMime}`);
  }
  const textEquivalent = new Set(["text/plain", "text/markdown"]);
  if (
    declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== sniffedMime &&
    !(textEquivalent.has(declaredMime) && textEquivalent.has(sniffedMime))
  ) throw new ArtifactDownloadFailure("MIME_VALIDATION_FAILED", `Response MIME mismatch: declared ${declaredMime}, detected ${sniffedMime}`);
  return { sha256, sniffedMime };
}

function safeFailureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/[?&](?:token|sig|signature|auth)=[^\s&]+/gi, "[redacted]").slice(0, 300);
}

function failureReason(error: unknown, fallback: ArtifactFailureReason): ArtifactFailureReason {
  if (error instanceof ArtifactDownloadFailure) return error.reason;
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP (?:401|403|404|410)|expired|ист[её]к/i.test(message)) return "DOWNLOAD_URL_EXPIRED";
  if (/MIME|Content-Type/i.test(message)) return "MIME_VALIDATION_FAILED";
  if (/SHA-256|integrity/i.test(message)) return "INTEGRITY_VALIDATION_FAILED";
  if (/empty|0 bytes/i.test(message)) return "EMPTY_RESPONSE_BODY";
  return fallback;
}

export class ResponseArtifactDownloader {
  private readonly store: LocalArtifactStore;
  private readonly resolveHostname: HostnameResolver;

  constructor(
    private readonly db: DatabaseSync,
    customStore?: LocalArtifactStore,
    options: { resolveHostname?: HostnameResolver } = {},
  ) {
    this.store = customStore || new LocalArtifactStore();
    this.resolveHostname = options.resolveHostname ?? systemResolver;
  }

  /** Scans a bound assistant turn. URLs are candidates, not trusted downloads. */
  public async extractTurnArtifactsFromPage(
    page: Page,
    turnSelector: string,
  ): Promise<Array<{ label: string; url: string; isImage: boolean }>> {
    try {
      const turnLocator = page.locator(turnSelector).last();
      if ((await turnLocator.count().catch(() => 0)) === 0) return [];
      return await turnLocator.evaluate((el) => {
        const results: Array<{ label: string; url: string; isImage: boolean }> = [];
        // A plain image is presentation content, not proof of a downloadable
        // artifact. Provider file cards commonly contain decorative HTTPS
        // icons; treating every <img> as a file persisted those icons as user
        // results. Generated images remain supported when the provider exposes
        // an explicit download link/control around them.
        el.querySelectorAll("a[href]").forEach((anchor) => {
          const href = anchor.getAttribute("href");
          const accessibleName = [
            anchor.getAttribute("aria-label"),
            anchor.getAttribute("title"),
            anchor.getAttribute("data-testid"),
          ].filter(Boolean).join(" ");
          const explicitlyDownloadable = anchor.hasAttribute("download") || /download|file|attachment|скач|файл/i.test(accessibleName);
          if ((href?.startsWith("https://") || href?.startsWith("blob:https://")) && explicitlyDownloadable) {
            results.push({ label: anchor.textContent?.trim() || "Downloadable File", url: href, isImage: false });
          }
        });
        return results;
      });
    } catch {
      return [];
    }
  }

  /** Downloads only candidates found inside the response bound to this turn. */
  public async downloadTurnArtifactsFromPage(
    page: Page,
    turnSelector: string,
    options: Omit<ArtifactDownloadOptions, "url" | "label">,
  ): Promise<DownloadedArtifactRecord[]> {
    const candidates = await this.extractTurnArtifactsFromPage(page, turnSelector);
    const unique = [...new Map(candidates.map((item) => [item.url, item])).values()];
    const records: DownloadedArtifactRecord[] = [];
    for (const candidate of unique) {
      try {
        records.push(candidate.url.startsWith("blob:")
          ? await this.downloadBlobFromPage(page, { ...options, url: candidate.url, label: candidate.label })
          : await this.downloadArtifactSsrfSafe(page, { ...options, url: candidate.url, label: candidate.label }));
      } catch (error) {
        records.push(this.persistFailure(
          { ...options, url: candidate.url, label: candidate.label },
          failureReason(error, "AUTHENTICATED_FETCH_FAILED"),
          error,
        ));
      }
    }
    const turn = page.locator(turnSelector).last();
    // CSS `i` matching is not reliable for Cyrillic case folding in Chromium.
    // Keep explicit upper/lower Russian stems so `Скачать …` is not missed.
    const controls = turn.locator([
      "a[download]",
      'button[aria-label*="download" i]',
      'button[aria-label*="скач"]',
      'button[aria-label*="Скач"]',
      'a[aria-label*="download" i]',
      'a[aria-label*="скач"]',
      'a[aria-label*="Скач"]',
    ].join(", "));
    const count = Math.min(await controls.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const href = await control.getAttribute("href").catch(() => null);
      if (href && unique.some((candidate) => candidate.url === href)) continue;
      try {
        records.push(await this.captureDownloadFromLocator(page, control, options));
      } catch (error) {
        records.push(this.persistFailure(
          { ...options, url: href?.startsWith("https://") ? href : "", label: await control.textContent().catch(() => null) || "" },
          failureReason(error, "AUTHENTICATED_FETCH_FAILED"),
          error,
        ));
      }
    }
    // Gemini may render a generated file as an assistant-bound card whose
    // Open action reveals the actual download control in an app-level overlay.
    // Scope the expansion trigger to the bound turn, then scope the resulting
    // control to an explicit accessible download action. This is never a send
    // or retry operation.
    if (options.providerId === "gemini" && !records.some((record) => record.status === "READY")) {
      const expand = turn.locator('[data-test-id="open-button"]').first();
      if ((await expand.count().catch(() => 0)) === 1) {
        await expand.click().catch(() => undefined);
        await page.waitForTimeout(250).catch(() => undefined);
        const expandedControls = page.locator([
          '[role="button"][aria-label="Скачать"]',
          '[role="button"][aria-label="Download"]',
          'button[aria-label="Скачать"]',
          'button[aria-label="Download"]',
        ].join(", "));
        await expandedControls.first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
        const expandedCount = Math.min(await expandedControls.count().catch(() => 0), 3);
        if (expandedCount === 0) {
          records.push(this.persistFailure(
            { ...options, url: "", label: "" },
            "PREVIEW_NOT_ORIGINAL",
            new Error("Gemini preview did not expose an original download control"),
          ));
        }
        for (let index = 0; index < expandedCount; index += 1) {
          const control = expandedControls.nth(index);
          try {
            records.push(await this.captureDownloadFromLocator(page, control, options));
            break;
          } catch (error) {
            records.push(this.persistFailure(
              { ...options, url: "", label: "" },
              failureReason(error, "AUTHENTICATED_FETCH_FAILED"),
              error,
            ));
          }
        }
      }
    }
    if (records.length === 0 && options.expectArtifact) {
      records.push(this.persistFailure(
        { ...options, url: "", label: "" },
        "DOWNLOAD_CONTROL_MISSING",
        new Error("Provider response did not expose a download control"),
      ));
    }
    return records;
  }

  /** Reads a provider-bound blob URL inside the authenticated page with a hard byte limit. */
  public async downloadBlobFromPage(page: Page, options: ArtifactDownloadOptions): Promise<DownloadedArtifactRecord> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    try {
      if (!options.url.startsWith("blob:https://")) throw new Error("Only HTTPS-backed blob URLs are accepted");
      const embedded = options.url.slice("blob:".length);
      await validateDownloadUrl(embedded, {
        allowedDomainSuffixes: this.allowedDomains(options.providerId, options.allowedDomainSuffixes),
        resolveHostname: this.resolveHostname,
      });
      const result = await page.evaluate(async ({ url, limit }) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Blob fetch failed with HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0) throw new Error("Blob response body is empty");
        if (bytes.byteLength > limit) throw new Error("Blob response exceeds the allowed size");
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
        }
        return { base64: btoa(binary), mimeType: response.headers.get("content-type") || "" };
      }, { url: options.url, limit: maxBytes });
      return this.persistBuffer(Buffer.from(result.base64, "base64"), options, contentTypeWithoutParameters(result.mimeType));
    } catch (error) {
      return this.persistFailure(options, failureReason(error, "AUTHENTICATED_FETCH_FAILED"), error);
    }
  }

  /**
   * Preferred path for provider download controls. It captures Playwright's
   * download event in the authenticated BrowserContext instead of replaying an
   * unauthenticated URL.
   */
  public async captureDownloadFromLocator(
    page: Page,
    trigger: Locator,
    options: Omit<ArtifactDownloadOptions, "url" | "label">,
  ): Promise<DownloadedArtifactRecord> {
    const timeout = Math.min(Math.max(options.downloadEventTimeoutMs ?? 5_000, 250), 15_000);
    const domains = this.allowedDomains(options.providerId, options.allowedDomainSuffixes);
    const downloadPromise = page.waitForEvent("download", { timeout }).then((download) => ({ kind: "download" as const, download }));
    const responsePromise = typeof page.waitForResponse === "function"
      ? page.waitForResponse(async (response) => {
          if (!response.ok()) return false;
          const mime = contentTypeWithoutParameters(response.headers()["content-type"]);
          if (!mime.startsWith("image/")) return false;
          const responseUrl = new URL(response.url());
          if (options.providerId === "gemini") {
            const generatedPath = responseUrl.pathname.includes("/gg/") || responseUrl.pathname.includes("/rd-gg/");
            if (!generatedPath || !/=s0-d-I(?:$|[&#])/i.test(responseUrl.href)) return false;
          }
          try {
            await validateDownloadUrl(response.url(), { allowedDomainSuffixes: domains, resolveHostname: this.resolveHostname });
            return true;
          } catch {
            return false;
          }
        }, { timeout }).then((response) => ({ kind: "response" as const, response }))
      : null;
    await trigger.click();
    const captured = await Promise.any([
      downloadPromise,
      ...(responsePromise ? [responsePromise] : []),
    ]);
    if (captured.kind === "response") {
      const url = captured.response.url();
      const declaredMime = contentTypeWithoutParameters(captured.response.headers()["content-type"]);
      const extension = declaredMime === "image/jpeg" ? ".jpg" : declaredMime === "image/webp" ? ".webp" : ".png";
      return this.persistBuffer(await captured.response.body(), {
        ...options,
        url,
        label: `generated-image${extension}`,
      }, declaredMime);
    }
    const download = captured.download;
    const url = download.url();
    if (url.startsWith("blob:")) {
      const embedded = url.slice("blob:".length);
      await validateDownloadUrl(embedded, { allowedDomainSuffixes: domains, resolveHostname: this.resolveHostname });
    } else {
      await validateDownloadUrl(url, { allowedDomainSuffixes: domains, resolveHostname: this.resolveHostname });
    }
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Provider download stream is unavailable");
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        stream.destroy();
        throw new Error(`Downloaded artifact exceeds ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
    return this.persistBuffer(Buffer.concat(chunks), {
      ...options,
      url,
      label: download.suggestedFilename(),
    }, "");
  }

  /** Manual redirect traversal validates every hop before following it. */
  public async downloadArtifactSsrfSafe(page: Page, options: ArtifactDownloadOptions): Promise<DownloadedArtifactRecord> {
    const domains = this.allowedDomains(options.providerId, options.allowedDomainSuffixes);
    let current = await validateDownloadUrl(options.url, {
      allowedDomainSuffixes: domains,
      resolveHostname: this.resolveHostname,
    });
    const maxRedirects = options.maxRedirects ?? 5;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;

    try {
      for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        const response = await page.context().request.get(current.toString(), {
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        const status = response.status();
        const headers = response.headers();
        if (status >= 300 && status < 400) {
          const location = headers.location;
          await response.dispose();
          if (!location) throw new Error(`Redirect ${status} did not include Location`);
          if (redirect === maxRedirects) throw new Error("Artifact redirect limit exceeded");
          current = await validateDownloadUrl(new URL(location, current).toString(), {
            allowedDomainSuffixes: domains,
            resolveHostname: this.resolveHostname,
          });
          continue;
        }
        if (!response.ok()) {
          await response.dispose();
          if ([401, 403, 404, 410].includes(status)) {
            throw new ArtifactDownloadFailure("DOWNLOAD_URL_EXPIRED", `Artifact request failed with HTTP ${status}`);
          }
          throw new ArtifactDownloadFailure("AUTHENTICATED_FETCH_FAILED", `Artifact request failed with HTTP ${status}`);
        }
        const contentLength = Number(headers["content-length"] || "0");
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          await response.dispose();
          throw new Error(`Downloaded artifact exceeds ${maxBytes} bytes`);
        }
        const buffer = await response.body();
        await response.dispose();
        const fileName = filenameFromHeadersOrUrl(headers, current, options.label);
        return this.persistBuffer(buffer, { ...options, label: fileName }, contentTypeWithoutParameters(headers["content-type"]));
      }
      throw new Error("Artifact redirect loop terminated unexpectedly");
    } catch (error) {
      return this.persistFailure(options, failureReason(error, "AUTHENTICATED_FETCH_FAILED"), error);
    }
  }

  private allowedDomains(providerId: string, overrides?: readonly string[]): readonly string[] {
    const domains = overrides ?? PROVIDER_DOWNLOAD_DOMAINS[providerId];
    if (!domains || domains.length === 0) throw new Error(`No response-download domain policy for provider: ${providerId}`);
    return domains;
  }

  private persistBuffer(buffer: Buffer, options: ArtifactDownloadOptions, declaredMime: string): DownloadedArtifactRecord {
    const source = options.providerId as AttachmentSource;
    if (source !== "chatgpt" && source !== "gemini") throw new Error(`Unsupported response artifact source: ${options.providerId}`);
    const fileName = options.label || "downloaded_artifact";
    const allowedMimeTypes = new Set(options.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES);
    const validated = validateDownloadedContent(
      buffer,
      fileName,
      declaredMime,
      allowedMimeTypes,
      options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
      options.expectedSha256,
    );
    const ref = this.store.storeBuffer(buffer, {
      projectId: options.projectId,
      messageId: options.messageId,
      source,
      originalFileName: fileName,
      customMaxSizeBytes: options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
    });
    const record: DownloadedArtifactRecord = {
      id: `dl_${crypto.randomUUID()}`,
      messageId: options.messageId,
      projectId: options.projectId,
      providerId: options.providerId,
      originalUrl: urlWithoutCredentialsOrTokens(options.url),
      sha256: validated.sha256,
      localRelativePath: ref.localRelativePath,
      fileName: ref.fileName,
      mimeType: ref.mimeType,
      sizeBytes: ref.sizeBytes,
      status: ref.status === "QUARANTINED" ? "QUARANTINED" : "READY",
      downloadedAt: new Date().toISOString(),
    };
    this.insertRecord(record);
    return record;
  }

  private persistFailure(options: ArtifactDownloadOptions, reason: ArtifactFailureReason, error?: unknown): DownloadedArtifactRecord {
    const record: DownloadedArtifactRecord = {
      id: `dl_${crypto.randomUUID()}`,
      messageId: options.messageId,
      projectId: options.projectId,
      providerId: options.providerId,
      originalUrl: urlWithoutCredentialsOrTokens(options.url),
      sha256: "",
      localRelativePath: "",
      fileName: options.label?.trim() || "",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      status: "FAILED",
      downloadedAt: new Date().toISOString(),
      failureReason: reason,
      failureDetail: safeFailureDetail(error ?? reason),
    };
    this.insertRecord(record);
    return record;
  }

  private insertRecord(record: DownloadedArtifactRecord): void {
    this.db.prepare(`
      INSERT INTO downloaded_artifacts
      (id, message_id, project_id, provider_id, original_url, sha256, local_relative_path, file_name, mime_type, size_bytes, status, downloaded_at, failure_reason, failure_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.messageId,
      record.projectId,
      record.providerId,
      record.originalUrl,
      record.sha256,
      record.localRelativePath,
      record.fileName,
      record.mimeType,
      record.sizeBytes,
      record.status,
      record.downloadedAt,
      record.failureReason ?? null,
      record.failureDetail ?? null,
    );
  }
}
