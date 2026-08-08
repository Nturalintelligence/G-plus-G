import path from "node:path";
import type { Locator, Page } from "playwright";
import type { ProviderAttachmentCapabilities } from "../adapters/adapter-contract.js";
import { LocalArtifactStore } from "./artifact-store.js";
import type { AttachmentRefV1 } from "./attachments.js";

function mimeAccepted(mimeType: string, accepted: readonly string[]): boolean {
  return accepted.some((candidate) =>
    candidate === mimeType ||
    (candidate.endsWith("/*") && mimeType.startsWith(candidate.slice(0, -1))),
  );
}

export function prepareProviderUpload(
  attachments: readonly AttachmentRefV1[],
  capabilities: ProviderAttachmentCapabilities,
  store = new LocalArtifactStore(),
): { paths: string[]; fileNames: string[] } {
  if (!capabilities.supportsUpload) throw new Error("Provider does not support file uploads");
  if (
    capabilities.maxFilesPerMessage !== undefined &&
    attachments.length > capabilities.maxFilesPerMessage
  ) {
    throw new Error(`Provider accepts at most ${capabilities.maxFilesPerMessage} files per message`);
  }
  if (!capabilities.supportsMultipleFiles && attachments.length > 1) {
    throw new Error("Provider accepts only one file per message");
  }

  const paths: string[] = [];
  const fileNames: string[] = [];
  for (const attachment of attachments) {
    if (attachment.status === "QUARANTINED" || attachment.status === "FAILED") {
      throw new Error(
        `Attachment '${attachment.fileName}' cannot be uploaded: ${attachment.quarantineReason ?? attachment.status}`,
      );
    }
    if (!mimeAccepted(attachment.mimeType, capabilities.acceptedMimeTypes)) {
      throw new Error(`Provider does not accept MIME type ${attachment.mimeType}`);
    }
    const extension = path.extname(attachment.fileName).toLowerCase();
    if (!capabilities.acceptedExtensions.map((item) => item.toLowerCase()).includes(extension)) {
      throw new Error(`Provider does not accept file extension ${extension || "(none)"}`);
    }
    if (
      capabilities.maxFileBytes !== undefined &&
      attachment.sizeBytes > capabilities.maxFileBytes
    ) {
      throw new Error(`Attachment '${attachment.fileName}' exceeds the provider size limit`);
    }

    // This verifies size, SHA-256 and magic-byte MIME immediately before the
    // provider UI receives the path, closing the stage-to-upload mutation gap.
    store.readVerifiedBuffer(attachment);
    paths.push(store.resolveAbsolutePath(attachment.localRelativePath));
    fileNames.push(attachment.fileName);
  }
  return { paths, fileNames };
}

export async function uploadFilesAndVerifyAcceptance(
  page: Page,
  fileInput: Locator,
  paths: readonly string[],
  fileNames: readonly string[],
  providerLabel: string,
): Promise<void> {
  if ((await fileInput.count()) !== 1) {
    throw new Error(`${providerLabel} file input is unavailable or ambiguous`);
  }
  await fileInput.setInputFiles([...paths]);

  const acceptedNames = await fileInput
    .evaluate((element) => {
      const input = element as HTMLInputElement;
      return Array.from(input.files ?? []).map((file) => file.name);
    })
    .catch(() => [] as string[]);
  if (fileNames.every((name) => acceptedNames.includes(name))) return;

  // Some reactive uploaders clear the native input immediately after taking
  // ownership. In that case require visible filename evidence instead of
  // silently assuming success.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (fileNames.every((name) => bodyText.includes(name))) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`${providerLabel} did not confirm acceptance of all selected files`);
}
