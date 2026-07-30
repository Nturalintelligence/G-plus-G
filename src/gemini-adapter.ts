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
import { loginInSystemChrome } from "./browser/system-browser-login.js";
import {
  AmbiguousElementError,
  ChallengeRequiredError,
  LoginRequiredError,
  TurnTimeoutError,
} from "./errors.js";
import { fingerprint, normalizeText, selectNewResponse } from "./fingerprint.js";
import { newId } from "./ids.js";
import type {
  DiagnosticReport,
  ResponseSnapshot,
  SessionState,
  TurnResult,
} from "./types.js";

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
const CHALLENGE = [
  /captcha/i,
  /verify.*human/i,
  /провер.*человек/i,
  /unusual traffic/i,
];

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

  constructor(options: { profileDir?: string; timeoutMs?: number } = {}) {
    this.profileDir = resolve(options.profileDir ?? "user-data/profiles/gemini");
    this.lock = new ProfileLock(this.profileDir);
    this.timeoutMs = options.timeoutMs ?? 180_000;
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
    const page = await this.ensurePage();
    if (await this.hasChallenge()) return "CHALLENGE_REQUIRED";
    const body = await page.locator("body").innerText().catch(() => "");
    if (/sign in|войти/i.test(body)) return "LOGIN_REQUIRED";
    if ((await this.visibleComposers()).length === 1) return "AUTHENTICATED";
    if (/too many requests|rate limit/i.test(body)) return "RATE_LIMITED";
    return "UNKNOWN";
  }

  async openLoginMode(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.page = null;
    await loginInSystemChrome(this.profileDir, GEMINI_URL);
    await this.launchAutomatedBrowser();
    const state = await this.waitUntilReady();
    if (state !== "AUTHENTICATED") {
      throw new LoginRequiredError(
        `Вход Gemini не сохранился в выделенном профиле. Текущее состояние: ${state}`,
      );
    }
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
    await (await this.ensurePage()).goto(ref.url, { waitUntil: "commit" });
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
    yield* this.requireTurn(turn).channel.observe();
  }

  async getFinalResponse(turn: TurnRef): Promise<TurnResult> {
    return this.requireTurn(turn).result;
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

  private async sendAndWait(message: string, channel?: TurnChannel): Promise<TurnResult> {
    const started = Date.now();
    const state = await this.waitUntilReady();
    if (state !== "AUTHENTICATED") throw new LoginRequiredError(`Gemini state: ${state}`);
    const before = await this.responses();
    const candidates = await this.visibleComposers();
    if (candidates.length !== 1) {
      throw new AmbiguousElementError(`Expected one Gemini composer, found ${candidates.length}`);
    }
    await candidates[0]!.fill(message);
    await this.submitComposer(candidates[0]!, message);
    channel?.publish({ type: "MESSAGE_SUBMITTED", at: new Date().toISOString() });

    const response = await this.waitForResponse(before, channel);
    return {
      response: response.text,
      responseFingerprint: response.fingerprint,
      elapsedMs: Date.now() - started,
    };
  }

  private async waitUntilReady(): Promise<SessionState> {
    const deadline = Date.now() + 30_000;
    let state: SessionState = "UNKNOWN";
    while (Date.now() < deadline) {
      state = await this.checkSession();
      if (state !== "UNKNOWN") return state;
      await (await this.ensurePage()).waitForTimeout(500);
    }
    return state;
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
    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();
      const selected = selectNewResponse(before, await this.responses());
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
        if (
          !(await stop.isVisible().catch(() => false)) &&
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
        if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
      }
      if (visible.length > 0) return visible;
    }
    return [];
  }

  private async submitComposer(composer: Locator, message: string): Promise<void> {
    await composer.press("Enter");
    if (await this.composerWasCleared(composer)) {
      await this.waitUntilUserMessage(message);
      return;
    }

    const buttons = await this.visibleBySelectors(SEND_BUTTONS);
    if (buttons.length !== 1) {
      throw new AmbiguousElementError(
        `Gemini message was not submitted by Enter; expected one send button, found ${buttons.length}`,
      );
    }
    await buttons[0]!.click();
    await this.waitUntilUserMessage(message);
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

  private async waitUntilUserMessage(message: string): Promise<void> {
    const expected = normalizeText(message);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const selector of USER_MESSAGES) {
        const nodes = (await this.ensurePage()).locator(selector);
        for (let index = 0; index < (await nodes.count()); index += 1) {
          const text = normalizeText(await nodes.nth(index).innerText().catch(() => ""));
          if (text === expected || text.includes(expected)) return;
        }
      }
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
      if ((await locator.count()) === 0) continue;
      const result: ResponseSnapshot[] = [];
      for (let index = 0; index < (await locator.count()); index += 1) {
        const node = locator.nth(index);
        const text = normalizeText(await node.innerText().catch(() => ""));
        if (!text) continue;
        result.push({
          ordinal: index,
          domId: (await node.getAttribute("id")) ?? (await node.getAttribute("data-message-id")),
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
    const sample = `${await page.title().catch(() => "")}\n${await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "")}`;
    return CHALLENGE.some((pattern) => pattern.test(sample.slice(0, 5_000)));
  }

  private async ensurePage(): Promise<Page> {
    if (!this.context) throw new Error("Gemini adapter is not launched");
    if (this.page && !this.page.isClosed()) return this.page;
    this.page =
      this.context.pages().find((candidate) => !candidate.isClosed()) ??
      (await this.context.newPage());
    if (!this.page.url().includes("gemini.google.com")) {
      await this.navigateToGemini(this.page);
    }
    return this.page;
  }

  private async launchAutomatedBrowser(): Promise<void> {
    const executablePath = bundledChromiumExecutable();
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      viewport: { width: 1440, height: 1000 },
      ...(executablePath ? { executablePath } : {}),
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.navigateToGemini(this.page);
  }

  private async navigateToGemini(page: Page): Promise<void> {
    await page.goto(GEMINI_URL, {
      waitUntil: "commit",
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
}
