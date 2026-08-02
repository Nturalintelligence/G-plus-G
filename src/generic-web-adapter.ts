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
import { type ProviderId, PROVIDER_METADATA } from "./settings/settings.js";
import { logEvent } from "./observability/logger.js";

const SELECTORS: Record<
  string,
  {
    composers: string[];
    sendButtons: string[];
    responses: string[];
    userMessages: string[];
    noise: string[];
  }
> = {
  claude: {
    composers: ['[contenteditable="true"]', "div.ProseMirror", "textarea"],
    sendButtons: ['button[aria-label*="Send" i]', "button.styles-module__send___", "button"],
    responses: ["div.font-claude-message", ".claude-message", "div.prose"],
    userMessages: [".user-message", ".chat-message-user"],
    noise: ["button", "svg", ".message-actions"],
  },
  copilot: {
    composers: ["textarea", "#searchbar"],
    sendButtons: ['button[aria-label*="Submit" i]', "button.send-button", "button"],
    responses: ["div.message-content", ".markdown"],
    userMessages: [".user-message", ".chat-message-user"],
    noise: ["button", "svg"],
  },
  perplexity: {
    composers: ['textarea[placeholder*="ask" i]', "textarea"],
    sendButtons: ['button[aria-label*="Submit" i]', "button"],
    responses: ["div.prose", ".markdown"],
    userMessages: [".user-message", ".chat-message-user"],
    noise: ["button", "svg"],
  },
  huggingchat: {
    composers: ['textarea[placeholder*="Ask" i]', "textarea"],
    sendButtons: ['button[type="submit"]', "button"],
    responses: [".prose", ".markdown"],
    userMessages: [".user-message", ".chat-message-user"],
    noise: ["button", "svg"],
  },
  groq: {
    composers: ["textarea"],
    sendButtons: ['button[type="submit"]', "button"],
    responses: [".markdown", "div.prose"],
    userMessages: [".user-message", ".chat-message-user"],
    noise: ["button", "svg"],
  },
  duckduckgo: {
    composers: ["textarea"],
    sendButtons: ['button[type="submit"]', "button"],
    responses: [".markdown", "div.prose"],
    userMessages: [".user-message", ".chat-message-user"],
    noise: ["button", "svg"],
  },
  mistral: {
    composers: ["textarea"],
    sendButtons: ['button[aria-label*="send" i]', "button"],
    responses: [".prose", ".markdown"],
    userMessages: [".user-message", ".chat-message-user"],
    noise: ["button", "svg"],
  },
};

const CHALLENGE_PATTERNS = [
  /captcha/i,
  /verify you are human/i,
  /checking your browser/i,
  /cloudflare/i,
  /unusual activity/i,
  /один момент/i,
];

export class GenericWebAdapter implements ModelAdapter {
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
  private readonly targetUrl: string;
  private readonly config: typeof SELECTORS[string];
  readonly headless: boolean;

  private log(action: string, details: Record<string, unknown> = {}): void {
    const payload = { providerId: this.providerId, action, ...details };
    logEvent("INFO", `generic_web_adapter.${this.providerId}.${action}`, payload);
    console.log(`[${this.providerId}] ${action}`, JSON.stringify(details));
  }

  constructor(
    readonly providerId: ProviderId,
    options: { profileDir?: string; timeoutMs?: number; settleMs?: number; headless?: boolean } = {},
  ) {
    this.profileDir = resolve(options.profileDir ?? dataPath("profiles", providerId));
    this.profileLock = new ProfileLock(this.profileDir);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.settleMs = options.settleMs ?? 2_500;
    this.headless = options.headless ?? true;
    
    const meta = PROVIDER_METADATA[providerId];
    this.targetUrl = meta ? meta.url : "https://google.com/";
    this.config = SELECTORS[providerId] || {
      composers: ["textarea"],
      sendButtons: ["button"],
      responses: [".markdown", "div.prose"],
      userMessages: [".user-message"],
      noise: ["button", "svg"],
    };
  }

