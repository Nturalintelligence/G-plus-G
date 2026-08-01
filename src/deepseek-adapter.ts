import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type {
  ConversationRef,
  MessageInput,
  ModelAdapter,
  RecoveryResult,
  TurnEvent,
  TurnRef,
} from "./adapters/adapter-contract.js";
import { TurnChannel } from "./adapters/turn-channel.js";
import { ProfileLock } from "./browser/profile-lock.js";
import { bundledChromiumExecutable } from "./browser/runtime.js";
import { dataPath } from "./paths.js";
import { inferSessionState } from "./adapters/session-inference.js";
import { newId } from "./ids.js";
import {
  AmbiguousElementError,
  ChallengeRequiredError,
  LoginRequiredError,
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

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const RESPONSE_SELECTORS = [
  ".ds-markdown",
  ".ds-markdown--html",
  ".chat-message-assistant",
];
const COMPOSER_SELECTORS = [
  "#chat-input",
  "textarea[placeholder*=\"message\" i]",
  "textarea[placeholder*=\"deepseek\" i]",
  "textarea[placeholder*=\"спроси\" i]",
  "textarea",
];
const SEND_BUTTON_SELECTORS = [
  ".ds-textarea-send-button",
  "button[aria-label*=\"send\" i]",
  ".chat-input-send-button",
];
const USER_MESSAGE_SELECTORS = [
  ".chat-message-user",
  "div.user-query",
  ".user-message",
];
const CHALLENGE_PATTERNS = [
  /captcha/i,
  /verify you are human/i,
  /checking your browser/i,
  /cloudflare/i,
  /unusual activity/i,
  /один момент/i,
];

export class DeepSeekAdapter implements ModelAdapter {
  readonly providerId = "deepseek";
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly turns = new Map<string, {
    channel: TurnChannel;
    result: Promise<TurnResult>;
    resolveManual: (response: string) => void;
    rejectCancellation: (error: Error) => void;
  }>();
  private readonly profileDir: string;
  private readonly profileLock: ProfileLock;
  private readonly timeoutMs: number;
  private readonly settleMs: number;

  constructor(options: { profileDir?: string; timeoutMs?: number; settleMs?: number } = {}) {
    this.profileDir = resolve(options.profileDir ?? dataPath("profiles", "deepseek"));
    this.profileLock = new ProfileLock(this.profileDir);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.settleMs = options.settleMs ?? 2_500;
  }

  async launch(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    await this.profileLock.acquire();
    try {
      const executablePath = bundledChromiumExecutable();
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false,
        viewport: { width: 1440, height: 1000 },
        args: ["--disable-blink-features=AutomationControlled"],
        ...(executablePath ? { executablePath } : {}),
      });
      await this.ensurePage();
    } catch (error) {
      await this.profileLock.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } finally {
      this.context = null;
      this.page = null;
      await this.profileLock.release();
    }
  }

  async openLoginMode(): Promise<void> {
    await this.waitForManualLogin();
  }

  async createConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    if (page.url() !== DEEPSEEK_URL) {
      await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
    }
    return { id: newId("dschat"), url: page.url() };
  }

  async openConversation(ref: ConversationRef): Promise<void> {
    if (!ref.url.startsWith(DEEPSEEK_URL)) {
      throw new Error("Conversation URL must belong to chat.deepseek.com");
    }
    await (await this.ensurePage()).goto(ref.url, { waitUntil: "domcontentloaded" });
  }

  async getCurrentConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    return { id: newId("dschat"), url: page.url() };
  }

  async sendMessage(input: MessageInput): Promise<TurnRef>;
  async sendMessage(input: string): Promise<TurnResult>;
  async sendMessage(input: MessageInput | string): Promise<TurnRef | TurnResult> {
    if (typeof input === "string") return this.sendAndWait(input);

    const ref = { id: newId("dsturn") };
    const channel = new TurnChannel();
    let resolveManual: (response: string) => void = () => undefined;
    let rejectCancellation: (error: Error) => void = () => undefined;
    const manual = new Promise<string>((resolveManualPromise) => {
      resolveManual = resolveManualPromise;
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });

    const result = Promise.race([
      this.sendAndWait(input.content, channel),
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
      const stop = page.locator("button:has-text(\"Stop\"), button:has-text(\"Остановить\")");
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => undefined);
    }
    active.channel.publish({ type: "CANCELLED", at: new Date().toISOString() });
    active.rejectCancellation(new Error(`DeepSeek turn cancelled: ${turn.id}`));
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

  private requireTurn(turn: TurnRef) {
    const active = this.turns.get(turn.id);
    if (!active) throw new Error(`Unknown turn: ${turn.id}`);
    return active;
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
    if (await this.hasChallenge()) return "CHALLENGE_REQUIRED";
    const body = await page.locator("body").innerText().catch(() => "");
    const loginControls = await this.visibleLoginControlCount();
    return inferSessionState(
      "deepseek",
      body,
      (await this.findVisibleComposers()).length,
      loginControls,
    );
  }

  private async visibleLoginControlCount(): Promise<number> {
    const page = this.requirePage();
    const candidates = [
      page.getByRole("button", { name: /^(log in|sign up|войти|регистрация)$/i }),
      page.getByRole("link", { name: /^(log in|sign up|войти|регистрация)$/i }),
    ];
    let count = 0;
    for (const locator of candidates) {
      for (let index = 0; index < (await locator.count().catch(() => 0)); index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) count += 1;
      }
    }
    return count;
  }

  async waitForManualLogin(): Promise<void> {
    console.log("Войдите в DeepSeek в открытом окне. CLI продолжит работу после появления поля ввода.");
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const state = await this.checkSession();
      if (state === "CHALLENGE_REQUIRED") {
        console.log("Обнаружена проверка. Решите её вручную в браузере.");
      }
      if (state === "AUTHENTICATED") return;
      await this.requirePage().waitForTimeout(1_000);
    }
    throw new TurnTimeoutError("Поле ввода не появилось за 10 минут");
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
    if (state !== "AUTHENTICATED") throw new LoginRequiredError(`DeepSeek state: ${state}`);
  }

  private async sendAndWait(message: string, channel?: TurnChannel): Promise<TurnResult> {
    const page = await this.ensurePage();
    await this.waitUntilReady();
    await this.installMutationObserver();
    const before = await this.captureResponses();
    
    let userMessageCountBefore = 0;
    for (const selector of USER_MESSAGE_SELECTORS) {
      const cnt = await page.locator(selector).count().catch(() => 0);
      if (cnt > 0) {
        userMessageCountBefore = cnt;
        break;
      }
    }

    const composer = await this.getUniqueComposer();
    const startedAt = Date.now();

    await fillComposerSafely(composer, message);
    await this.submitComposer(composer, message);
    await this.waitUntilSubmitted(message, userMessageCountBefore);
    channel?.publish({ type: "MESSAGE_SUBMITTED", at: new Date().toISOString() });

    const response = await this.waitForBoundResponse(before, channel);
    return {
      response: response.text,
      responseFingerprint: response.fingerprint,
      elapsedMs: Date.now() - startedAt,
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
        throw new LoginRequiredError(`DeepSeek state: ${state}`);
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
    return this.findVisibleBySelectors(COMPOSER_SELECTORS);
  }

  private async findVisibleBySelectors(selectors: readonly string[]): Promise<Locator[]> {
    const page = this.requirePage();
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const visible: Locator[] = [];
      for (let index = 0; index < (await locator.count().catch(() => 0)); index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
      }
      if (visible.length > 0) return visible;
    }
    return [];
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

  private async waitUntilSubmitted(
    message: string,
    userMessageCountBefore: number,
  ): Promise<void> {
    const page = this.requirePage();
    const normalized = normalizeText(message);
    const expectedPrefix = normalized.slice(0, 100);
    const expectedSuffix = normalized.slice(-100);
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();

      for (const selector of USER_MESSAGE_SELECTORS) {
        const currentCount = await page.locator(selector).count().catch(() => 0);
        if (currentCount > userMessageCountBefore) return;

        const userNodes = page.locator(selector);
        const count = await userNodes.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const text = normalizeText(await userNodes.nth(i).innerText().catch(() => ""));
          if (normalized.length > 200) {
            if (text.includes(expectedPrefix) || text.includes(expectedSuffix)) {
              return;
            }
          } else {
            if (text.includes(normalized)) {
              return;
            }
          }
        }
      }

      await page.waitForTimeout(250);
    }

    const responses = await this.captureResponses();
    if (responses.length > 0) return;

    throw new TurnTimeoutError("DeepSeek did not confirm that the user message was submitted");
  }

  private async submitComposer(composer: Locator, message: string): Promise<void> {
    const buttons = await this.findVisibleBySelectors(SEND_BUTTON_SELECTORS);
    if (buttons.length === 1) {
      await buttons[0]!.click();
    } else {
      await composer.press("Enter");
    }
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

    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();
      const after = await this.captureResponses();
      const selected = selectNewResponse(before, after);

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
          .locator("button:has-text(\"Stop\"), button:has-text(\"Остановить\")")
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
    const body = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const sample = `${title}\n${body.slice(0, 5_000)}`;
    return CHALLENGE_PATTERNS.some((pattern) => pattern.test(sample));
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Adapter is not launched");
    return this.page;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.context) throw new Error("Adapter is not launched");
    if (this.page && !this.page.isClosed()) return this.page;
    this.page =
      this.context.pages().find((candidate) => !candidate.isClosed()) ??
      (await this.context.newPage());
    if (!this.page.url().includes("deepseek.com")) {
      await this.page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
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
}
