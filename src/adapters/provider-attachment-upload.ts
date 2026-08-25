import path from "node:path";
import type { Locator, Page } from "playwright";
import type { AttachmentRefV1 } from "../attachments/attachments.js";
import { LocalArtifactStore } from "../attachments/artifact-store.js";
import type { ProviderAttachmentCapabilities } from "./adapter-contract.js";

export interface ProviderUploadSelectors {
  providerId: string;
  fileInputs: readonly string[];
  attachmentButtons: readonly string[];
  fileMenuItems?: readonly string[];
  attachmentEvidence: readonly string[];
  uploadBusy: readonly string[];
  uploadErrors: readonly string[];
  timeoutMs?: number;
}

export interface ProviderUploadEvidence {
  attachmentIds: string[];
  fileNames: string[];
  confirmedAt: string;
  strategy: "file-input-and-composer-evidence";
}

function extension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

function mimeAccepted(mimeType: string, accepted: readonly string[]): boolean {
  const normalized = mimeType.toLowerCase();
  return accepted.some((candidate) => {
    const rule = candidate.toLowerCase();
    return rule.endsWith("/*") ? normalized.startsWith(rule.slice(0, -1)) : normalized === rule;
  });
}

function assertCapabilities(attachments: readonly AttachmentRefV1[], capabilities: ProviderAttachmentCapabilities, providerId: string): void {
  if (!capabilities.supportsUpload) throw new Error(`${providerId} does not support file upload`);
  if (capabilities.maxFilesPerMessage && attachments.length > capabilities.maxFilesPerMessage) {
    throw new Error(`${providerId} accepts at most ${capabilities.maxFilesPerMessage} files per message`);
  }
  if (!capabilities.supportsMultipleFiles && attachments.length > 1) throw new Error(`${providerId} does not support multiple files`);
  for (const attachment of attachments) {
    if (!attachment.id || !attachment.fileName || !attachment.localRelativePath) throw new Error("Attachment metadata is incomplete");
    if (attachment.status !== "STAGED" && attachment.status !== "READY") throw new Error(`Attachment ${attachment.id} is not uploadable: ${attachment.status}`);
    if (capabilities.maxFileBytes && attachment.sizeBytes > capabilities.maxFileBytes) throw new Error(`${attachment.fileName} exceeds ${providerId} size limit`);
    const acceptedByMime = mimeAccepted(attachment.mimeType, capabilities.acceptedMimeTypes);
    const acceptedByExtension = capabilities.acceptedExtensions.map((item) => item.toLowerCase()).includes(extension(attachment.fileName));
    if (!acceptedByMime && !acceptedByExtension) throw new Error(`${providerId} does not accept ${attachment.fileName} (${attachment.mimeType})`);
  }
}

async function visibleUnique(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  const matches: Locator[] = [];
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
    }
    if (matches.length > 0) break;
  }
  if (matches.length > 1) throw new Error(`Attachment control is ambiguous: ${matches.length} visible candidates`);
  return matches[0] ?? null;
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function compatibleFileInputs(page: Page, selectors: readonly string[], attachments: readonly AttachmentRefV1[]): Promise<Locator[]> {
  const matches: Locator[] = [];
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isDisabled().catch(() => true)) continue;
      const multiple = await candidate.getAttribute("multiple");
      if (attachments.length > 1 && multiple === null) continue;
      const accept = (await candidate.getAttribute("accept"))?.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean) ?? [];
      if (accept.length > 0 && attachments.some((attachment) => !mimeAccepted(attachment.mimeType, accept) && !accept.includes(extension(attachment.fileName)))) continue;
      matches.push(candidate);
    }
    if (matches.length > 0) break;
  }
  return matches;
}

async function waitForCompatibleFileInputs(page: Page, selectors: readonly string[], attachments: readonly AttachmentRefV1[], timeoutMs = 3_000): Promise<Locator[]> {
  const deadline = Date.now() + timeoutMs;
  do {
    const inputs = await compatibleFileInputs(page, selectors, attachments);
    if (inputs.length > 0) return inputs;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return [];
}

async function combinedEvidenceText(page: Page, selectors: readonly string[]): Promise<{ count: number; text: string }> {
  let count = 0;
  const values: string[] = [];
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const candidateCount = await candidates.count().catch(() => 0);
    for (let index = 0; index < candidateCount; index += 1) {
      const item = candidates.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      count += 1;
      values.push(await item.evaluate((element) => {
        const attributes = ["aria-label", "title", "alt", "data-name", "data-file-name", "data-testid"]
          .map((name) => element.getAttribute(name) ?? "");
        const descendants = Array.from(element.querySelectorAll("[aria-label], [title], [alt], [data-name], [data-file-name]"))
          .flatMap((child) => [
            child.getAttribute("aria-label") ?? "",
            child.getAttribute("title") ?? "",
            child.getAttribute("alt") ?? "",
            child.getAttribute("data-name") ?? "",
            child.getAttribute("data-file-name") ?? "",
          ]);
        return [(element as HTMLElement).innerText ?? "", ...attributes, ...descendants].filter(Boolean).join(" ");
      }).catch(() => ""));
    }
  }
  return { count, text: values.join(" ").normalize("NFC").toLowerCase() };
}