  async launch(): Promise<void> {
    this.log("launch.start", { profileDir: this.profileDir });
    await mkdir(this.profileDir, { recursive: true });
    await this.profileLock.acquire();
    try {
      const executablePath = bundledChromiumExecutable();
      this.log("launch.launching_chromium", { executablePath });
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        viewport: { width: 1440, height: 1000 },
        args: ["--disable-blink-features=AutomationControlled"],
        ...(executablePath ? { executablePath } : {}),
      });
      await this.ensurePage();
      this.log("launch.success");
    } catch (error) {
      this.log("launch.error", { error });
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
    if (page.url() !== this.targetUrl) {
      await page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });
    }
    return { id: newId("webchat"), url: page.url() };
  }

  async openConversation(ref: ConversationRef): Promise<void> {
    if (!ref.url.startsWith(this.targetUrl)) {
      throw new Error(`Conversation URL must belong to ${this.targetUrl}`);
    }
    await (await this.ensurePage()).goto(ref.url, { waitUntil: "domcontentloaded" });
  }

  async getCurrentConversation(): Promise<ConversationRef> {
    const page = await this.ensurePage();
    return { id: newId("webchat"), url: page.url() };
  }

  async sendMessage(input: MessageInput): Promise<TurnRef>;
  async sendMessage(input: string): Promise<TurnResult>;
  async sendMessage(input: MessageInput | string): Promise<TurnRef | TurnResult> {
    if (typeof input === "string") return this.sendAndWait(input);

    const ref = { id: newId("webturn") };
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
    active.rejectCancellation(new Error(`${this.providerId} turn cancelled: ${turn.id}`));
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
    const challenge = await this.hasChallenge();
    this.log("checkSession.challenge_check", { challenge });
    if (challenge) return "CHALLENGE_REQUIRED";
    const body = await page.locator("body").innerText().catch(() => "");
    const loginControls = await this.visibleLoginControlCount();
    const composersCount = (await this.findVisibleComposers()).length;
    const state = inferSessionState(
      this.providerId,
      body,
      composersCount,
      loginControls,
    );
    this.log("checkSession.result", { state, composersCount, loginControls });
    return state;
  }

  private async visibleLoginControlCount(): Promise<number> {
    const page = this.requirePage();
    const candidates = [
      page.getByRole("button", { name: /^(log in|sign up|sign in|войти|регистрация)$/i }),
      page.getByRole("link", { name: /^(log in|sign up|sign in|войти|регистрация)$/i }),
    ];
    let count = 0;
    for (const locator of candidates) {
      for (let index = 0; index < (await locator.count()); index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) count += 1;
      }
    }
    return count;
  }

  async waitForManualLogin(): Promise<void> {
    console.log(`Войдите в ${this.providerId} в открытом окне. CLI продолжит работу после появления поля ввода.`);
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
    if (state !== "AUTHENTICATED") throw new LoginRequiredError(`${this.providerId} state: ${state}`);
  }

  private async sendAndWait(message: string, channel?: TurnChannel): Promise<TurnResult> {
    this.log("sendAndWait.start", { messageLength: message.length });
    const page = await this.ensurePage();
    await this.waitUntilReady();
    await this.installMutationObserver();
    const before = await this.captureResponses();
    this.log("sendAndWait.before_snapshots", { count: before.length });
    
    let userMessageCountBefore = 0;
    for (const selector of this.config.userMessages) {
      const cnt = await page.locator(selector).count().catch(() => 0);
      if (cnt > 0) {
        userMessageCountBefore = cnt;
        break;
      }
    }
    this.log("sendAndWait.user_messages_before", { userMessageCountBefore });

    const composer = await this.getUniqueComposer();
    const startedAt = Date.now();

    this.log("sendAndWait.filling_composer");
    await fillComposerSafely(composer, message);
    this.log("sendAndWait.submit_composer");
    await this.submitComposer(composer, message);
    this.log("sendAndWait.wait_until_submitted");
    await this.waitUntilSubmitted(message, userMessageCountBefore);
    channel?.publish({ type: "MESSAGE_SUBMITTED", at: new Date().toISOString() });

    this.log("sendAndWait.wait_for_bound_response");
    const response = await this.waitForBoundResponse(before, channel);
    this.log("sendAndWait.success", { elapsedMs: Date.now() - startedAt, responseLength: response.text.length });
    return {
      response: response.text,
      responseFingerprint: response.fingerprint,
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async waitUntilReady(): Promise<void> {
    this.log("waitUntilReady.start");
    const page = this.requirePage();
    const deadline = Date.now() + 30_000;
    let state: SessionState = "UNKNOWN";

    while (Date.now() < deadline) {
      state = await this.checkSession();
      const composers = await this.findVisibleComposers();
      this.log("waitUntilReady.loop", { state, composersFound: composers.length });
      if (state === "AUTHENTICATED" || composers.length === 1) {
        await this.waitUntilStableResponses();
        this.log("waitUntilReady.stable_ready");
        return;
      }
      if (state === "CHALLENGE_REQUIRED") throw new ChallengeRequiredError();
      if (state === "LOGIN_REQUIRED" && composers.length === 0) {
        throw new LoginRequiredError(`${this.providerId} state: ${state}`);
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
    return this.findVisibleBySelectors(this.config.composers);
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
    for (const selector of this.config.responses) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const snapshots: ResponseSnapshot[] = [];
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const node = locator.nth(ordinal);
        const text = normalizeText(
          await node
            .evaluate((el, noiseSels) => {
              const hidden: Array<{ element: any; display: string }> = [];
              noiseSels.forEach((sel) => {
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
            }, this.config.noise)
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

      for (const selector of this.config.userMessages) {
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

    throw new TurnTimeoutError(`${this.providerId} did not confirm that the user message was submitted`);
  }

  private async submitComposer(composer: Locator, message: string): Promise<void> {
    const buttons = await this.findVisibleBySelectors(this.config.sendButtons);
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

    this.log("waitForBoundResponse.start", { timeoutMs: this.timeoutMs });

    while (Date.now() < deadline) {
      if (await this.hasChallenge()) throw new ChallengeRequiredError();
      const after = await this.captureResponses();
      const selected = selectNewResponse(before, after);

      this.log("waitForBoundResponse.poll", {
        afterCount: after.length,
        selectedFound: !!selected,
        selectedTextLength: selected?.text.length ?? 0,
      });

      if (selected) {
        if (!candidate) {
          this.log("waitForBoundResponse.started");
          channel?.publish({ type: "RESPONSE_STARTED", at: new Date().toISOString() });
        }
        candidate = selected;
        if (selected.text !== stableText) {
          const prevLength = stableText.length;
          stableText = selected.text;
          stableSince = Date.now();
          this.log("waitForBoundResponse.updated", { prevLength, newLength: stableText.length });
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
        const composers = await this.findVisibleComposers();
        const composerReady = composers.length === 1;
        const stableDuration = Date.now() - stableSince;

        this.log("waitForBoundResponse.settle_check", {
          stopVisible,
          composerReady,
          composersFound: composers.length,
          stableDuration,
          settleMs: this.settleMs,
        });

        if (
          !stopVisible &&
          composerReady &&
          stableText &&
          stableDuration >= this.settleMs
        ) {
          this.log("waitForBoundResponse.completed", { finalLength: candidate.text.length });
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
    if (!this.page.url().includes(this.targetUrl)) {
      await this.page.goto(this.targetUrl, { waitUntil: "domcontentloaded" });
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
