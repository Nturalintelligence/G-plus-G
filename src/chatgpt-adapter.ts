import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type {
  ConversationRef,
  MessageInput,
  ModelAdapter,
  ProviderAttachmentCapabilities,
  RecoveryResult,
  TurnEvent,
  TurnRef,
} from "./adapters/adapter-contract.js";
import { LocalArtifactStore } from "./attachments/artifact-store.js";
import { ResponseArtifactDownloader } from "./attachments/artifact-downloader.js";
import type { AttachmentRefV1 } from "./attachments/attachments.js";
import { prepareProviderUpload, uploadFilesAndVerifyAcceptance } from "./attachments/provider-upload.js";
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
export interface AdapterOptions {
  profileDir?: string;
  timeoutMs?: number;
  settleMs?: number;
  headless?: boolean;
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

  constructor(options: AdapterOptions = {}) {
    this.profileDir = resolve(options.profileDir ?? dataPath("profiles", "chatgpt"));
    this.profileLock = new ProfileLock(this.profileDir);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.settleMs = options.settleMs ?? 2_500;
    this.headless = options.headless ?? true;
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
    if (!ref.url.startsWith("https://chatgpt.com/")) {
      throw new Error("Conversation URL must belong to chatgpt.com");
    }
    await (await this.ensurePage()).goto(ref.url, { waitUntil: "domcontentloaded" });
  }

  async getCurrentConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    await page.waitForURL(
      (url) => url.hostname === "chatgpt.com" && url.pathname.includes("/c/"),
      { timeout: 5_000 },
    );
    return { id: newId("webchat"), url: page.url() };
  }

  public getCapabilities(): ProviderAttachmentCapabilities {
    return {
      supportsUpload: true,
      acceptedMimeTypes: ["image/*", "text/*", "application/pdf", "application/json"],
      acceptedExtensions: [".png", ".jpg", ".jpeg", ".pdf", ".txt", ".md", ".json", ".csv"],
      maxFileBytes: 52_428_800,
      maxFilesPerMessage: 10,
      supportsImages: true,
      supportsMultipleFiles: true,
      supportsResponseArtifacts: true,
      verifiedAt: new Date().toISOString(),
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
    const automated = this.sendAndWait(input.content, input.attachments, channel);
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
    const challenge = userMenu || composers >= 1 ? false : await this.hasChallenge();

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
      'button[aria-label*="Profile"]',
      'button[aria-label*="Профиль"]',
      'button[aria-label*="User"]',
      'button[aria-label*="Open profile menu" i]',
      'button[aria-label*="Account" i]',
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
        if (consecutiveAuthCount >= 2) {
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
    };
  }

  private async assertReady(): Promise<void> {
    const state = await this.checkSession();
    if (state === "CHALLENGE_REQUIRED") throw new ChallengeRequiredError();
    const composers = await this.findVisibleComposers();
    if (composers.length === 1) return; // Usable
    if (state !== "AUTHENTICATED") throw new LoginRequiredError(`ChatGPT state: ${state}`);
  }

  private async sendAndWait(message: string, attachments?: AttachmentRefV1[], channel?: TurnChannel): Promise<TurnResult> {
    const page = await this.ensurePage();
    await this.waitUntilReady();
    await this.installMutationObserver();

    if (attachments && attachments.length > 0) {
      const upload = prepareProviderUpload(attachments, this.getCapabilities(), new LocalArtifactStore());
      let fileInput = page.locator('input[type="file"]');
      if ((await fileInput.count().catch(() => 0)) === 0) {
        const attachButtons = page.locator('button[aria-label*="Attach"], button[aria-label*="Прикрепить"], button[data-testid="attach-button"]:visible');
        if ((await attachButtons.count()) !== 1) {
          throw new Error("ChatGPT attachment control is unavailable or ambiguous");
        }
        await attachButtons.click();
        await page.waitForTimeout(300);
        fileInput = page.locator('input[type="file"]');
      }
      await uploadFilesAndVerifyAcceptance(page, fileInput, upload.paths, upload.fileNames, "ChatGPT");
    }

    const before = await this.captureResponses();
    const userMessagesBefore = await this.captureUserMessageSignatures();
    const composer = await this.getUniqueComposer();
    const startedAt = Date.now();

    await fillComposerSafely(composer, message);
    await this.submitComposer(composer, message);
    await this.waitUntilSubmitted(userMessagesBefore);
    channel?.publish({ type: "MESSAGE_SUBMITTED", at: new Date().toISOString() });

    const response = await this.waitForBoundResponse(before, channel);

    const extractedArtifacts: AttachmentRefV1[] = [];
    const extractedLinks: Array<{ label: string; url: string; downloadable: boolean }> = [];

    try {
      const downloader = new ResponseArtifactDownloader({ prepare: () => ({ run: () => undefined }) } as any);
      const items = await downloader.extractTurnArtifactsFromPage(page, '[data-message-author-role="assistant"]');
      for (const item of items) {
        extractedLinks.push({ label: item.label, url: item.url, downloadable: !item.isImage });
      }
    } catch {
      // Best-effort artifact scan
    }

    return {
      response: response.text,
      responseFingerprint: response.fingerprint,
      elapsedMs: Date.now() - startedAt,
      artifacts: extractedArtifacts,
      links: extractedLinks,
    };
  }

  private async waitUntilReady(): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + 30_000;
    let state: SessionState = "UNKNOWN";

    while (Date.now() < deadline) {
      state = await this.checkSession();
      const composers = await this.findVisibleComposers();
      if (state === "AUTHENTICATED" || composers.length === 1) {
        await this.waitUntilStableResponses();
        return;
      }
      if (state === "CHALLENGE_REQUIRED") throw new ChallengeRequiredError();
      if (state === "LOGIN_REQUIRED" && composers.length === 0) {
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
    if (candidates.length !== 1) {
      throw new AmbiguousElementError(
        `Expected exactly one visible composer, found ${candidates.length}`,
      );
    }
    return candidates[0]!;
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

  private async captureUserMessageSignatures(): Promise<Set<string>> {
    const nodes = this.requirePage().locator('[data-message-author-role="user"]');
    const signatures = new Set<string>();
    for (let index = 0; index < (await nodes.count().catch(() => 0)); index += 1) {
      const node = nodes.nth(index);
      const id =
        (await node.getAttribute("data-message-id").catch(() => null)) ??
        (await node.getAttribute("id").catch(() => null));
      const text = normalizeText(await node.innerText().catch(() => ""));
      if (id || text) signatures.add(id ? `id:${id}` : `text:${fingerprint(text)}`);
    }
    return signatures;
  }

  private async waitUntilSubmitted(
    userMessagesBefore: ReadonlySet<string>,
  ): Promise<void> {
    const page = this.requirePage();
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();

      const current = await this.captureUserMessageSignatures();
      if ([...current].some((signature) => !userMessagesBefore.has(signature))) return;

      await page.waitForTimeout(250);
    }

    throw new TurnTimeoutError("ChatGPT did not confirm that the user message was submitted");
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
      await this.requirePage().waitForTimeout(150);
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
    let nextUiTraceAt = startedAt + 10_000;
    let lastRecoveryAt = 0;
    let recoveryAttempts = 0;

    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();
      const after = await this.captureResponses();
      const selected = selectNewResponse(before, after);

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
        const composerReady = (await this.findVisibleComposers()).length === 1;
        if (
          !stopVisible &&
          composerReady &&
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
