import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
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

export class ChatGptAdapter {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly profileDir: string;
  private readonly timeoutMs: number;
  private readonly settleMs: number;

  constructor(options: AdapterOptions = {}) {
    this.profileDir = resolve(options.profileDir ?? "user-data/profiles/chatgpt");
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.settleMs = options.settleMs ?? 2_500;
  }

  async launch(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      viewport: { width: 1440, height: 1000 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
    this.page =
      this.context.pages().find((candidate) => candidate.url().includes("chatgpt.com")) ??
      this.context.pages()[0] ??
      (await this.context.newPage());
    await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.page = null;
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

  async sendMessage(message: string): Promise<TurnResult> {
    const page = this.requirePage();
    await this.waitUntilReady();
    const before = await this.captureResponses();
    const composer = await this.getUniqueComposer();
    const startedAt = Date.now();

    await composer.fill(message);
    await composer.press("Enter");
    await this.waitUntilSubmitted(message);

    const response = await this.waitForBoundResponse(before);
    return {
      response: response.text,
      responseFingerprint: response.fingerprint,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async diagnostics(): Promise<DiagnosticReport> {
    const page = this.requirePage();
    return {
      timestamp: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      sessionState: await this.checkSession(),
      composerCandidates: (await this.findVisibleComposers()).length,
      assistantResponseCount: (await this.captureResponses()).length,
    };
  }

  private async assertReady(): Promise<void> {
    const state = await this.checkSession();
    if (state === "CHALLENGE_REQUIRED") throw new ChallengeRequiredError();
    if (state !== "AUTHENTICATED") throw new LoginRequiredError(`ChatGPT state: ${state}`);
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

  private async waitForBoundResponse(
    before: readonly ResponseSnapshot[],
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
        candidate = selected;
        if (selected.text !== stableText) {
          stableText = selected.text;
          stableSince = Date.now();
        }
        const stopVisible = await page
          .getByRole("button", { name: /stop generating|остановить создание/i })
          .isVisible()
          .catch(() => false);
        if (!stopVisible && stableText && Date.now() - stableSince >= this.settleMs) {
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
}
