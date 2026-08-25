import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationRef,
  MessageInput,
  ModelAdapter,
  ProviderAttachmentCapabilities,
  RecoveryResult,
  TurnEvent,
  TurnRef,
} from "./adapters/adapter-contract.js";
import { ResponseArtifactDownloader } from "./attachments/artifact-downloader.js";
import type { AttachmentRefV1 } from "./attachments/attachments.js";
import { TurnChannel } from "./adapters/turn-channel.js";
import { ProfileLock } from "./browser/profile-lock.js";
import { bundledChromiumExecutable } from "./browser/runtime.js";
import {
  AmbiguousElementError,
  ChallengeRequiredError,
  LoginCancelledError,
  LoginRequiredError,
  LoginTimeoutError,
  TurnTimeoutError,
} from "./errors.js";
import { fingerprint, normalizeText, selectNewResponse } from "./fingerprint.js";
import { fillComposerSafely } from "./adapters/dom-utils.js";
import { newId } from "./ids.js";
import { dataPath } from "./paths.js";
import { inferSessionState } from "./adapters/session-inference.js";
import { inferChallengePage } from "./adapters/challenge-inference.js";
import { hasPendingExternalLoginPage } from "./adapters/manual-login.js";
import type {
  DiagnosticReport,
  ResponseSnapshot,
  SessionState,
  TurnResult,
} from "./types.js";
import { uploadAttachmentsToComposer } from "./adapters/provider-attachment-upload.js";
import { classifyProviderResult, ProviderResultProgress } from "./adapters/provider-result-state.js";

const GEMINI_URL = "https://gemini.google.com/app";
const COMPOSERS = [
  'rich-textarea div[contenteditable="true"]',
  '.ql-editor[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea[aria-label*="prompt" i]',
];
const RESPONSES = [
  "model-response",
  '[data-message-author-role="model"]',
  ".model-response-text",
  "message-content",
];
const SEND_BUTTONS = [
  'button[aria-label*="Send" i]',
  'button[aria-label*="Отправ" i]',
  "button.send-button",
  'button[data-test-id*="send" i]',
];
const USER_MESSAGES = [
  "user-query",
  '[data-message-author-role="user"]',
  ".user-query-content",
  "user-query message-content",
];
export const GEMINI_UPLOAD_SELECTORS = {
  providerId: "gemini",
  fileInputs: ['input[type="file"]', 'uploader-file-input input[type="file"]'],
  attachmentButtons: ['button[aria-label*="Upload" i]', 'button[aria-label*="Прикреп" i]', 'button[aria-label*="Add file" i]', 'button[data-test-id*="upload" i]'],
  attachmentEvidence: [
    'file-chip',
    'mat-chip:has([class*="file" i])',
    '[data-test-id*="attachment" i]',
    '[class*="attachment" i] [class*="file" i]',
    'button[aria-label*="remove file" i]',
  ],
  uploadBusy: ['mat-progress-spinner', '[role="progressbar"]', '[aria-label*="uploading" i]', '[aria-busy="true"][class*="upload" i]'],
  uploadErrors: ['[class*="upload-error" i]', '[role="alert"]:has-text("upload")', '[role="alert"]:has-text("загруз")'],
} as const;
interface GeminiTurn {
  channel: TurnChannel;
  result: Promise<TurnResult>;
  resolveManual: (text: string) => void;
  rejectCancellation: (error: Error) => void;
}

export class GeminiAdapter implements ModelAdapter {
  readonly providerId = "gemini";
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly profileDir: string;
  private readonly lock: ProfileLock;
  private readonly turns = new Map<string, GeminiTurn>();
  private readonly timeoutMs: number;

  private readonly headless: boolean;
  private readonly artifactDatabase: DatabaseSync | undefined;

