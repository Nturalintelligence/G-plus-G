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
import { isStableChatGptConversationUrl, preserveChatGptConversationRef } from "./adapters/chatgpt-conversation-ref.js";
import type { AttachmentRefV1 } from "./attachments/attachments.js";
import { TurnChannel } from "./adapters/turn-channel.js";
import { ProfileLock } from "./browser/profile-lock.js";
import { bundledChromiumExecutable } from "./browser/runtime.js";
import { dataPath } from "./paths.js";
import { inferSessionState } from "./adapters/session-inference.js";
import { inferChallengePage } from "./adapters/challenge-inference.js";
import {
  canFinalizeManualLogin,
  hasPendingExternalLoginPage,
} from "./adapters/manual-login.js";
import { newId } from "./ids.js";
import {
  AmbiguousElementError,
  ChallengeRequiredError,
  ConversationUnavailableError,
  LoginCancelledError,
  LoginRequiredError,
  LoginTimeoutError,
  TurnTimeoutError,
} from "./errors.js";
import { fingerprint, normalizeText, selectNewResponse } from "./fingerprint.js";
import { fillComposerSafely } from "./adapters/dom-utils.js";
import type {
  DiagnosticReport,
  ResponseSnapshot,
  SessionState,
  TurnResult,
} from "./types.js";
import { logEvent } from "./observability/logger.js";
import { uploadAttachmentsToComposer } from "./adapters/provider-attachment-upload.js";
import { classifyProviderResult, ProviderResultProgress } from "./adapters/provider-result-state.js";
import { selectComposerIndex } from "./adapters/composer-selection.js";
import { classifyChatGptSubmissionEvidence, type SubmissionEvidenceDecision, type UserTurnEvidence } from "./adapters/chatgpt-submission-evidence.js";

const CHATGPT_URL = "https://chatgpt.com/";
const RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  'article:has([data-message-author-role="assistant"])',
];
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="composer-input"]',
  'div.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="сообщ"]',
  'div[contenteditable="true"][role="textbox"]',
  'form textarea',
  'form [contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="Отправ" i]',
  'form button[type="submit"]',
];
export const CHATGPT_UPLOAD_SELECTORS = {
  providerId: "chatgpt",
  fileInputs: ['input[type="file"]'],
  attachmentButtons: ['button[aria-label*="Attach" i]', 'button[aria-label*="Прикреп" i]', 'button[data-testid="attach-button"]'],
  attachmentEvidence: [
    'form [role="group"][aria-label]',
    '[data-testid="composer-attachment"]',
    'form [data-testid*="attachment" i]',
    'form button[aria-label*="remove file" i]',
    'form button[aria-label*="remove attachment" i]',
    'form button[aria-label*="Удалить файл"]',
    'form button[aria-label*="удалить влож" i]',
    'form [class*="attachment" i]',
  ],
  uploadBusy: ['[aria-label*="uploading" i]', '[aria-label*="загруз" i][aria-busy="true"]', '[role="progressbar"]'],
  uploadErrors: ['[data-testid*="attachment-error" i]', '[role="alert"]:has-text("upload")', '[role="alert"]:has-text("загруз")'],
} as const;
export interface AdapterOptions {
  profileDir?: string;
  timeoutMs?: number;
  settleMs?: number;
  headless?: boolean;
  artifactDatabase?: DatabaseSync;
}

interface ActiveTurn {
  channel: TurnChannel;
  result: Promise<TurnResult>;
  resolveManual: (response: string) => void;
  rejectCancellation: (error: Error) => void;
}

export class ChatGptAdapter implements ModelAdapter {
  readonly providerId = "chatgpt";
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly profileDir: string;
  private readonly profileLock: ProfileLock;
  private readonly timeoutMs: number;
  private readonly settleMs: number;
  private readonly headless: boolean;
  private readonly artifactDatabase: DatabaseSync | undefined;
  private lastSubmissionEvidence: SubmissionEvidenceDecision | undefined;
  private stableConversationUrl: string | null = null;

