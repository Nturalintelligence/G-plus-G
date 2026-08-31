import crypto from "node:crypto";
import fs from "node:fs";
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
  acquisitionId?: string;
  retryOfAcquisitionId?: string;
  physicalClickCount?: number;
}

export type ArtifactFailureReason =
  | "EMPTY_RESPONSE_BODY"
  | "DOWNLOAD_URL_EXPIRED"
  | "DOWNLOAD_CONTROL_MISSING"
  | "PREVIEW_NOT_ORIGINAL"
  | "AUTHENTICATED_FETCH_FAILED"
  | "MIME_VALIDATION_FAILED"
  | "INTEGRITY_VALIDATION_FAILED"
  | "RELATIVE_URL_RESOLUTION_FAILED"
  | "MALFORMED_PROVIDER_URL"
  | "UNTRUSTED_PROVIDER_ORIGIN"
  | "REDIRECT_TARGET_REJECTED"
  | "SIGNED_URL_EXPIRED"
  | "DOWNLOAD_REQUIRES_UI_EVENT"
  | "BLOB_EXTRACTION_FAILED"
  | "ORIGINAL_ASSET_NOT_FOUND"
  | "DOWNLOAD_TRIGGER_NO_BYTES"
  | "DOWNLOAD_EVIDENCE_NOT_ACTIONABLE"
  | "DOWNLOAD_CONTROL_HIDDEN"
  | "DOWNLOAD_CONTROL_ZERO_BOUNDS"
  | "DOWNLOAD_CONTROL_IN_MENU"
  | "NETWORK_EVIDENCE_NO_BYTES"
  | "PASSIVE_EVENT_NOT_CORRELATED"
  | "ARTIFACT_RENDERED_AS_CODE_BLOCK"
  | "ARTIFACT_RESPONSE_NOT_FILE"
  | "DOWNLOAD_BROWSER_CANCELED"
  | "DOWNLOAD_CONTEXT_CLOSED"
  | "DOWNLOAD_PAGE_CLOSED"
  | "DOWNLOAD_COMPLETION_TIMEOUT"
  | "DOWNLOAD_SAVE_AS_FAILED"
  | "DOWNLOAD_PATH_UNAVAILABLE"
  | "DOWNLOAD_STAGING_FILE_MISSING"
  | "DOWNLOAD_STAGING_EMPTY"
  | "DOWNLOAD_STAGING_READ_FAILED"
  | "DOWNLOAD_FAILURE_UNKNOWN"
  | "ARTIFACT_TOO_LARGE"
  | "AMBIGUOUS_DOWNLOAD_CONTROLS";

export type DownloadAvailability =
  | "DOWNLOAD_EVIDENCE_ONLY"
  | "DOWNLOAD_CONTROL_ACTIONABLE"
  | "DOWNLOAD_BYTES_OBSERVED";

export interface ArtifactChannelEvidence {
  channel: "DOWNLOAD" | "NETWORK_RESPONSE" | "POPUP" | "NAVIGATION" | "DYNAMIC_REFERENCE" | "BLOB";
  phase: "GENERATION" | "DISCOVERY" | "AFTER_EXPANSION" | "AFTER_DOWNLOAD_CLICK";
  correlatedToAssistantTurn: boolean;
  correlatedToAcquisition: boolean;
  producedBytes: boolean;
}

export interface ProviderArtifactAcquisition {
  acquisitionId: string;
  providerId: string;
  projectId: string;
  providerTurnId: string;
  controlFingerprint: string;
  physicalClickCount: 0 | 1;
  expansionCount?: 0 | 1;
  channelEvidence?: ArtifactChannelEvidence[];
  state: "TURN_BOUND" | "OPTIONAL_EXPANSION" | "CONTROL_ACTIONABLE" | "LISTENERS_ARMED" | "DOWNLOAD_CLICK_COMMITTED" | "CAPTURE_WAITING" | "VALIDATING" | "READY" | "FAILED";
}

export type ArtifactDownloadState =
  | "DOWNLOAD_CONTROL_READY"
  | "DOWNLOAD_TRIGGERED"
  | "CAPTURE_WAITING"
  | "ARTIFACT_VALIDATING"
  | "ARTIFACT_STORED"
  | "DOWNLOAD_TRIGGER_NO_BYTES";