  constructor(options: { profileDir?: string; timeoutMs?: number; headless?: boolean; artifactDatabase?: DatabaseSync } = {}) {
    this.profileDir = resolve(options.profileDir ?? dataPath("profiles", "gemini"));
    this.lock = new ProfileLock(this.profileDir);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.headless = options.headless ?? true;
    this.artifactDatabase = options.artifactDatabase;
  }

  async launch(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    await this.lock.acquire();
    try {
      await this.launchAutomatedBrowser();
    } catch (error) {
      await this.lock.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
      this.context = null;
      this.page = null;
    } finally {
      await this.lock.release();
    }
  }

  async checkSession(): Promise<SessionState> {
    const page = await this.ensurePage(false);
    const body = await page.locator("body").innerText().catch(() => "");
    const loginControls = page.getByRole("button", { name: /^(sign in|войти)$/i });
    let visibleLoginControls = 0;
    for (let index = 0; index < (await loginControls.count()); index += 1) {
      if (await loginControls.nth(index).isVisible().catch(() => false)) {
        visibleLoginControls += 1;
      }
    }
    const composers = (await this.visibleComposers()).length;
    const hasAccountSession =
      await this.hasUserMenu() || await this.hasGoogleAccountSession();
    const challenge = hasAccountSession ? false : await this.hasChallenge();
    return inferSessionState(
      "gemini",
      body,
      composers,
      visibleLoginControls,
      {
        hasUserMenu: hasAccountSession,
        hasChallenge: challenge,
        url: page.url(),
      },
    );
  }

  async openLoginMode(): Promise<void> {
    await this.ensurePage(false);
    const deadline = Date.now() + 10 * 60_000;
    let consecutiveAuthCount = 0;
    while (Date.now() < deadline) {
      const openPages = this.context?.pages().filter((candidate) => !candidate.isClosed()) ?? [];
      if (openPages.length === 0) {
        throw new LoginCancelledError("Пользователь закрыл окно Gemini до завершения входа");
      }

      const hasExplicitAccountControl =
        await this.hasUserMenu().catch(() => false) ||
        await this.hasGoogleAccountSession();
      const hasPendingExternalPage = hasPendingExternalLoginPage(
        "gemini",
        openPages.map((candidate) => candidate.url()),
      );
      if (hasExplicitAccountControl && !hasPendingExternalPage) {
        consecutiveAuthCount += 1;
        if (consecutiveAuthCount >= 2) return;
      } else {
        consecutiveAuthCount = 0;
      }

      const activePage = await this.ensurePage(false);
      await activePage.waitForTimeout(2_000).catch(() => undefined);
    }
    throw new LoginTimeoutError("Время ожидания входа в Gemini истекло");
  }