function fileEvidenceMatches(evidence: { count: number; text: string }, attachments: readonly AttachmentRefV1[]): boolean {
  if (evidence.count < attachments.length) return false;
  return attachments.every((attachment) => {
    const normalized = attachment.fileName.normalize("NFC").toLowerCase();
    const stem = path.basename(normalized, path.extname(normalized));
    const stablePrefix = stem.slice(0, Math.min(12, stem.length));
    return evidence.text.includes(normalized) || (stablePrefix.length >= 4 && evidence.text.includes(stablePrefix));
  });
}

export async function uploadAttachmentsToComposer(
  page: Page,
  attachments: readonly AttachmentRefV1[],
  capabilities: ProviderAttachmentCapabilities,
  selectors: ProviderUploadSelectors,
  store = new LocalArtifactStore(),
): Promise<ProviderUploadEvidence> {
  if (attachments.length === 0) throw new Error("Attachment upload requires at least one file");
  assertCapabilities(attachments, capabilities, selectors.providerId);
  const absolutePaths = attachments.map((attachment) => {
    const integrity = store.verifyIntegrity(attachment);
    if (!integrity.valid) throw new Error(`Attachment integrity failed for ${attachment.fileName}: ${integrity.reason}`);
    return store.resolveAbsolutePath(attachment.localRelativePath);
  });

  let inputs = await compatibleFileInputs(page, selectors.fileInputs, attachments);
  if (inputs.length === 0) {
    const button = await visibleUnique(page, selectors.attachmentButtons);
    if (!button) throw new Error(`${selectors.providerId} attachment control was not found`);
    await button.click();
    inputs = await waitForCompatibleFileInputs(page, selectors.fileInputs, attachments);
    if (inputs.length === 0 && selectors.fileMenuItems?.length) {
      const menuItem = await visibleUnique(page, selectors.fileMenuItems);
      if (menuItem) {
        await menuItem.click();
        inputs = await waitForCompatibleFileInputs(page, selectors.fileInputs, attachments);
      }
    }
  }
  if (inputs.length !== 1) throw new Error(`${selectors.providerId} file input is ${inputs.length === 0 ? "missing" : "ambiguous"}`);
  const input = inputs[0]!;
  const inputHandle = await input.elementHandle();
  if (!inputHandle) throw new Error(`${selectors.providerId} file input detached before upload`);
  await inputHandle.setInputFiles(absolutePaths);
  const inputFiles = await inputHandle.evaluate((node) => Array.from((node as HTMLInputElement).files ?? []).map((file) => ({ name: file.name, size: file.size })));
  if (inputFiles.length !== attachments.length || inputFiles.some((file, index) => file.name !== path.basename(absolutePaths[index]!) || file.size !== attachments[index]!.sizeBytes)) {
    throw new Error(`${selectors.providerId} file input did not accept the exact attachment set`);
  }

  const evidenceAttachments = attachments.map((attachment, index) => ({ ...attachment, fileName: path.basename(absolutePaths[index]!) }));
  const deadline = Date.now() + (selectors.timeoutMs ?? 45_000);
  let lastEvidence = { count: 0, text: "" };
  while (Date.now() < deadline) {
    const error = await firstVisible(page, selectors.uploadErrors);
    if (error) throw new Error(`${selectors.providerId} reported attachment upload failure: ${await error.innerText().catch(() => "unknown error")}`);
    const busy = await firstVisible(page, selectors.uploadBusy);
    const evidence = await combinedEvidenceText(page, selectors.attachmentEvidence);
    lastEvidence = evidence;
    if (!busy && fileEvidenceMatches(evidence, evidenceAttachments)) {
      return {
        attachmentIds: attachments.map((attachment) => attachment.id),
        fileNames: attachments.map((attachment) => attachment.fileName),
        confirmedAt: new Date().toISOString(),
        strategy: "file-input-and-composer-evidence",
      };
    }
    await page.waitForTimeout(150);
  }
  const expectedNames = evidenceAttachments.map((attachment) => attachment.fileName);
  throw new Error(
    `${selectors.providerId} did not expose stable composer evidence for all uploaded files `
    + `(cards=${lastEvidence.count}, expected=${JSON.stringify(expectedNames)}, evidence=${JSON.stringify(lastEvidence.text.slice(0, 500))})`,
  );
}
