import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { uploadAttachmentsToComposer, type ProviderUploadSelectors } from "../src/adapters/provider-attachment-upload.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import { CHATGPT_UPLOAD_SELECTORS } from "../src/chatgpt-adapter.js";
import { ChatGptAdapter } from "../src/chatgpt-adapter.js";
import { GEMINI_UPLOAD_SELECTORS } from "../src/gemini-adapter.js";
import { GeminiAdapter } from "../src/gemini-adapter.js";

const capabilities = {
  supportsUpload: true,
  acceptedMimeTypes: ["image/*", "text/*", "application/pdf"],
  acceptedExtensions: [".png", ".md", ".pdf"],
  maxFileBytes: 2_000_000,
  maxFilesPerMessage: 5,
  supportsImages: true,
  supportsMultipleFiles: true,
  supportsResponseArtifacts: true,
};
const selectors: ProviderUploadSelectors = {
  providerId: "fixture-provider",
  fileInputs: ['input[type="file"]'],
  attachmentButtons: ['button[aria-label="Attach"]'],
  attachmentEvidence: [".attachment-chip"],
  uploadBusy: [".upload-busy"],
  uploadErrors: [".upload-error"],
  timeoutMs: 600,
};

describe("provider attachment upload evidence", () => {
  let browser: Browser;
  let page: Page;
  const root = mkdtempSync(join(tmpdir(), "provider-upload-fixture-"));
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const first = store.storeBuffer(Buffer.from("# first markdown\n"), { projectId: "project", messageId: "message", source: "user", originalFileName: "Первый документ.md" });
  const second = store.storeBuffer(Buffer.from("# second distinct markdown\n"), { projectId: "project", messageId: "message", source: "user", originalFileName: "Second file.md" });
  const formatMatrix = [
    store.storeBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), { projectId: "matrix", messageId: "formats", source: "user", originalFileName: "screen.png" }),
    store.storeBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), { projectId: "matrix", messageId: "formats", source: "user", originalFileName: "photo.jpeg" }),
    store.storeBuffer(Buffer.from("RIFF0000WEBPVP8 ", "ascii"), { projectId: "matrix", messageId: "formats", source: "user", originalFileName: "modern.webp" }),
    store.storeBuffer(Buffer.from("%PDF-1.7\nfixture"), { projectId: "matrix", messageId: "formats", source: "user", originalFileName: "document.pdf" }),
    store.storeBuffer(Buffer.from("# Markdown provider fixture\n"), { projectId: "matrix", messageId: "formats", source: "user", originalFileName: "notes.md" }),
  ];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });

  async function fixture(script: string, input = '<input type="file" multiple>'): Promise<void> {
    page = await browser.newPage();
    await page.setContent(`<button aria-label="Attach">Attach</button>${input}<div id="chips"></div><script>${script}</script>`);
  }

  it("requires exact input files and stable composer chips before returning evidence", async () => {
    await fixture(`document.querySelector('input').addEventListener('change', (event) => {
      const busy = document.createElement('div'); busy.className = 'upload-busy'; document.body.appendChild(busy);
      setTimeout(() => { for (const file of event.target.files) { const chip = document.createElement('div'); chip.className = 'attachment-chip'; chip.textContent = file.name; document.querySelector('#chips').appendChild(chip); } busy.remove(); }, 80);
    });`);
    const evidence = await uploadAttachmentsToComposer(page, [first, second], capabilities, selectors, store);
    expect(evidence.attachmentIds).toEqual([first.id, second.id]);
    expect(evidence.strategy).toBe("file-input-and-composer-evidence");
    await page.close();
  });

  it("recognizes filenames exposed by descendant accessibility metadata", async () => {
    await fixture(`document.querySelector('input').addEventListener('change', (event) => {
      const chip = document.createElement('div'); chip.className = 'attachment-chip';
      const remove = document.createElement('button'); remove.setAttribute('aria-label', 'Remove file ' + event.target.files[0].name);
      chip.appendChild(remove); document.querySelector('#chips').appendChild(chip);
    });`);
    await expect(uploadAttachmentsToComposer(page, [first], capabilities, selectors, store)).resolves.toMatchObject({ attachmentIds: [first.id] });
    await page.close();
  });

  it("accepts ChatGPT file-tile groups with provider filename suffixes", async () => {
    await fixture(`document.querySelector('input').addEventListener('change', (event) => {
      const form = document.createElement('form');
      for (const [index, file] of Array.from(event.target.files).entries()) {
        const tile = document.createElement('div'); tile.setAttribute('role', 'group');
        const dot = file.name.lastIndexOf('.');
        tile.setAttribute('aria-label', file.name.slice(0, dot) + '(' + (index + 2) + ')' + file.name.slice(dot));
        tile.textContent = file.name;
        form.appendChild(tile);
      }
      document.querySelector('#chips').appendChild(form);
    });`);
    await expect(uploadAttachmentsToComposer(page, [first, second], capabilities, { ...CHATGPT_UPLOAD_SELECTORS, timeoutMs: 600 }, store))
      .resolves.toMatchObject({ attachmentIds: [first.id, second.id] });
    await page.close();
  });

  it("fails closed when the provider exposes no stable upload evidence", async () => {
    await fixture(`document.querySelector('input').addEventListener('change', () => undefined);`);
    await expect(uploadAttachmentsToComposer(page, [first], capabilities, { ...selectors, timeoutMs: 250 }, store)).rejects.toThrow(/did not expose stable composer evidence/);
    await page.close();
  });

  it("propagates provider upload errors and rejects ambiguous file inputs", async () => {
    await fixture(`document.querySelector('input').addEventListener('change', () => { const error = document.createElement('div'); error.className = 'upload-error'; error.textContent = 'quota exceeded'; document.body.appendChild(error); });`);
    await expect(uploadAttachmentsToComposer(page, [first], capabilities, selectors, store)).rejects.toThrow(/quota exceeded/);
    await page.close();

    await fixture("", '<input type="file" multiple><input type="file" multiple>');
    await expect(uploadAttachmentsToComposer(page, [first], capabilities, selectors, store)).rejects.toThrow(/ambiguous/);
    await page.close();
  });

  it("enforces provider count, size and type capabilities before file input", async () => {
    await fixture("");
    await expect(uploadAttachmentsToComposer(page, [second], { ...capabilities, maxFileBytes: 1 }, selectors, store)).rejects.toThrow(/size limit/);
    await expect(uploadAttachmentsToComposer(page, [first, second], { ...capabilities, maxFilesPerMessage: 1 }, selectors, store)).rejects.toThrow(/at most 1 files/);
    await page.close();

    await fixture("");
    await expect(uploadAttachmentsToComposer(page, [second], { ...capabilities, acceptedMimeTypes: ["image/png"], acceptedExtensions: [".png"] }, selectors, store)).rejects.toThrow(/does not accept/);
    await page.close();
  });

  it.each([
    ["ChatGPT", CHATGPT_UPLOAD_SELECTORS, '<div data-testid="composer-attachment"></div>'],
    ["Gemini", GEMINI_UPLOAD_SELECTORS, '<file-chip></file-chip>'],
  ] as const)("matches the production %s composer evidence selectors", async (_provider, productionSelectors, evidenceMarkup) => {
    await fixture(`document.querySelector('input').addEventListener('change', (event) => { const host = document.querySelector('#chips'); host.innerHTML = ${JSON.stringify(evidenceMarkup)}; host.firstElementChild.textContent = event.target.files[0].name; });`);
    await expect(uploadAttachmentsToComposer(page, [second], capabilities, { ...productionSelectors, timeoutMs: 600 }, store)).resolves.toMatchObject({ attachmentIds: [second.id] });
    await page.close();
  });

  it("opens the localized Gemini upload control", async () => {
    await fixture(`document.querySelector('button[aria-label="Загрузить файлы"]').addEventListener('click', () => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
      input.addEventListener('change', (event) => { for (const file of event.target.files) { const chip = document.createElement('file-chip'); chip.textContent = file.name; document.querySelector('#chips').appendChild(chip); } });
      document.body.appendChild(input);
    });`, '<button aria-label="Загрузить файлы">files</button>');
    await expect(uploadAttachmentsToComposer(page, [first], capabilities, { ...GEMINI_UPLOAD_SELECTORS, timeoutMs: 600 }, store))
      .resolves.toMatchObject({ attachmentIds: [first.id] });
    await page.close();
  });

  it("selects the Gemini upload-files menu item before waiting for the input", async () => {
    await fixture(`document.querySelector('button[aria-label="Загрузить"]').addEventListener('click', () => {
      const menu = document.createElement('button'); menu.setAttribute('role', 'menuitem'); menu.textContent = 'Загрузить файлы';
      menu.addEventListener('click', () => {
        const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
        input.addEventListener('change', (event) => { for (const file of event.target.files) { const chip = document.createElement('file-chip'); chip.textContent = file.name; document.querySelector('#chips').appendChild(chip); } });
        document.body.appendChild(input);
      });
      document.body.appendChild(menu);
    });`, '<button aria-label="Загрузить">open</button>');
    await expect(uploadAttachmentsToComposer(page, [first], capabilities, { ...GEMINI_UPLOAD_SELECTORS, timeoutMs: 600 }, store))
      .resolves.toMatchObject({ attachmentIds: [first.id] });
    await page.close();
  });

  it.each([
    ["ChatGPT", new ChatGptAdapter().getCapabilities(), CHATGPT_UPLOAD_SELECTORS, 'div', 'data-testid="composer-attachment"'],
    ["Gemini", new GeminiAdapter().getCapabilities(), GEMINI_UPLOAD_SELECTORS, 'file-chip', ''],
  ] as const)("accepts the local PNG/JPEG/WebP/PDF/MD matrix through %s production policy", async (_provider, productionCapabilities, productionSelectors, tag, attribute) => {
    await fixture(`document.querySelector('input').addEventListener('change', (event) => { const host = document.querySelector('#chips'); for (const file of event.target.files) { const chip = document.createElement(${JSON.stringify(tag)}); chip.className = 'attachment-chip'; ${attribute ? `chip.setAttribute('data-testid', 'composer-attachment');` : ""} chip.textContent = file.name; host.appendChild(chip); } });`);
    await expect(uploadAttachmentsToComposer(page, formatMatrix, productionCapabilities, { ...productionSelectors, timeoutMs: 600 }, store)).resolves.toMatchObject({ attachmentIds: formatMatrix.map((item) => item.id) });
    await page.close();
  });

  it("rejects content tampering before interacting with provider DOM", async () => {
    await fixture("");
    writeFileSync(store.resolveAbsolutePath(first.localRelativePath), "tampered");
    await expect(uploadAttachmentsToComposer(page, [first], capabilities, selectors, store)).rejects.toThrow(/integrity failed/);
    await page.close();
  });
});
