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
import { newId } from "./ids.js";
import {
  AmbiguousElementError,
  ChallengeRequiredError,
  LoginRequiredError,
  TurnTimeoutError,
} from "./errors.js";
import { fingerprint, normalizeText, selectNewResponse } from "./fingerprint.js";
import type {
  DiagnosticReport,
  ResponseSnapshot,
  SessionState,
  TurnResult,
} from "./types.js";

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
const CHALLENGE_PATTERNS = [
  /captcha/i,
  /verify you are human/i,
  /checking your browser/i,
  /cloudflare/i,
  /unusual activity/i,
];

export interface AdapterOptions {
  profileDir?: string;
  timeoutMs?: number;
  settleMs?: number;
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

  constructor(options: AdapterOptions = {}) {
    this.profileDir = resolve(options.profileDir ?? "user-data/profiles/chatgpt");
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
    await this.waitForManualLogin();
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
    const automated = this.sendAndWait(input.content, channel);
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
    return this.requireTurn(turn).result;
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
    if (await this.hasChallenge()) return "CHALLENGE_REQUIRED";
    const body = await page.locator("body").innerText().catch(() => "");
    if (/log in|sign up|войти|регистрац/i.test(body)) return "LOGIN_REQUIRED";
    if ((await this.findVisibleComposers()).length === 1) return "AUTHENTICATED";
    return "UNKNOWN";
  }

  async waitForManualLogin(): Promise<void> {
    console.log("Войдите в ChatGPT в открытом окне. CLI продолжит работу после появления поля ввода.");
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
    if (state !== "AUTHENTICATED") throw new LoginRequiredError(`ChatGPT state: ${state}`);
  }

  private async sendAndWait(message: string, channel?: TurnChannel): Promise<TurnResult> {
    const page = await this.ensurePage();
    await this.waitUntilReady();
    await this.installMutationObserver();
    const before = await this.captureResponses();
    const composer = await this.getUniqueComposer();
    const startedAt = Date.now();

    await composer.fill(message);
    await this.submitComposer(composer, message);
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
      if (state === "AUTHENTICATED") return;
      if (state === "CHALLENGE_REQUIRED") throw new ChallengeRequiredError();
      if (state === "LOGIN_REQUIRED") throw new LoginRequiredError(`ChatGPT state: ${state}`);
      await page.waitForTimeout(500);
    }

    await this.assertReady();
  }

  private async findVisibleComposers(): Promise<Locator[]> {
    const page = this.requirePage();
    const matches: Locator[] = [];
    for (const selector of COMPOSER_SELECTORS) {
      const locator = page.locator(selector);
      for (let index = 0; index < (await locator.count()); index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) matches.push(item);
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
      const count = await locator.count();
      if (count === 0) continue;
      const snapshots: ResponseSnapshot[] = [];
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const node = locator.nth(ordinal);
        const text = normalizeText(await node.innerText().catch(() => ""));
        if (!text) continue;
        snapshots.push({
          ordinal,
          domId:
            (await node.getAttribute("data-message-id")) ??
            (await node.getAttribute("id")),
          text,
          fingerprint: fingerprint(text),
        });
      }
      return snapshots;
    }
    return [];
  }

  private async waitUntilSubmitted(message: string): Promise<void> {
    const page = this.requirePage();
    const normalized = normalizeText(message);
    await page.waitForFunction(
      ({ expected }) => {
        const userNodes = Array.from(
          document.querySelectorAll('[data-message-author-role="user"]'),
        );
        return userNodes.some(
          (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim() === expected,
        );
      },
      { expected: normalized },
      { timeout: 30_000 },
    );
  }

  private async submitComposer(composer: Locator, message: string): Promise<void> {
    await composer.press("Enter");
    if (await this.composerWasCleared(composer)) {
      return;
    }

    const buttons = await this.findVisibleBySelectors(SEND_BUTTON_SELECTORS);
    if (buttons.length !== 1) {
      throw new AmbiguousElementError(
        `ChatGPT message was not submitted by Enter; expected one send button, found ${buttons.length}`,
      );
    }
    await buttons[0]!.click();
    if (!(await this.composerWasCleared(composer))) {
      throw new TurnTimeoutError("ChatGPT composer did not clear after submission");
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
          .getByRole("button", { name: /stop generating|остановить создание/i })
          .isVisible()
          .catch(() => false);
        if (!stopVisible && stableText && Date.now() - stableSince >= this.settleMs) {
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
}