  constructor(options: AdapterOptions = {}) {
    this.profileDir = resolve(options.profileDir ?? dataPath("profiles", "chatgpt"));
    this.profileLock = new ProfileLock(this.profileDir);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.settleMs = options.settleMs ?? 2_500;
    this.headless = options.headless ?? true;
    this.artifactDatabase = options.artifactDatabase;
  }

  async launch(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    await this.profileLock.acquire();
    try {
      const executablePath = bundledChromiumExecutable();
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        viewport: { width: 1440, height: 1000 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        args: ["--disable-blink-features=AutomationControlled"],
        ...(executablePath ? { executablePath } : {}),
      });
    } catch (error) {
      await this.profileLock.release();
      throw error;
    }
    this.page =
      this.context.pages().find((candidate) => candidate.url().includes("chatgpt.com")) ??
      this.context.pages()[0] ??
      (await this.context.newPage());
    await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
      this.context = null;
      this.page = null;
    } finally {
      await this.profileLock.release();
    }
  }

  async openLoginMode(): Promise<void> {
    const page = await this.ensurePage();
    if (!page.url().includes("chatgpt.com")) {
      await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    }
    const state = await this.waitForManualLogin();
    if (state !== "AUTHENTICATED") {
      throw new LoginRequiredError(`Авторизация ChatGPT не подтверждена. Статус: ${state}`);
    }
  }

  async createConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    return { id: newId("webchat"), url: page.url() };
  }

  async openConversation(ref: ConversationRef): Promise<void> {
    if (!isStableChatGptConversationUrl(ref.url)) {
      throw new Error("Conversation URL must belong to chatgpt.com");
    }
    const page = await this.ensurePage();
    await page.goto(ref.url, { waitUntil: "domcontentloaded" });
    const expectedPath = new URL(ref.url).pathname;
    const deadline = Date.now() + 8_000;
    let available = false;
    while (Date.now() < deadline) {
      available = new URL(page.url()).pathname === expectedPath && (await this.findVisibleComposers()).length === 1;
      if (available) break;
      await page.waitForTimeout(250);
    }
    if (!available) throw new ConversationUnavailableError("Сохранённый диалог ChatGPT удалён или недоступен");
    this.stableConversationUrl = preserveChatGptConversationRef(this.stableConversationUrl, page.url());
  }

  async getCurrentConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    await page.waitForURL(
      (url) => url.hostname === "chatgpt.com" && url.pathname.includes("/c/"),
      { timeout: 5_000 },
    );
    this.stableConversationUrl = preserveChatGptConversationRef(this.stableConversationUrl, page.url());
    if (!this.stableConversationUrl) throw new ConversationUnavailableError("ChatGPT conversation URL is not stable");
    return { id: newId("webchat"), url: this.stableConversationUrl };
  }

  public getCapabilities(): ProviderAttachmentCapabilities {
    return {
      supportsUpload: true,
      acceptedMimeTypes: ["image/*", "text/*", "application/pdf", "application/json"],
      acceptedExtensions: [".png", ".jpg", ".jpeg", ".webp", ".pdf", ".txt", ".md", ".json", ".csv"],
      maxFileBytes: 52_428_800,
      maxFilesPerMessage: 10,
      supportsImages: true,
      supportsMultipleFiles: true,
      supportsResponseArtifacts: true,
    };
  }

  async sendMessage(input: MessageInput): Promise<TurnRef>;
  async sendMessage(input: string): Promise<TurnResult>;
  async sendMessage(input: MessageInput | string): Promise<TurnRef | TurnResult> {
    if (typeof input === "string") return this.sendAndWait(input);
    const ref: TurnRef = { id: newId("webturn") };
    const channel = new TurnChannel();
    let manualResolver: (response: string) => void = () => undefined;
    let rejectCancellation: (error: Error) => void = () => undefined;
    const manual = new Promise<string>((resolve) => {
      manualResolver = resolve;
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const automated = this.sendAndWait(input.content, input.attachments, channel, input.responseArtifactTarget);
    const result = Promise.race([
      automated,
      cancellation,
      manual.then((response) => ({
        response,
        responseFingerprint: fingerprint(response),
        elapsedMs: 0,
      })),
    ]).finally(() => channel.finish());
    this.turns.set(ref.id, {
      channel,
      result,
      resolveManual: manualResolver,
      rejectCancellation,
    });
    return ref;
  }

  async *observeTurn(turn: TurnRef): AsyncIterable<TurnEvent> {
    const active = this.requireTurn(turn);
    yield* active.channel.observe();
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
      const stop = page.getByRole("button", {
        name: /stop generating|остановить создание/i,
      });
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => undefined);
    }
    active.channel.publish({ type: "CANCELLED", at: new Date().toISOString() });
    active.rejectCancellation(new Error(`ChatGPT turn cancelled: ${turn.id}`));
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
      conversation: { id: newId("recovered"), url: page.url() },
    };
  }

  async collectDiagnostics(): Promise<DiagnosticReport> {
    return this.diagnostics();
  }

  async checkSession(): Promise<SessionState> {
    const page = this.requirePage();
    const body = await page.locator("body").innerText().catch(() => "");
    const loginControls = await this.visibleLoginControlCount();
    const userMenu = await this.hasUserMenu();
    const composers = (await this.findVisibleComposers()).length;
    const challenge = userMenu ? false : await this.hasChallenge();

    return inferSessionState(
      "chatgpt",
      body,
      composers,
      loginControls,
      {
        hasUserMenu: userMenu,
        hasChallenge: challenge,
        url: page.url(),
      },
    );
  }

  private async hasUserMenu(): Promise<boolean> {
    const page = this.requirePage();
    const selectors = [
      '[data-testid="user-menu"]',
      '[data-testid="profile-button"]',
      '[data-testid="accounts-profile-button"]',
      '[data-testid*="user-menu" i]',
      'button[aria-label*="profile" i]',
      'button[aria-label*="профил" i]',
      'button[aria-label*="user menu" i]',
    ];
    for (const selector of selectors) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  private async visibleLoginControlCount(): Promise<number> {
    const page = this.requirePage();
    const candidates = [
      page.getByRole("button", { name: /^(log in|sign up|войти|регистрация)$/i }),
      page.getByRole("link", { name: /^(log in|sign up|войти|регистрация)$/i }),
    ];
    let count = 0;
    for (const locator of candidates) {
      for (let index = 0; index < (await locator.count()); index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) count += 1;
      }
    }
    return count;
  }

  async waitForManualLogin(): Promise<SessionState> {
    console.log("Войдите в ChatGPT в открытом окне.");
    const deadline = Date.now() + 10 * 60_000;
    let consecutiveAuthCount = 0;

    while (Date.now() < deadline) {
      const active = this.getActivePage();
      if (!active || active.isClosed()) {
        const remaining = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
        if (remaining.length === 0) {
          throw new LoginCancelledError("Пользователь закрыл окно браузера до завершения входа");
        }
      }

      const state = await this.checkSession().catch(() => "UNKNOWN" as SessionState);
      const openPageUrls = this.context?.pages()
        .filter((candidate) => !candidate.isClosed())
        .map((candidate) => candidate.url()) ?? [];
      const canFinalize = canFinalizeManualLogin({
        session: state,
        hasExplicitAccountControl: await this.hasUserMenu().catch(() => false),
        hasPendingExternalPage: hasPendingExternalLoginPage("chatgpt", openPageUrls),
      });
      if (canFinalize) {
        consecutiveAuthCount += 1;
        if (consecutiveAuthCount >= 4) {
          return "AUTHENTICATED";
        }
      } else {
        consecutiveAuthCount = 0;
      }

      const current = this.getActivePage();
      if (!current || current.isClosed()) {
        const remaining = this.context?.pages().filter((p) => !p.isClosed()) ?? [];
        if (remaining.length === 0) {
          throw new LoginCancelledError("Пользователь закрыл окно браузера до завершения входа");
        }
      } else {
        await current.waitForTimeout(500).catch(() => undefined);
      }
    }

    throw new LoginTimeoutError("Время ожидания входа истекло (10 минут)");
  }

  async diagnostics(): Promise<DiagnosticReport> {
    const page = await this.ensurePage();
    return {
      timestamp: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      sessionState: await this.checkSession(),
      composerCandidates: (await this.findVisibleComposers()).length,
      assistantResponseCount: (await this.captureResponses()).length,
      mutationCount: await page
        .evaluate(() => Number((window as unknown as { __orchestratorMutationCount?: number }).__orchestratorMutationCount ?? 0))
        .catch(() => 0),
      ...(this.lastSubmissionEvidence ? { submissionEvidence: { level: this.lastSubmissionEvidence.level, signals: this.lastSubmissionEvidence.signals } } : {}),
    };
  }

  private async assertReady(): Promise<void> {
    const state = await this.checkSession();
    if (state === "CHALLENGE_REQUIRED") throw new ChallengeRequiredError();
    if (state !== "AUTHENTICATED") throw new LoginRequiredError(`ChatGPT state: ${state}`);
    const composers = await this.findVisibleComposers();
    if (composers.length !== 1) {
      throw new AmbiguousElementError(`Expected one authenticated ChatGPT composer, found ${composers.length}`);
    }
  }

  private async sendAndWait(message: string, attachments?: AttachmentRefV1[], channel?: TurnChannel, responseTarget?: { projectId: string; messageId: string }): Promise<TurnResult> {
    const page = await this.ensurePage();
    await this.waitUntilReady();
    await this.installMutationObserver();

    if (attachments && attachments.length > 0) {
      const evidence = await uploadAttachmentsToComposer(page, attachments, this.getCapabilities(), CHATGPT_UPLOAD_SELECTORS);
      channel?.publish({ type: "ATTACHMENTS_UPLOADED", at: evidence.confirmedAt, attachmentIds: evidence.attachmentIds });
    }

    const before = await this.captureResponses();
    const userMessagesBefore = await this.captureUserTurns();
    const assistantCountBefore = before.length;
    const conversationBefore = this.conversationKey(page.url());
    const composer = await this.getUniqueComposer();
    const startedAt = Date.now();

    await fillComposerSafely(composer, message);
    await this.submitComposer(composer, message);
    await this.waitUntilSubmitted(message, attachments ?? [], userMessagesBefore, composer, assistantCountBefore, conversationBefore);
    channel?.publish({ type: "MESSAGE_SUBMITTED", at: new Date().toISOString() });

    const response = await this.waitForBoundResponse(before, channel);

    const extractedArtifacts = [];

    try {
      const downloader = this.artifactDatabase ? new ResponseArtifactDownloader(this.artifactDatabase) : null;
      if (downloader && responseTarget) {
        extractedArtifacts.push(...await downloader.downloadTurnArtifactsFromPage(page, '[data-message-author-role="assistant"]', {
          projectId: responseTarget.projectId,
          messageId: responseTarget.messageId,
          providerId: this.providerId,
          expectArtifact: true,
        }));
      }
    } catch {
      // Best-effort artifact scan
    }

    return {
      response: response.text,
      responseFingerprint: response.fingerprint,
      elapsedMs: Date.now() - startedAt,
      artifacts: extractedArtifacts,
      links: [],
    };
  }

  private async waitUntilReady(): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + 30_000;
    let state: SessionState = "UNKNOWN";

    while (Date.now() < deadline) {
      state = await this.checkSession();
      if (state === "AUTHENTICATED") {
        await this.waitUntilStableResponses();
        return;
      }
      if (state === "CHALLENGE_REQUIRED") throw new ChallengeRequiredError();
      if (state === "LOGIN_REQUIRED") {
        throw new LoginRequiredError(`ChatGPT state: ${state}`);
      }
      await page.waitForTimeout(500);
    }

    await this.assertReady();
  }

  private async waitUntilStableResponses(): Promise<void> {
    const page = this.requirePage();
    let lastCount = -1;
    let stableSince = Date.now();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const currentCount = (await this.captureResponses()).length;
      if (currentCount !== lastCount) {
        lastCount = currentCount;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1_000) {
        break;
      }
      await page.waitForTimeout(200);
    }
  }

  private async findVisibleComposers(): Promise<Locator[]> {
    const page = this.requirePage();
    const matches: Locator[] = [];
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector);
      for (let index = 0; index < (await locator.count()); index += 1) {
        const item = locator.nth(index);
        const usable =
          (await item.isVisible().catch(() => false)) &&
          (await item.isEditable().catch(() => false));
        if (usable) matches.push(item);
      }
      if (matches.length > 0) break;
    }
    return matches;
  }

  private async getUniqueComposer(): Promise<Locator> {
    const candidates = await this.findVisibleComposers();
    const states = await Promise.all(candidates.map((candidate) => candidate.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const control = element as HTMLInputElement;
      return {
        visible: rect.width > 0 && rect.height > 0,
        editable: element instanceof HTMLTextAreaElement || element.getAttribute("contenteditable") === "true",
        enabled: !control.disabled && element.getAttribute("aria-disabled") !== "true",
        active: element === document.activeElement || element.contains(document.activeElement),
        bottom: rect.bottom,
      };
    }).catch(() => ({ visible: false, editable: false, enabled: false, active: false, bottom: 0 }))));
    const selected = selectComposerIndex(states);
    if (selected !== null) return candidates[selected]!;
    const generation = await this.requirePage().getByRole("button", { name: /stop generating|остановить создание/i }).isVisible().catch(() => false);
    if (generation) throw new TurnTimeoutError("ChatGPT ещё генерирует результат; поле ввода временно недоступно");
    throw new AmbiguousElementError("Поле ввода ChatGPT не найдено или перекрыто; возможно, интерфейс провайдера изменился");
  }

  public async rescanResponseArtifacts(target: { projectId: string; messageId: string }) {
    if (!this.artifactDatabase) throw new Error("Artifact database is unavailable");
    const page = await this.ensurePage();
    await this.waitUntilReady();
    return new ResponseArtifactDownloader(this.artifactDatabase).downloadTurnArtifactsFromPage(
      page, '[data-message-author-role="assistant"]', { ...target, providerId: this.providerId, expectArtifact: true },
    );
  }

  private async captureResponses(): Promise<ResponseSnapshot[]> {
    const page = this.requirePage();
    for (const selector of RESPONSE_SELECTORS) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const snapshots: ResponseSnapshot[] = [];
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const node = locator.nth(ordinal);
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
        snapshots.push({
          ordinal,
          domId:
            (await node.getAttribute("data-message-id").catch(() => null)) ??
            (await node.getAttribute("id").catch(() => null)),
          text,
          fingerprint: fingerprint(text),
        });
      }
      return snapshots;
    }
    return [];
  }

  private async captureUserTurns(): Promise<UserTurnEvidence[]> {
    const selectors = [
      '[data-message-author-role="user"]',
      'article:has([data-message-author-role="user"])',
      '[data-testid^="conversation-turn"]:has([data-message-author-role="user"])',
    ];
    for (const selector of selectors) {
      const nodes = this.requirePage().locator(selector);
      const count = await nodes.count().catch(() => 0);
      if (count === 0) continue;
      const turns: UserTurnEvidence[] = [];
      for (let index = 0; index < count; index += 1) {
        const node = nodes.nth(index);
        const id = (await node.getAttribute("data-message-id").catch(() => null)) ?? (await node.getAttribute("id").catch(() => null));
        const text = normalizeText(await node.innerText().catch(() => ""));
        if (id || text) turns.push({ key: id ? `id:${id}` : `text:${fingerprint(text)}`, text });
      }
      if (turns.length > 0) return turns;
    }
    return [];
  }

  private async waitUntilSubmitted(
    message: string,
    attachments: readonly AttachmentRefV1[],
    userMessagesBefore: readonly UserTurnEvidence[],
    composer: Locator,
    assistantCountBefore: number,
    conversationBefore: string,
  ): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + 30_000;
    const baselineTurnKeys = new Set(userMessagesBefore.map((turn) => turn.key));

    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();

      const generationStarted = await page.locator('[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Останов" i]').first().isVisible().catch(() => false);
      const currentTurns = await this.captureUserTurns();
      const decision = classifyChatGptSubmissionEvidence({
        expectedMessage: message,
        expectedFileNames: attachments.map((attachment) => attachment.fileName),
        baselineTurnKeys,
        currentTurns,
        composerCleared: await this.composerWasCleared(composer, 0),
        generationStarted,
        assistantCountIncreased: (await this.captureResponses()).length > assistantCountBefore,
        conversationChanged: this.conversationKey(page.url()) !== conversationBefore,
        uploadCompleted: attachments.length === 0 || attachments.every((attachment) => attachment.status !== "FAILED" && attachment.status !== "QUARANTINED"),
      });
      this.lastSubmissionEvidence = decision;
      if (decision.level === "STRONG_CONFIRMED") return;

      await page.waitForTimeout(250);
    }

    throw new TurnTimeoutError(`ChatGPT submission evidence is ${this.lastSubmissionEvidence?.level ?? "UNKNOWN"}; read-only reconciliation is required`);
  }

  private conversationKey(url: string): string {
    try { return new URL(url).pathname; } catch { return ""; }
  }

  private async submitComposer(composer: Locator, message: string): Promise<void> {
    // ChatGPT may treat Enter as a newline after a reactive composer update.
    // Prefer the explicit enabled submit control and use Enter only when the
    // control is genuinely absent. waitUntilSubmitted() remains the authority
    // that proves the message reached the conversation.
    const deadline = Date.now() + 5_000;
    let buttons: Locator[] = [];
    while (Date.now() < deadline) {
      buttons = await this.findVisibleEnabledBySelectors(SEND_BUTTON_SELECTORS);
      if (buttons.length > 0) break;
      await this.requirePage().waitForTimeout(150);
    }
    if (buttons.length === 1) {
      await buttons[0]!.click();
      return;
    }
    if (buttons.length > 1) {
      throw new AmbiguousElementError(
        `Expected one enabled ChatGPT send button, found ${buttons.length}`,
      );
    }
    await composer.focus();
    await composer.press("Enter");
  }

  private async composerWasCleared(composer: Locator, waitMs = 3_000): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    let checked = false;
    while (Date.now() < deadline) {
      checked = true;
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
      await this.requirePage().waitForTimeout(150);
    }
    if (!checked) {
      const text = normalizeText(await composer.evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : (element.textContent ?? "")).catch(() => ""));
      return !text;
    }
    return false;
  }

  private async findVisibleBySelectors(selectors: readonly string[]): Promise<Locator[]> {
    const page = this.requirePage();
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

  private async findVisibleEnabledBySelectors(
    selectors: readonly string[],
  ): Promise<Locator[]> {
    const page = this.requirePage();
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const usable: Locator[] = [];
      for (let index = 0; index < (await locator.count()); index += 1) {
        const candidate = locator.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await candidate.isEnabled().catch(() => false))
        ) {
          usable.push(candidate);
        }
      }
      if (usable.length > 0) return usable;
    }
    return [];
  }

  private async waitForBoundResponse(
    before: readonly ResponseSnapshot[],
    channel?: TurnChannel,
  ): Promise<ResponseSnapshot> {
    const page = this.requirePage();
    const deadline = Date.now() + this.timeoutMs;
    let candidate: ResponseSnapshot | null = null;
    let stableText = "";
    let stableSince = 0;
    const startedAt = Date.now();
    const lifecycle = new ProviderResultProgress(startedAt, this.timeoutMs);
    let nextUiTraceAt = startedAt + 10_000;
    let lastRecoveryAt = 0;
    let recoveryAttempts = 0;

    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();
      const after = await this.captureResponses();
      const selected = selectNewResponse(before, after);
      const resultState = classifyProviderResult({
        generationActive: await page.getByRole("button", { name: /stop generating|остановить создание/i }).isVisible().catch(() => false),
        selectionCount: await page.locator('[role="dialog"] button:has(img), [data-testid*="image" i] button:has(img)').count().catch(() => 0),
        responsePresent: Boolean(selected),
        downloadControlCount: await page.locator('[data-message-author-role="assistant"]:last-of-type a[download], [data-message-author-role="assistant"]:last-of-type button[aria-label*="download" i], [data-message-author-role="assistant"]:last-of-type button[aria-label*="Скач"]').count().catch(() => 0),
        failureVisible: await page.locator('[role="alert"]:visible').filter({ hasText: /generation failed|не удалось создать|ошибка генерации/i }).count().then((count) => count > 0).catch(() => false),
      });
      if (lifecycle.update(resultState, Date.now()) && resultState !== "SUBMITTED") {
        channel?.publish({ type: resultState, at: new Date().toISOString() });
      }

      if (Date.now() >= nextUiTraceAt) {
        await this.logResponseUiState(before.length, after.length, Date.now() - startedAt);
        nextUiTraceAt = Date.now() + 10_000;
      }

      if (
        !selected &&
        Date.now() - startedAt >= 15_000 &&
        Date.now() - lastRecoveryAt >= 30_000 &&
        recoveryAttempts < 3
      ) {
        const retry = page.getByRole("button", {
          name: /^(try again|retry|regenerate|continue generating|попробовать снова|повторить|продолжить генерацию)$/i,
        });
        const candidates: Locator[] = [];
        for (let index = 0; index < (await retry.count().catch(() => 0)); index += 1) {
          const candidateButton = retry.nth(index);
          if (
            (await candidateButton.isVisible().catch(() => false)) &&
            (await candidateButton.isEnabled().catch(() => false))
          ) {
            candidates.push(candidateButton);
          }
        }
        if (candidates.length === 1) {
          recoveryAttempts += 1;
          lastRecoveryAt = Date.now();
          logEvent("WARN", "chatgpt.response.recovery_clicked", {
            recoveryAttempts,
            elapsedMs: Date.now() - startedAt,
          });
          await candidates[0]!.click();
        }
      }

      if (selected) {
        if (!candidate) {
          channel?.publish({ type: "RESPONSE_STARTED", at: new Date().toISOString() });
        }
        candidate = selected;
        if (selected.text !== stableText) {
          stableText = selected.text;
          stableSince = Date.now();
          channel?.publish({
            type: "RESPONSE_UPDATED",
            at: new Date().toISOString(),
            text: selected.text,
          });
        }
        const stopVisible = await page
          .getByRole("button", { name: /stop generating|остановить создание/i })
          .isVisible()
          .catch(() => false);
        const composerReady = (await this.findVisibleComposers()).length >= 1;
        const artifactReady = lifecycle.current() === "DOWNLOAD_AVAILABLE";
        if (
          !stopVisible &&
          (composerReady || artifactReady) &&
          stableText &&
          Date.now() - stableSince >= this.settleMs
        ) {
          channel?.publish({
            type: "RESPONSE_COMPLETED",
            at: new Date().toISOString(),
            text: candidate.text,
          });
          return candidate;
        }
      }
      await page.waitForTimeout(500);
    }
    throw new TurnTimeoutError(
      `No uniquely bound completed response appeared within ${this.timeoutMs} ms`,
    );
  }

  private async hasChallenge(): Promise<boolean> {
    const page = this.requirePage();
    const title = await page.title().catch(() => "");
    const structuralSignals = await page
      .locator(
        'iframe[src*="challenges.cloudflare.com"]:visible, iframe[src*="recaptcha"]:visible, .cf-challenge-running:visible, #challenge-form:visible',
      )
      .count()
      .catch(() => 0);
    return inferChallengePage({
      url: page.url(),
      title,
      structuralSignals,
    });
  }

  private async logResponseUiState(
    beforeCount: number,
    afterCount: number,
    elapsedMs: number,
  ): Promise<void> {
    const page = this.requirePage();
    const buttons = await page
      .locator("button:visible")
      .evaluateAll((nodes) =>
        nodes.slice(-20).map((node) => ({
          ariaLabel: node.getAttribute("aria-label"),
          testId: node.getAttribute("data-testid"),
          title: node.getAttribute("title"),
          disabled: (node as HTMLButtonElement).disabled,
        })),
      )
      .catch(() => []);
    const notices = await page
      .locator('[role="alert"]:visible, [role="status"]:visible')
      .allInnerTexts()
      .then((values) => values.slice(-5).map((value) => value.slice(0, 240)))
      .catch(() => []);
    logEvent("INFO", "chatgpt.response.ui_state", {
      elapsedMs,
      beforeCount,
      afterCount,
      composerCount: (await this.findVisibleComposers()).length,
      buttons,
      notices,
    });
  }

  private getActivePage(): Page | null {
    if (!this.context) return null;
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (pages.length === 0) return null;
    const chatgptPage = [...pages].reverse().find((p) => p.url().includes("chatgpt.com"));
    return chatgptPage ?? pages[pages.length - 1] ?? null;
  }

  private requirePage(): Page {
    const page = this.getActivePage() ?? this.page;
    if (!page || page.isClosed()) throw new Error("Browser page is not initialized or has been closed");
    this.page = page;
    return page;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.context) throw new Error("Adapter is not launched");
    const active = this.getActivePage();
    if (active) {
      this.page = active;
      return active;
    }
    this.page = await this.context.newPage();
    if (!this.page.url().includes("chatgpt.com")) {
      await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    }
    return this.page;
  }

  private async installMutationObserver(): Promise<void> {
    const page = await this.ensurePage();
    await page.evaluate(() => {
      const state = window as unknown as {
        __orchestratorMutationObserver?: MutationObserver;
        __orchestratorMutationCount?: number;
      };
      if (state.__orchestratorMutationObserver) return;
      state.__orchestratorMutationCount = 0;
      state.__orchestratorMutationObserver = new MutationObserver((records) => {
        state.__orchestratorMutationCount =
          (state.__orchestratorMutationCount ?? 0) + records.length;
      });
      state.__orchestratorMutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  }

  private requireTurn(turn: TurnRef): ActiveTurn {
    const active = this.turns.get(turn.id);
    if (!active) throw new Error(`Unknown turn: ${turn.id}`);
    return active;
  }

  async deleteConversation(ref: ConversationRef): Promise<boolean> {
    const page = await this.ensurePage();
    if (ref.url) {
      await page.goto(ref.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    const selectors = [
      'button[aria-label*="Delete"]',
      'button:has-text("Delete")',
      '[data-testid="delete-chat-button"]',
    ];
    for (const selector of selectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => undefined);
        const confirmBtn = page.locator('button.btn-danger, button[aria-label*="Confirm"], button:has-text("Delete")').first();
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click().catch(() => undefined);
          return true;
        }
      }
    }
    return false;
  }
}