  async createConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    await this.navigateToGemini(page);
    return { id: newId("gemchat"), url: page.url() };
  }

  async openConversation(ref: ConversationRef): Promise<void> {
    if (!ref.url.startsWith("https://gemini.google.com/")) {
      throw new Error("Conversation URL must belong to gemini.google.com");
    }
    await (await this.ensurePage()).goto(ref.url, { waitUntil: "domcontentloaded" });
  }

  async getCurrentConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    await page.waitForURL(
      (url) =>
        url.hostname === "gemini.google.com" && url.pathname.startsWith("/app/"),
      { timeout: 5_000 },
    );
    return { id: newId("gemchat"), url: page.url() };
  }

  public getCapabilities(): ProviderAttachmentCapabilities {
    return {
      supportsUpload: true,
      acceptedMimeTypes: ["image/*", "text/*", "application/pdf"],
      acceptedExtensions: [".png", ".jpg", ".jpeg", ".webp", ".pdf", ".txt", ".md"],
      maxFileBytes: 25_165_824,
      maxFilesPerMessage: 5,
      supportsImages: true,
      supportsMultipleFiles: true,
      supportsResponseArtifacts: true,
    };
  }

  async sendMessage(input: MessageInput): Promise<TurnRef>;
  async sendMessage(input: string): Promise<TurnResult>;
  async sendMessage(input: MessageInput | string): Promise<TurnRef | TurnResult> {
    if (typeof input === "string") return this.sendAndWait(input);
    const ref = { id: newId("gemturn") };
    const channel = new TurnChannel();
    let resolveManual: (text: string) => void = () => undefined;
    let rejectCancellation: (error: Error) => void = () => undefined;
    const manual = new Promise<string>((resolveManualPromise) => {
      resolveManual = resolveManualPromise;
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const result = Promise.race([
      this.sendAndWait(input.content, input.attachments, channel, input.responseArtifactTarget),
      cancellation,
      manual.then((response) => ({
        response,
        responseFingerprint: fingerprint(response),
        elapsedMs: 0,
      })),
    ]).finally(() => channel.finish());
    this.turns.set(ref.id, { channel, result, resolveManual, rejectCancellation });
    return ref;
  }

  async *observeTurn(turn: TurnRef): AsyncIterable<TurnEvent> {
    yield* this.requireTurn(turn).channel.observe();
  }

  async getFinalResponse(turn: TurnRef): Promise<TurnResult> {
    try {
      return await this.requireTurn(turn).result;
    } finally {
      this.turns.delete(turn.id);
    }
  }

  async cancel(turn: TurnRef): Promise<void> {
    const active = this.requireTurn(turn);
    const page = this.page;
    if (page && !page.isClosed()) {
      const stop = page.getByRole("button", { name: /stop|останов/i });
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => undefined);
    }
    active.channel.publish({ type: "CANCELLED", at: new Date().toISOString() });
    active.rejectCancellation(new Error(`Gemini turn cancelled: ${turn.id}`));
    active.channel.finish();
  }

  async completeManually(turn: TurnRef, response: string): Promise<void> {
    const active = this.requireTurn(turn);
    active.resolveManual(response);
    active.channel.publish({
      type: "RESPONSE_COMPLETED",
      at: new Date().toISOString(),
      text: response,
    });
  }

  async recover(): Promise<RecoveryResult> {
    const page = await this.ensurePage();
    return {
      recovered: true,
      conversation: { id: newId("gemrecovered"), url: page.url() },
    };
  }

  async collectDiagnostics(): Promise<DiagnosticReport> {
    const page = await this.ensurePage();
    return {
      timestamp: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      sessionState: await this.checkSession(),
      composerCandidates: (await this.visibleComposers()).length,
      assistantResponseCount: (await this.responses()).length,
    };
  }

  private async sendAndWait(message: string, attachments?: AttachmentRefV1[], channel?: TurnChannel, responseTarget?: { projectId: string; messageId: string }): Promise<TurnResult> {
    const started = Date.now();
    const state = await this.waitUntilReady();
    const page = await this.ensurePage();

    if (attachments && attachments.length > 0) {
      const evidence = await uploadAttachmentsToComposer(page, attachments, this.getCapabilities(), GEMINI_UPLOAD_SELECTORS);
      channel?.publish({ type: "ATTACHMENTS_UPLOADED", at: evidence.confirmedAt, attachmentIds: evidence.attachmentIds });
    }

    const composers = await this.visibleComposers();
    if (state !== "AUTHENTICATED" && composers.length !== 1) {
      throw new LoginRequiredError(`Gemini state: ${state}`);
    }
    const before = await this.responses();
    const userMessagesBefore = await this.captureUserMessageSignatures();
    const candidates = composers;
    if (candidates.length !== 1) {
      throw new AmbiguousElementError(`Expected one Gemini composer, found ${candidates.length}`);
    }
    await fillComposerSafely(candidates[0]!, message);
    await this.submitComposer(candidates[0]!, message);
    await this.waitUntilUserMessage(userMessagesBefore);
    channel?.publish({ type: "MESSAGE_SUBMITTED", at: new Date().toISOString() });

    const response = await this.waitForResponse(before, channel);

    const extractedArtifacts = [];
    const extractedLinks: Array<{ label: string; url: string; downloadable: boolean }> = [];

    try {
      const downloader = this.artifactDatabase ? new ResponseArtifactDownloader(this.artifactDatabase) : null;
      const items = await (downloader
        ? downloader.extractTurnArtifactsFromPage(page, 'message-content, .model-response-text')
        : new ResponseArtifactDownloader({ prepare: () => ({ run: () => undefined }) } as any)
            .extractTurnArtifactsFromPage(page, 'message-content, .model-response-text'));
      for (const item of items) {
        extractedLinks.push({ label: item.label, url: item.url, downloadable: !item.isImage });
      }
      if (downloader && responseTarget) {
        extractedArtifacts.push(...await downloader.downloadTurnArtifactsFromPage(page, 'message-content, .model-response-text', {
          projectId: responseTarget.projectId,
          messageId: responseTarget.messageId,
          providerId: this.providerId,
        }));
      }
    } catch {
      // Best-effort artifact scan
    }

    return {
      response: response.text,
      responseFingerprint: response.fingerprint,
      elapsedMs: Date.now() - started,
      artifacts: extractedArtifacts,
      links: extractedLinks,
    };
  }

  private async waitUntilReady(): Promise<SessionState> {
    const deadline = Date.now() + 30_000;
    let state: SessionState = "UNKNOWN";
    while (Date.now() < deadline) {
      state = await this.checkSession();
      if (state === "AUTHENTICATED") {
        await this.waitUntilStableResponses();
        return state;
      }
      if (state === "CHALLENGE_REQUIRED") {
        return state;
      }
      await (await this.ensurePage()).waitForTimeout(500);
    }
    return state;
  }

  private async waitUntilStableResponses(): Promise<void> {
    const page = await this.ensurePage(false);
    let lastCount = -1;
    let stableSince = Date.now();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const currentCount = (await this.responses()).length;
      if (currentCount !== lastCount) {
        lastCount = currentCount;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1_000) {
        break;
      }
      await page.waitForTimeout(200);
    }
  }

  private async waitForResponse(
    before: ResponseSnapshot[],
    channel?: TurnChannel,
  ): Promise<ResponseSnapshot> {
    const page = await this.ensurePage();
    const deadline = Date.now() + this.timeoutMs;
    let stable = "";
    let stableSince = 0;
    let started = false;
    const lifecycle = new ProviderResultProgress(Date.now(), this.timeoutMs);
    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();
      const selected = selectNewResponse(before, await this.responses());
      const resultState = classifyProviderResult({
        generationActive: await page.getByRole("button", { name: /stop|останов/i }).isVisible().catch(() => false),
        selectionCount: await page.locator('[role="dialog"] button:has(img)').count().catch(() => 0),
        responsePresent: Boolean(selected),
        downloadControlCount: await page.locator('message-content:last-of-type button[aria-label*="download" i], message-content:last-of-type button[aria-label*="Скач"], message-content:last-of-type [data-test-id="open-button"]').count().catch(() => 0),
        failureVisible: await page.locator('[role="alert"]:visible').filter({ hasText: /generation failed|не удалось|ошибка/i }).count().then((count) => count > 0).catch(() => false),
      });
      if (lifecycle.update(resultState, Date.now()) && resultState !== "SUBMITTED") {
        channel?.publish({ type: resultState, at: new Date().toISOString() });
      }
      if (selected) {
        if (!started) {
          started = true;
          channel?.publish({ type: "RESPONSE_STARTED", at: new Date().toISOString() });
        }
        if (stable !== selected.text) {
          stable = selected.text;
          stableSince = Date.now();
          channel?.publish({
            type: "RESPONSE_UPDATED",
            at: new Date().toISOString(),
            text: stable,
          });
        }
        const stop = page.getByRole("button", { name: /stop|останов/i });
        const composerReady = (await this.visibleComposers()).length >= 1;
        const artifactReady = lifecycle.current() === "DOWNLOAD_AVAILABLE";
        if (
          !(await stop.isVisible().catch(() => false)) &&
          (composerReady || artifactReady) &&
          Date.now() - stableSince >= 2_500
        ) {
          channel?.publish({
            type: "RESPONSE_COMPLETED",
            at: new Date().toISOString(),
            text: stable,
          });
          return selected;
        }
      }
      await page.waitForTimeout(500);
    }
    throw new TurnTimeoutError("Gemini response timed out");
  }

  private async visibleComposers(): Promise<Locator[]> {
    const page = await this.ensurePage();
    for (const selector of COMPOSERS) {
      const locator = page.locator(selector);
      const visible: Locator[] = [];
      for (let index = 0; index < (await locator.count()); index += 1) {
        const candidate = locator.nth(index);
        const usable =
          (await candidate.isVisible().catch(() => false)) &&
          (await candidate.isEditable().catch(() => false));
        if (usable) visible.push(candidate);
      }
      if (visible.length > 0) return visible;
    }
    return [];
  }

  private async submitComposer(composer: Locator, message: string): Promise<void> {
    await composer.press("Enter");
    if (await this.composerWasCleared(composer)) {
      return;
    }

    const buttons = await this.visibleBySelectors(SEND_BUTTONS);
    if (buttons.length !== 1) {
      throw new AmbiguousElementError(
        `Gemini message was not submitted by Enter; expected one send button, found ${buttons.length}`,
      );
    }
    await buttons[0]!.click();
    if (!(await this.composerWasCleared(composer))) {
      throw new TurnTimeoutError("Gemini composer did not clear after submission");
    }
  }

  private async composerWasCleared(composer: Locator): Promise<boolean> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const text = normalizeText(
        await composer
          .evaluate((element) =>
            element instanceof HTMLTextAreaElement
              ? element.value
              : (element.textContent ?? ""),
          )
          .catch(() => ""),
      );
      if (!text) return true;
      await (await this.ensurePage()).waitForTimeout(150);
    }
    return false;
  }

  private async captureUserMessageSignatures(): Promise<Set<string>> {
    const page = await this.ensurePage();
    const signatures = new Set<string>();
    for (const selector of USER_MESSAGES) {
      const nodes = page.locator(selector);
      for (let index = 0; index < (await nodes.count().catch(() => 0)); index += 1) {
        const node = nodes.nth(index);
        const id =
          (await node.getAttribute("data-message-id").catch(() => null)) ??
          (await node.getAttribute("id").catch(() => null));
        const text = normalizeText(await node.innerText().catch(() => ""));
        if (id || text) signatures.add(id ? `id:${id}` : `text:${fingerprint(text)}`);
      }
    }
    return signatures;
  }

  private async waitUntilUserMessage(
    userMessagesBefore: ReadonlySet<string>,
  ): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();

      const current = await this.captureUserMessageSignatures();
      if ([...current].some((signature) => !userMessagesBefore.has(signature))) return;
      await (await this.ensurePage()).waitForTimeout(250);
    }
    throw new TurnTimeoutError("Gemini did not confirm that the user message was submitted");
  }

  private async visibleBySelectors(selectors: readonly string[]): Promise<Locator[]> {
    const page = await this.ensurePage();
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const visible: Locator[] = [];
      for (let index = 0; index < (await locator.count()); index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
      }
      if (visible.length > 0) return visible;
    }
    return [];
  }

  private async responses(): Promise<ResponseSnapshot[]> {
    const page = await this.ensurePage();
    for (const selector of RESPONSES) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const result: ResponseSnapshot[] = [];
      for (let index = 0; index < count; index += 1) {
        const node = locator.nth(index);
        const text = normalizeText(
          await node
            .evaluate((el) => {
              const noiseSelectors = [
                "button",
                "svg",
                ".action-area",
                ".message-actions",
                "mat-icon",
                ".ql-clipboard",
                "pre > div",
              ];
              const hidden: Array<{ element: any; display: string }> = [];
              noiseSelectors.forEach((sel) => {
                el.querySelectorAll(sel).forEach((noise) => {
                  const htmlNoise = noise as any;
                  if (htmlNoise && htmlNoise.style) {
                    const originalDisplay = window.getComputedStyle(htmlNoise).display;
                    htmlNoise.style.setProperty("display", "none", "important");
                    hidden.push({ element: htmlNoise, display: originalDisplay });
                  }
                });
              });
              const textVal = (el as any).innerText || el.textContent || "";
              hidden.forEach((item) => {
                if (item.display === "none") {
                  item.element.style.removeProperty("display");
                } else {
                  item.element.style.display = item.display;
                }
              });
              return textVal;
            })
            .catch(() => ""),
        );
        if (!text) continue;
        result.push({
          ordinal: index,
          domId:
            (await node.getAttribute("id").catch(() => null)) ??
            (await node.getAttribute("data-message-id").catch(() => null)),
          text,
          fingerprint: fingerprint(text),
        });
      }
      return result;
    }
    return [];
  }

  private async hasChallenge(): Promise<boolean> {
    const page = await this.ensurePage();
    const title = await page.title().catch(() => "");
    const structuralSignals = await page
      .locator(
        'iframe[src*="recaptcha"]:visible, iframe[src*="challenges.cloudflare.com"]:visible, #challenge-form:visible',
      )
      .count()
      .catch(() => 0);
    return inferChallengePage({
      url: page.url(),
      title,
      structuralSignals,
    });
  }

  private async ensurePage(navigateIfNeeded = true): Promise<Page> {
    if (!this.context) throw new Error("Gemini adapter is not launched");
    if (this.page && !this.page.isClosed()) return this.page;
    this.page =
      this.context.pages().find((candidate) => !candidate.isClosed()) ??
      (await this.context.newPage());
    if (navigateIfNeeded && !this.page.url().includes("gemini.google.com")) {
      await this.navigateToGemini(this.page);
    }
    return this.page;
  }

  private async hasUserMenu(): Promise<boolean> {
    const page = await this.ensurePage(false);
    const selectors = [
      'a[aria-label*="Google Account" i]',
      'button[aria-label*="Google Account" i]',
      '[aria-label*="Аккаунт Google" i]',
      '[data-test-id="account-menu-button"]',
      '[data-testid="account-menu-button"]',
    ];
    for (const selector of selectors) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  private async hasGoogleAccountSession(): Promise<boolean> {
    if (!this.context) return false;
    const cookies = await this.context
      .cookies([GEMINI_URL])
      .catch(() => []);
    const authenticatedCookieNames = new Set([
      "SID",
      "SAPISID",
      "__Secure-1PSID",
      "__Secure-3PSID",
    ]);
    return cookies.some(
      (cookie) => authenticatedCookieNames.has(cookie.name) && cookie.value.length > 0,
    );
  }

  private async launchAutomatedBrowser(): Promise<void> {
    const executablePath = bundledChromiumExecutable();
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1440, height: 1000 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      args: ["--disable-blink-features=AutomationControlled"],
      ...(executablePath ? { executablePath } : {}),
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(GEMINI_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }

  private async navigateToGemini(page: Page): Promise<void> {
    await page.goto(GEMINI_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const state = await this.waitUntilReady();
    if (state === "UNKNOWN") {
      throw new TurnTimeoutError("Gemini opened but did not become ready within 30 seconds");
    }
  }

  private requireTurn(turn: TurnRef): GeminiTurn {
    const active = this.turns.get(turn.id);
    if (!active) throw new Error(`Unknown Gemini turn: ${turn.id}`);
    return active;
  }

  async deleteConversation(ref: ConversationRef): Promise<boolean> {
    const page = await this.ensurePage();
    if (ref.url) {
      await page.goto(ref.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    const selectors = [
      'button[aria-label*="Delete"]',
      'button[aria-label*="Удалить"]',
    ];
    for (const selector of selectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => undefined);
        return true;
      }
    }
    return false;
  }
}