export interface ProviderArtifactCandidate {
  providerId: "chatgpt" | "gemini";
  source: "DOWNLOAD_CONTROL" | "ANCHOR" | "INLINE_IMAGE" | "BLOB" | "NETWORK_RESPONSE";
  rawReferenceKind: "ABSOLUTE_HTTPS" | "RELATIVE_URL" | "BLOB_URL" | "NONE";
  elementEvidence: {
    tagName: string;
    role?: string;
    ariaLabel?: string;
    downloadName?: string;
    providerMessageId?: string;
  };
  expectedFileName?: string;
  expectedMimeType?: string;
  /** Main-process only. Never include this field in renderer DTOs or diagnostics. */
  rawReference?: string;
}

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
  downloadCompletionTimeoutMs?: number;
  expectArtifact?: boolean;
  onStateChange?: (state: ArtifactDownloadState) => void;
  onChannelEvidence?: (evidence: ArtifactChannelEvidence) => void;
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
const PROVIDER_ORIGINS: Readonly<Record<string, string>> = {
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com",
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

function decodeHtmlEntities(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

export function normalizeProviderArtifactReference(
  providerId: string,
  rawReference: string,
): { kind: ProviderArtifactCandidate["rawReferenceKind"]; url: string } {
  const trustedOrigin = PROVIDER_ORIGINS[providerId];
  if (!trustedOrigin) throw new ArtifactDownloadFailure("UNTRUSTED_PROVIDER_ORIGIN", "Provider origin is not configured");
  const cleaned = decodeHtmlEntities(rawReference.trim());
  if (!cleaned) return { kind: "NONE", url: "" };
  if (cleaned.startsWith("blob:")) {
    let embedded: URL;
    try { embedded = new URL(cleaned.slice(5)); } catch { throw new ArtifactDownloadFailure("MALFORMED_PROVIDER_URL", "Provider blob URL is malformed"); }
    if (embedded.origin !== trustedOrigin) throw new ArtifactDownloadFailure("UNTRUSTED_PROVIDER_ORIGIN", "Blob URL does not belong to the provider page");
    embedded.hash = "";
    return { kind: "BLOB_URL", url: `blob:${embedded.toString()}` };
  }
  let parsed: URL;
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(cleaned);
  try { parsed = new URL(cleaned, trustedOrigin); } catch {
    throw new ArtifactDownloadFailure(relative ? "RELATIVE_URL_RESOLUTION_FAILED" : "MALFORMED_PROVIDER_URL", "Provider URL cannot be parsed");
  }
  if (parsed.protocol !== "https:") throw new ArtifactDownloadFailure("MALFORMED_PROVIDER_URL", "Provider artifact URL must use HTTPS");
  parsed.hash = "";
  return { kind: relative ? "RELATIVE_URL" : "ABSOLUTE_HTTPS", url: parsed.toString() };
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
  if (/HTTP (?:401|403|404|410)|expired|ист[её]к/i.test(message)) return "SIGNED_URL_EXPIRED";
  if (/redirect/i.test(message) && /blocked|allowlist|private|local|unsafe/i.test(message)) return "REDIRECT_TARGET_REJECTED";
  if (/blob/i.test(message)) return "BLOB_EXTRACTION_FAILED";
  if (/no validated bytes|capture window expired|All promises were rejected/i.test(message)) return "DOWNLOAD_TRIGGER_NO_BYTES";
  if (/MIME|Content-Type/i.test(message)) return "MIME_VALIDATION_FAILED";
  if (/SHA-256|integrity/i.test(message)) return "INTEGRITY_VALIDATION_FAILED";
  if (/empty|0 bytes/i.test(message)) return "EMPTY_RESPONSE_BODY";
  return fallback;
}

export class ResponseArtifactDownloader {
  private readonly store: LocalArtifactStore;
  private readonly resolveHostname: HostnameResolver;
  private static readonly activeAcquisitions = new Map<string, Promise<DownloadedArtifactRecord[]>>();

  constructor(
    private readonly db: DatabaseSync,
    customStore?: LocalArtifactStore,
    options: { resolveHostname?: HostnameResolver } = {},
  ) {
    this.store = customStore || new LocalArtifactStore();
    this.resolveHostname = options.resolveHostname ?? systemResolver;
  }

  /** Scans only the bound assistant turn. Raw references remain in the main process. */
  public async discoverTurnArtifactCandidates(
    page: Page,
    turnSelector: string,
    providerId: "chatgpt" | "gemini",
  ): Promise<ProviderArtifactCandidate[]> {
    try {
      const turnLocator = page.locator(turnSelector).last();
      if ((await turnLocator.count().catch(() => 0)) === 0) return [];
      return await turnLocator.evaluate((el, boundProviderId) => {
        const results: ProviderArtifactCandidate[] = [];
        // A plain image is presentation content, not proof of a downloadable
        // artifact. Provider file cards commonly contain decorative HTTPS
        // icons; treating every <img> as a file persisted those icons as user
        // results. Generated images remain supported when the provider exposes
        // an explicit download link/control around them.
        el.querySelectorAll("a[href], a[download]").forEach((anchor) => {
          const href = anchor.getAttribute("href");
          const accessibleName = [
            anchor.getAttribute("aria-label"),
            anchor.getAttribute("title"),
            anchor.getAttribute("data-testid"),
          ].filter(Boolean).join(" ");
          const explicitlyDownloadable = anchor.hasAttribute("download") || /download|file|attachment|скач|файл/i.test(accessibleName);
          if (href && explicitlyDownloadable) {
            results.push({
              providerId: boundProviderId,
              source: href.startsWith("blob:") ? "BLOB" : "ANCHOR",
              rawReferenceKind: href.startsWith("blob:") ? "BLOB_URL" : href.startsWith("https://") ? "ABSOLUTE_HTTPS" : "RELATIVE_URL",
              rawReference: href,
              elementEvidence: {
                tagName: anchor.tagName.toLowerCase(),
                ...(anchor.getAttribute("role") ? { role: anchor.getAttribute("role")! } : {}),
                ...(anchor.getAttribute("aria-label") ? { ariaLabel: anchor.getAttribute("aria-label")! } : {}),
                ...(anchor.getAttribute("download") ? { downloadName: anchor.getAttribute("download")! } : {}),
                ...((el.getAttribute("data-message-id") || el.getAttribute("data-test-id")) ? { providerMessageId: (el.getAttribute("data-message-id") || el.getAttribute("data-test-id"))! } : {}),
              },
              ...((anchor.getAttribute("download") || anchor.textContent?.trim()) ? { expectedFileName: (anchor.getAttribute("download") || anchor.textContent?.trim())! } : {}),
            });
          }
        });
        return results;
      }, providerId);
    } catch {
      return [];
    }
  }

  /** Compatibility projection for non-renderer callers; never expose its URL outside main. */
  public async extractTurnArtifactsFromPage(page: Page, turnSelector: string, providerId: "chatgpt" | "gemini" = "chatgpt") {
    const candidates = await this.discoverTurnArtifactCandidates(page, turnSelector, providerId);
    return candidates.filter((candidate) => candidate.rawReference).map((candidate) => ({
      label: candidate.expectedFileName || "Downloadable File",
      url: candidate.rawReference!,
      isImage: candidate.source === "INLINE_IMAGE",
    }));
  }

  /** Arms a passive, turn-scoped strategy before generation starts. It never clicks UI. */
  public armNetworkFirstCapture(
    page: Page,
    options: Omit<ArtifactDownloadOptions, "url" | "label">,
  ): { finish: () => Promise<DownloadedArtifactRecord | null>; evidence: ArtifactChannelEvidence[] } {
    const candidates: any[] = [];
    const evidence: ArtifactChannelEvidence[] = [];
    let stopped = false;
    const onResponse = (response: any) => {
      if (stopped || !response.ok?.()) return;
      const headers = response.headers?.() || {};
      const mime = contentTypeWithoutParameters(headers["content-type"]);
      const disposition = String(headers["content-disposition"] || "");
      let parsed: URL;
      try { parsed = new URL(String(response.url?.() || "")); } catch { return; }
      if (mime === "text/html" || mime.includes("json") || /telemetry|analytics|avatar|icon|preview|thumbnail/i.test(parsed.pathname)) return;
      const strongDisposition = /attachment/i.test(disposition);
      const strongPath = /download|file|artifact|usercontent|generated/i.test(`${parsed.hostname}${parsed.pathname}`);
      const allowedMime = DEFAULT_ALLOWED_MIME_TYPES.has(mime) || mime === "application/octet-stream";
      if (!allowedMime || (!strongDisposition && !strongPath)) {
        evidence.push({ channel: "NETWORK_RESPONSE", phase: "GENERATION", correlatedToAssistantTurn: true, correlatedToAcquisition: false, producedBytes: false });
        return;
      }
      candidates.push(response);
    };
    (page as any).on?.("response", onResponse);
    return {
      evidence,
      finish: async () => {
        if (stopped) return null;
        stopped = true;
        (page as any).off?.("response", onResponse);
        const unique = [...new Map(candidates.map((candidate) => [String(candidate.url()), candidate])).values()];
        if (unique.length !== 1) {
          if (unique.length > 1) evidence.push({ channel: "NETWORK_RESPONSE", phase: "GENERATION", correlatedToAssistantTurn: true, correlatedToAcquisition: false, producedBytes: false });
          return null;
        }
        try {
          const record = await this.persistNetworkResponse(unique[0], options, this.allowedDomains(options.providerId, options.allowedDomainSuffixes));
          evidence.push({ channel: "NETWORK_RESPONSE", phase: "GENERATION", correlatedToAssistantTurn: true, correlatedToAcquisition: true, producedBytes: record.status === "READY" && record.sizeBytes > 0 });
          return record.status === "READY" ? record : null;
        } catch {
          evidence.push({ channel: "NETWORK_RESPONSE", phase: "GENERATION", correlatedToAssistantTurn: true, correlatedToAcquisition: false, producedBytes: false });
          return null;
        }
      },
    };
  }

  /** Downloads only candidates found inside the response bound to this turn. */
  public async downloadTurnArtifactsFromPage(
    page: Page,
    turnSelector: string,
    options: Omit<ArtifactDownloadOptions, "url" | "label">,
  ): Promise<DownloadedArtifactRecord[]> {
    const key = `${options.providerId}:${options.projectId}:${options.messageId}`;
    const persisted = this.db.prepare(`SELECT * FROM downloaded_artifacts
      WHERE provider_id=? AND project_id=? AND message_id=? ORDER BY downloaded_at, rowid`).all(
      options.providerId, options.projectId, options.messageId,
    ) as Array<Record<string, unknown>>;
    if (persisted.length > 0) return persisted.map((row) => this.recordFromRow(row));
    const active = ResponseArtifactDownloader.activeAcquisitions.get(key);
    if (active) return active;
    const acquisition = this.acquireTurnArtifactOnce(page, turnSelector, options);
    ResponseArtifactDownloader.activeAcquisitions.set(key, acquisition);
    try { return await acquisition; }
    finally { ResponseArtifactDownloader.activeAcquisitions.delete(key); }
  }

  public async reacquireTurnArtifactFromPage(
    page: Page,
    turnSelector: string,
    options: Omit<ArtifactDownloadOptions, "url" | "label">,
    retryOfAcquisitionId: string,
  ): Promise<{ acquisition: ProviderArtifactAcquisition; retryOfAcquisitionId: string; records: DownloadedArtifactRecord[] }> {
    const previous = this.db.prepare(`SELECT id FROM downloaded_artifacts
      WHERE id=? AND provider_id=? AND project_id=? AND message_id=? AND status='FAILED'`).get(
      retryOfAcquisitionId, options.providerId, options.projectId, options.messageId,
    );
    if (!previous) throw new Error("Explicit reacquisition target is not a FAILED artifact from this provider turn");
    const key = `explicit-retry:${options.providerId}:${options.projectId}:${options.messageId}`;
    if (ResponseArtifactDownloader.activeAcquisitions.has(key)) throw new Error("An explicit artifact reacquisition is already active");
    const acquisition: ProviderArtifactAcquisition = {
      acquisitionId: `acq_${crypto.randomUUID()}`, providerId: options.providerId,
      projectId: options.projectId, providerTurnId: options.messageId,
      controlFingerprint: "", physicalClickCount: 0, expansionCount: 0, channelEvidence: [], state: "TURN_BOUND",
    };
    const pending = this.acquireTurnArtifactOnce(page, turnSelector, options, acquisition);
    ResponseArtifactDownloader.activeAcquisitions.set(key, pending);
    try {
      const records = await pending;
      for (const record of records) {
        this.db.prepare(`UPDATE downloaded_artifacts SET acquisition_id=?, retry_of_acquisition_id=?, physical_click_count=? WHERE id=?`)
          .run(acquisition.acquisitionId, retryOfAcquisitionId, acquisition.physicalClickCount, record.id);
        record.acquisitionId = acquisition.acquisitionId;
        record.retryOfAcquisitionId = retryOfAcquisitionId;
        record.physicalClickCount = acquisition.physicalClickCount;
      }
      return { acquisition, retryOfAcquisitionId, records };
    } finally { ResponseArtifactDownloader.activeAcquisitions.delete(key); }
  }

  private async acquireTurnArtifactOnce(
    page: Page,
    turnSelector: string,
    options: Omit<ArtifactDownloadOptions, "url" | "label">,
    transaction?: ProviderArtifactAcquisition,
  ): Promise<DownloadedArtifactRecord[]> {
    const acquisition: ProviderArtifactAcquisition = transaction ?? {
      acquisitionId: `acq_${crypto.randomUUID()}`,
      providerId: options.providerId,
      projectId: options.projectId,
      providerTurnId: options.messageId,
      controlFingerprint: "",
      physicalClickCount: 0, expansionCount: 0, channelEvidence: [],
      state: "TURN_BOUND",
    };
    const turn = page.locator(turnSelector).last();
    const controlSelector = [
      "a[download]", 'button[aria-label*="download" i]', 'button[aria-label*="скач" i]', 'button[aria-label*="Скач"]',
      'a[aria-label*="download" i]', 'a[aria-label*="скач" i]',
      'button[title*="download" i]', 'button[title*="скач" i]',
      '[role="button"][data-tooltip*="download" i]', '[role="button"][data-tooltip*="скач" i]',
      '[data-test-id*="download" i]', '[data-testid*="download" i]',
    ].join(", ");
    const artifactRegions = turn.locator('pre, .code-block, [data-test-id*="artifact" i], [data-testid*="artifact" i], [class*="artifact" i]') as any;
    const artifactRegion = typeof artifactRegions.last === "function" ? artifactRegions.last() : artifactRegions;
    if (typeof artifactRegion.hover === "function" && await artifactRegion.count().catch(() => 0)) await artifactRegion.hover().catch(() => undefined);
    let controls = turn.locator(controlSelector);
    if ((await controls.count().catch(() => 0)) === 0 && options.providerId === "gemini") {
      const menuControls = turn.locator('button[aria-haspopup="menu"][aria-label*="file" i], button[aria-haspopup="menu"][aria-label*="artifact" i], button[aria-haspopup="menu"][aria-label*="скач" i], button[aria-haspopup="menu"][title*="download" i]');
      const visibleMenus: Locator[] = [];
      for (let index = 0; index < Math.min(await menuControls.count().catch(() => 0), 10); index += 1) {
        const candidate = menuControls.nth(index);
        if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) visibleMenus.push(candidate);
      }
      if (visibleMenus.length === 1) {
        acquisition.state = "OPTIONAL_EXPANSION";
        acquisition.expansionCount = 1;
        await visibleMenus[0]!.click();
        controls = turn.locator(controlSelector);
      } else if (visibleMenus.length > 1) {
        acquisition.state = "FAILED";
        return [this.persistFailure({ ...options, url: "", label: "" }, "AMBIGUOUS_DOWNLOAD_CONTROLS", new Error("Multiple artifact menus inside bound assistant turn"))];
      }
    }
    const byFingerprint = new Map<string, Locator>();
    const count = Math.min(await controls.count().catch(() => 0), 20);
    let hiddenCount = 0;
    let zeroBoundsCount = 0;
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (typeof (control as any).isVisible === "function" && !(await (control as any).isVisible().catch(() => false))) { hiddenCount += 1; continue; }
      if (typeof (control as any).isEnabled === "function" && !(await (control as any).isEnabled().catch(() => false))) continue;
      if (typeof (control as any).boundingBox === "function") {
        const bounds = await (control as any).boundingBox().catch(() => null);
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) { zeroBoundsCount += 1; continue; }
      }
      const fingerprint = await this.controlFingerprint(control, index);
      if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, control);
    }
    if (byFingerprint.size > 1) {
      acquisition.state = "FAILED";
      return [this.persistFailure(
        { ...options, url: "", label: "" }, "AMBIGUOUS_DOWNLOAD_CONTROLS",
        new Error(`Multiple distinct download controls inside provider turn: ${byFingerprint.size}`),
      )];
    }
    const selected = byFingerprint.values().next().value as Locator | undefined;
    if (selected) {
      acquisition.controlFingerprint = byFingerprint.keys().next().value || "";
      acquisition.state = "CONTROL_ACTIONABLE";
      acquisition.state = "LISTENERS_ARMED";
      const guardedControl = new Proxy(selected as any, {
        get(target, property) {
          if (property === "click") return async () => {
            if (acquisition.physicalClickCount !== 0 || acquisition.state !== "LISTENERS_ARMED") {
              throw new Error("Artifact acquisition physical click already committed");
            }
            acquisition.physicalClickCount = 1;
            acquisition.state = "DOWNLOAD_CLICK_COMMITTED";
            return target.click();
          };
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Locator;
      const captureOptions = {
        ...options,
        onStateChange: (state: ArtifactDownloadState) => {
          if (state === "CAPTURE_WAITING") acquisition.state = "CAPTURE_WAITING";
          else if (state === "ARTIFACT_VALIDATING") acquisition.state = "VALIDATING";
          else if (state === "ARTIFACT_STORED") acquisition.state = "READY";
          else if (state === "DOWNLOAD_TRIGGER_NO_BYTES") acquisition.state = "FAILED";
          options.onStateChange?.(state);
        },
        onChannelEvidence: (evidence: ArtifactChannelEvidence) => {
          acquisition.channelEvidence?.push(evidence);
          options.onChannelEvidence?.(evidence);
        },
      };
      try { return [await this.captureDownloadFromLocator(page, guardedControl, captureOptions)]; }
      catch (error) {
        acquisition.state = "FAILED";
        return [this.persistFailure(
          { ...options, url: "", label: await selected.textContent().catch(() => null) || "" },
          failureReason(error, "AUTHENTICATED_FETCH_FAILED"), error,
        )];
      }
    }

    // A bound explicit URL needs no physical click. Process at most one
    // deterministic reference; ambiguous references fail closed.
    const providerId = options.providerId as "chatgpt" | "gemini";
    const candidates = await this.discoverTurnArtifactCandidates(page, turnSelector, providerId);
    const referenced = [...new Map(candidates.filter((item) => item.rawReference).map((item) => [item.rawReference, item])).values()];
    if (referenced.length > 1) {
      acquisition.state = "FAILED";
      return [this.persistFailure({ ...options, url: "", label: "" }, "AMBIGUOUS_DOWNLOAD_CONTROLS", new Error("Multiple distinct artifact references inside provider turn"))];
    }
    const candidate = referenced[0];
    if (candidate?.rawReference) {
      try {
        acquisition.state = "VALIDATING";
        const normalized = normalizeProviderArtifactReference(options.providerId, candidate.rawReference);
        const candidateOptions = { ...options, url: normalized.url, ...(candidate.expectedFileName ? { label: candidate.expectedFileName } : {}) };
        const record = normalized.kind === "BLOB_URL" ? await this.downloadBlobFromPage(page, candidateOptions) : await this.downloadArtifactSsrfSafe(page, candidateOptions);
        acquisition.state = record.status === "READY" ? "READY" : "FAILED";
        return [record];
      } catch (error) {
        acquisition.state = "FAILED";
        return [this.persistFailure({ ...options, url: "", label: candidate.expectedFileName || "" }, failureReason(error, "MALFORMED_PROVIDER_URL"), error)];
      }
    }
    acquisition.state = "FAILED";
    const codeBlock = await turn.locator("pre, code, .code-block").count().catch(() => 0);
    const missingReason: ArtifactFailureReason = zeroBoundsCount > 0 ? "DOWNLOAD_CONTROL_ZERO_BOUNDS"
      : hiddenCount > 0 ? "DOWNLOAD_CONTROL_HIDDEN"
        : codeBlock > 0 ? "ARTIFACT_RENDERED_AS_CODE_BLOCK" : "DOWNLOAD_EVIDENCE_NOT_ACTIONABLE";
    return options.expectArtifact ? [this.persistFailure(
      { ...options, url: "", label: "" }, missingReason,
      new Error(`Provider response did not expose an actionable download control; candidates=${count}; hidden=${hiddenCount}; zeroBounds=${zeroBoundsCount}`),
    )] : [];
  }

  private async controlFingerprint(control: Locator, index: number): Promise<string> {
    if (typeof (control as any).evaluate === "function") {
      const evaluated = await (control as any).evaluate((element: Element) => {
        const segments: string[] = [];
        let current: Element | null = element;
        while (current && segments.length < 6) {
          const parent: Element | null = current.parentElement;
          const siblingIndex = parent ? Array.from(parent.children).indexOf(current) : 0;
          segments.unshift(`${current.tagName.toLowerCase()}:${siblingIndex}`);
          current = parent;
        }
        return [element.tagName.toLowerCase(), element.getAttribute("role") || "", element.getAttribute("aria-label") || "", element.getAttribute("download") || "", segments.join("/")].join("|");
      }).catch(() => null);
      if (typeof evaluated === "string") return evaluated;
    }
    const attr = async (name: string) => typeof (control as any).getAttribute === "function"
      ? await (control as any).getAttribute(name).catch(() => null) : null;
    const [role, aria, download, href] = await Promise.all([attr("role"), attr("aria-label"), attr("download"), attr("href")]);
    const semantic = [role, aria, download, href].map((value) => value || "").join("|");
    return semantic.replace(/\|/g, "") ? `semantic:${semantic}` : `locator:${index}`;
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
    const timeout = Math.min(Math.max(options.downloadEventTimeoutMs ?? 8_000, 250), 20_000);
    const domains = this.allowedDomains(options.providerId, options.allowedDomainSuffixes);
    const emitState = (state: ArtifactDownloadState) => options.onStateChange?.(state);
    if (typeof (trigger as any).isVisible === "function" && !(await (trigger as any).isVisible())) throw new Error("Download control is not visible");
    if (typeof (trigger as any).isEnabled === "function" && !(await (trigger as any).isEnabled())) throw new Error("Download control is disabled or loading");
    emitState("DOWNLOAD_CONTROL_READY");

    type CaptureCandidate = { kind: "download" | "response" | "popup" | "navigation" | "reference"; value: any };
    const queue: CaptureCandidate[] = [];
    const channelAttempts: string[] = [];
    let wake: (() => void) | null = null;
    let triggered = false;
    let stopped = false;
    const enqueue = (candidate: CaptureCandidate) => {
      if (!triggered || stopped) return;
      const channel = candidate.kind === "download" ? "DOWNLOAD" : candidate.kind === "response" ? "NETWORK_RESPONSE"
        : candidate.kind === "popup" ? "POPUP" : candidate.kind === "navigation" ? "NAVIGATION" : "DYNAMIC_REFERENCE";
      options.onChannelEvidence?.({ channel, phase: "AFTER_DOWNLOAD_CLICK", correlatedToAssistantTurn: true, correlatedToAcquisition: true, producedBytes: false });
      queue.push(candidate);
      wake?.();
      wake = null;
    };
    const baselineUrl = typeof (page as any).url === "function" ? page.url() : PROVIDER_ORIGINS[options.providerId] || "";
    const baselineAttributes = await (typeof (trigger as any).evaluate === "function" ? trigger.evaluate((element) => ({
      href: element.getAttribute("href"), src: element.getAttribute("src"), download: element.getAttribute("download"),
    })) : Promise.resolve({ href: null, src: null, download: null })).catch(() => ({ href: null, src: null, download: null }));
    const pageAny = page as any;
    const contextAny = typeof pageAny.context === "function" ? pageAny.context() : {};
    const onDownload = (value: any) => enqueue({ kind: "download", value });
    const onResponse = (value: any) => {
      const headers = value.headers();
      const mime = contentTypeWithoutParameters(headers["content-type"]);
      const disposition = headers["content-disposition"] || "";
      if (!value.ok() || mime === "text/html" || mime.includes("json")) return;
      let parsed: URL;
      try { parsed = new URL(value.url()); } catch { return; }
      const pathEvidence = /download|file|artifact|usercontent|backend-api\/files/i.test(`${parsed.hostname}${parsed.pathname}`);
      const attachmentEvidence = /attachment/i.test(disposition);
      const mimeEvidence = DEFAULT_ALLOWED_MIME_TYPES.has(mime) || mime === "application/octet-stream";
      if ((!attachmentEvidence && !pathEvidence) || !mimeEvidence) return;
      if (/avatar|icon|emoji|analytics|telemetry|thumbnail/i.test(parsed.pathname)) return;
      enqueue({ kind: "response", value });
    };
    const onPopup = (value: any) => enqueue({ kind: "popup", value });
    const onFrameNavigated = (frame: any) => {
      if (typeof pageAny.mainFrame === "function" && frame !== pageAny.mainFrame()) return;
      if (frame.url() !== baselineUrl) enqueue({ kind: "navigation", value: frame.url() });
    };
    pageAny.on?.("download", onDownload);
    pageAny.on?.("response", onResponse);
    pageAny.on?.("popup", onPopup);
    pageAny.on?.("framenavigated", onFrameNavigated);
    contextAny.on?.("page", onPopup);
    const armLegacyWaiters = () => {
      if (typeof pageAny.on === "function") return;
      void pageAny.waitForEvent?.("download", { timeout }).then(onDownload).catch(() => undefined);
      void pageAny.waitForResponse?.((response: any) => {
        const before = queue.length;
        onResponse(response);
        const accepted = queue.length > before;
        if (accepted) queue.pop();
        return accepted;
      }, { timeout }).then(onResponse).catch(() => undefined);
    };
    const poll = setInterval(() => {
      if (typeof (trigger as any).evaluate !== "function") return;
      void trigger.evaluate((element) => ({ href: element.getAttribute("href"), src: element.getAttribute("src"), download: element.getAttribute("download") }))
        .then((current) => {
          const reference = current.href || current.src;
          if (reference && (reference !== baselineAttributes.href || current.download !== baselineAttributes.download) && reference !== baselineAttributes.src) enqueue({ kind: "reference", value: reference });
        }).catch(() => undefined);
    }, 75);
    const deadline = Date.now() + timeout;
    const cleanup = () => {
      stopped = true;
      clearInterval(poll);
      pageAny.off?.("download", onDownload);
      pageAny.off?.("response", onResponse);
      pageAny.off?.("popup", onPopup);
      pageAny.off?.("framenavigated", onFrameNavigated);
      contextAny.off?.("page", onPopup);
      wake?.();
      wake = null;
    };
    try {
      triggered = true;
      armLegacyWaiters();
      await trigger.click();
      emitState("DOWNLOAD_TRIGGERED");
      emitState("CAPTURE_WAITING");
      while (Date.now() < deadline) {
        if (queue.length === 0) await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())));
        });
        const candidate = queue.shift();
        if (!candidate) continue;
        try {
          emitState("ARTIFACT_VALIDATING");
          let record: DownloadedArtifactRecord;
          if (candidate.kind === "download") {
            record = await this.persistBrowserDownload(candidate.value, options, domains);
          } else if (candidate.kind === "response") {
            record = await this.persistNetworkResponse(candidate.value, options, domains);
          } else if (candidate.kind === "popup") {
            const popup = candidate.value;
            try {
              await popup.waitForLoadState?.("domcontentloaded", { timeout: Math.max(250, deadline - Date.now()) }).catch(() => undefined);
              const normalized = normalizeProviderArtifactReference(options.providerId, popup.url());
              if (normalized.kind === "BLOB_URL") record = await this.downloadBlobFromPage(popup, { ...options, url: normalized.url });
              else record = await this.downloadArtifactSsrfSafe(page, { ...options, url: normalized.url });
            } finally { await popup.close?.().catch(() => undefined); }
          } else {
            const normalized = normalizeProviderArtifactReference(options.providerId, String(candidate.value));
            if (normalized.kind === "BLOB_URL") record = await this.downloadBlobFromPage(page, { ...options, url: normalized.url });
            else record = await this.downloadArtifactSsrfSafe(page, { ...options, url: normalized.url });
          }
          if (record.status === "READY") {
            const last = options.onChannelEvidence ? { channel: candidate.kind === "download" ? "DOWNLOAD" : candidate.kind === "response" ? "NETWORK_RESPONSE" : candidate.kind === "popup" ? "POPUP" : candidate.kind === "navigation" ? "NAVIGATION" : "DYNAMIC_REFERENCE", phase: "AFTER_DOWNLOAD_CLICK", correlatedToAssistantTurn: true, correlatedToAcquisition: true, producedBytes: true } as ArtifactChannelEvidence : null;
            if (last) options.onChannelEvidence?.(last);
            emitState("ARTIFACT_STORED");
            return record;
          }
        } catch (error) {
          // A correlated candidate still has to pass the common validation.
          const reason = error instanceof ArtifactDownloadFailure ? error.reason
            : candidate.kind === "download" ? "DOWNLOAD_EVENT_NO_BYTES"
            : candidate.kind === "response" ? "NETWORK_RESPONSE_REJECTED"
              : candidate.kind === "popup" ? "POPUP_NO_VALID_ARTIFACT"
                : candidate.kind === "navigation" ? "NAVIGATION_NO_VALID_ARTIFACT"
                  : "DYNAMIC_REFERENCE_REJECTED";
          if (!channelAttempts.includes(reason)) channelAttempts.push(reason);
        }
      }
      emitState("DOWNLOAD_TRIGGER_NO_BYTES");
      throw new ArtifactDownloadFailure(
        "DOWNLOAD_TRIGGER_NO_BYTES",
        `Download capture window expired with no validated bytes; channelAttempts=${JSON.stringify(channelAttempts)}`,
      );
    } finally {
      cleanup();
      if (typeof pageAny.url === "function" && page.url() !== baselineUrl && baselineUrl.startsWith(PROVIDER_ORIGINS[options.providerId] || "#")) {
        await page.goto(baselineUrl, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => undefined);
      }
    }
  }

  private async persistBrowserDownload(download: any, options: Omit<ArtifactDownloadOptions, "url" | "label">, domains: readonly string[]): Promise<DownloadedArtifactRecord> {
    const url = String(download.url?.() || "");
    if (url.startsWith("blob:")) await validateDownloadUrl(url.slice(5), { allowedDomainSuffixes: domains, resolveHostname: this.resolveHostname });
    else if (url) await validateDownloadUrl(url, { allowedDomainSuffixes: domains, resolveHostname: this.resolveHostname });
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    const completionTimeoutMs = Math.min(Math.max(options.downloadCompletionTimeoutMs ?? 30_000, 1_000), 120_000);
    const stagingDir = path.join(this.store.getBaseDir(), "_staging");
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagingPath = path.join(stagingDir, `${crypto.randomUUID()}.part`);
    let timedOut = false;
    let tooLarge = false;
    const monitor = setInterval(() => {
      try {
        if (fs.statSync(stagingPath).size > maxBytes) {
          tooLarge = true;
          void download.cancel?.().catch(() => undefined);
        }
      } catch { /* File may not exist until the browser starts copying. */ }
    }, 100);
    const withTimeout = async <T>(operation: Promise<T>): Promise<T> => await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        void download.cancel?.().catch(() => undefined);
        reject(new ArtifactDownloadFailure("DOWNLOAD_COMPLETION_TIMEOUT", "Browser download completion timed out"));
      }, completionTimeoutMs);
      operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
    const classifyDownloadFailure = (failure: string): ArtifactFailureReason => /cancel/i.test(failure) ? "DOWNLOAD_BROWSER_CANCELED"
      : /context.*clos|browser.*clos/i.test(failure) ? "DOWNLOAD_CONTEXT_CLOSED"
        : /page.*clos|target.*clos/i.test(failure) ? "DOWNLOAD_PAGE_CLOSED" : "DOWNLOAD_FAILURE_UNKNOWN";
    try {
      if (typeof download.saveAs === "function") {
        let saveError: unknown;
        try { await withTimeout(download.saveAs(stagingPath)); }
        catch (error) { saveError = error; }
        if (tooLarge) throw new ArtifactDownloadFailure("ARTIFACT_TOO_LARGE", `Browser download exceeded ${maxBytes} bytes`);
        if (timedOut) throw new ArtifactDownloadFailure("DOWNLOAD_COMPLETION_TIMEOUT", "Browser download completion timed out");
        const failure = typeof download.failure === "function" ? await withTimeout(download.failure()) : null;
        if (failure) throw new ArtifactDownloadFailure(classifyDownloadFailure(String(failure)), `Browser download failed: ${String(failure).slice(0, 200)}`);
        if (saveError) {
          if (typeof download.path !== "function") throw new ArtifactDownloadFailure("DOWNLOAD_SAVE_AS_FAILED", "Browser download saveAs failed and path fallback is unavailable");
          const browserPath = await withTimeout<unknown>(download.path()).catch(() => null);
          if (typeof browserPath !== "string" || !browserPath) throw new ArtifactDownloadFailure("DOWNLOAD_PATH_UNAVAILABLE", "Completed browser download path is unavailable");
          try { fs.copyFileSync(browserPath, stagingPath); }
          catch { throw new ArtifactDownloadFailure("DOWNLOAD_SAVE_AS_FAILED", "Completed browser download could not be copied to staging"); }
        }
      } else {
        // Compatibility for synthetic test doubles. Real Playwright Download always exposes saveAs/failure.
        const stream = await download.createReadStream?.();
        if (!stream) throw new ArtifactDownloadFailure("DOWNLOAD_SAVE_AS_FAILED", "Browser download does not expose saveAs or a readable completed stream");
        const output = fs.createWriteStream(stagingPath, { flags: "wx" });
        let total = 0;
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > maxBytes) { stream.destroy(); throw new ArtifactDownloadFailure("ARTIFACT_TOO_LARGE", `Browser download exceeded ${maxBytes} bytes`); }
          if (!output.write(buffer)) await new Promise<void>((resolve) => output.once("drain", resolve));
        }
        await new Promise<void>((resolve, reject) => {
          output.once("error", reject);
          output.end(() => resolve());
        });
      }
      if (!fs.existsSync(stagingPath)) throw new ArtifactDownloadFailure("DOWNLOAD_STAGING_FILE_MISSING", "Browser download staging file is missing");
      const stat = fs.statSync(stagingPath);
      if (!stat.isFile()) throw new ArtifactDownloadFailure("DOWNLOAD_STAGING_FILE_MISSING", "Browser download staging target is not a regular file");
      if (stat.size === 0) throw new ArtifactDownloadFailure("DOWNLOAD_STAGING_EMPTY", "Browser download staging file is empty");
      if (stat.size > maxBytes) { await download.cancel?.().catch(() => undefined); throw new ArtifactDownloadFailure("ARTIFACT_TOO_LARGE", `Browser download exceeded ${maxBytes} bytes`); }
      let buffer: Buffer;
      try { buffer = fs.readFileSync(stagingPath); }
      catch { throw new ArtifactDownloadFailure("DOWNLOAD_STAGING_READ_FAILED", "Browser download staging file could not be read"); }
      return this.persistBuffer(buffer, { ...options, url, label: download.suggestedFilename() }, "");
    } finally {
      clearInterval(monitor);
      fs.rmSync(stagingPath, { force: true });
    }
  }

  private async persistNetworkResponse(response: any, options: Omit<ArtifactDownloadOptions, "url" | "label">, domains: readonly string[]): Promise<DownloadedArtifactRecord> {
    const url = String(response.url());
    const parsed = await validateDownloadUrl(url, { allowedDomainSuffixes: domains, resolveHostname: this.resolveHostname });
    const headers = response.headers();
    const declaredMime = contentTypeWithoutParameters(headers["content-type"]);
    const contentLength = Number(headers["content-length"] || "0");
    if (Number.isFinite(contentLength) && contentLength > (options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES)) throw new Error("Downloaded artifact exceeds size limit");
    const discoveredName = filenameFromHeadersOrUrl(headers, parsed);
    const extension = declaredMime === "image/jpeg" ? ".jpg" : declaredMime === "image/webp" ? ".webp" : ".png";
    const fileName = declaredMime.startsWith("image/") && !/\.(?:png|jpe?g|webp)$/i.test(discoveredName)
      ? `generated-image${extension}` : discoveredName;
    return this.persistBuffer(await response.body(), { ...options, url, label: fileName }, declaredMime);
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
            throw new ArtifactDownloadFailure("SIGNED_URL_EXPIRED", `Artifact request failed with HTTP ${status}`);
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

  private recordFromRow(row: Record<string, unknown>): DownloadedArtifactRecord {
    const failureReasonValue = row.failure_reason ? String(row.failure_reason) as ArtifactFailureReason : undefined;
    const failureDetail = row.failure_detail ? String(row.failure_detail) : undefined;
    return {
      id: String(row.id), messageId: String(row.message_id), projectId: String(row.project_id),
      providerId: String(row.provider_id), originalUrl: String(row.original_url || ""),
      sha256: String(row.sha256 || ""), localRelativePath: String(row.local_relative_path || ""),
      fileName: String(row.file_name || ""), mimeType: String(row.mime_type || "application/octet-stream"),
      sizeBytes: Number(row.size_bytes || 0), status: String(row.status) as DownloadedArtifactRecord["status"],
      downloadedAt: String(row.downloaded_at),
      ...(failureReasonValue ? { failureReason: failureReasonValue } : {}),
      ...(failureDetail ? { failureDetail } : {}),
    };
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
    const existing = this.db.prepare(`
      SELECT * FROM downloaded_artifacts
      WHERE message_id = ? AND provider_id = ? AND sha256 = ? AND status IN ('READY', 'QUARANTINED')
      ORDER BY downloaded_at DESC LIMIT 1
    `).get(options.messageId, options.providerId, validated.sha256) as Record<string, unknown> | undefined;
    if (existing) return {
      id: String(existing.id), messageId: String(existing.message_id), projectId: String(existing.project_id),
      providerId: String(existing.provider_id), originalUrl: String(existing.original_url || ""), sha256: String(existing.sha256),
      localRelativePath: String(existing.local_relative_path), fileName: String(existing.file_name), mimeType: String(existing.mime_type),
      sizeBytes: Number(existing.size_bytes), status: String(existing.status) as DownloadedArtifactRecord["status"],
      downloadedAt: String(existing.downloaded_at),
    };
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
