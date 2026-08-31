import type { Page } from "playwright";

export type ProviderSurface = "FILE_CARD" | "CODE_BLOCK" | "ARTIFACT_PANEL" | "UNKNOWN";

export interface SurfaceControlEvidence {
  label: string;
  visible: boolean;
  enabled: boolean;
  width: number;
  height: number;
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
}

export interface SurfaceSnapshot {
  at: number;
  surface: ProviderSurface;
  rawControls: number;
  actionable: number;
  controls: SurfaceControlEvidence[];
}

export interface SurfaceObserverDto {
  version: 1;
  first: SurfaceSnapshot | null;
  latest: SurfaceSnapshot | null;
  hoverObserved: boolean;
  focusObserved: boolean;
  expansionClicks: number;
  downloadClicks: number;
}

/**
 * Static browser-only source. Keep this as plain ES2020 JavaScript: Playwright
 * executes it verbatim, so tsx/esbuild cannot inject Node-side helpers such as
 * __name into a serialized callback.
 */
export const SURFACE_OBSERVER_SOURCE = String.raw`(() => {
  "use strict";
  const key = "__gplusgSurfaceEvidence";
  if (window[key]) return window[key];
  const state = {
    version: 1,
    first: null,
    latest: null,
    hoverObserved: false,
    focusObserved: false,
    expansionClicks: 0,
    downloadClicks: 0
  };
  const emit = function () {
    const sink = window.__gplusgSurfaceEvidenceSink;
    if (typeof sink === 'function') void sink(state);
  };
  const controlSelector = 'a[download],button[aria-label*="download" i],button[aria-label*="скач" i],button[title*="download" i],button[title*="скач" i],[role="button"][data-tooltip*="download" i],[role="button"][data-tooltip*="скач" i],[data-test-id*="download" i],[data-testid*="download" i]';
  const containerSelector = 'pre,.code-block,[class*="artifact" i],[data-test-id*="artifact" i],[data-testid*="artifact" i],file-card,[class*="file-card" i]';
  const scan = function () {
    const turns = Array.from(document.querySelectorAll('model-response,[data-message-author-role="model"],.model-response-text,message-content'));
    const turn = turns.length > 0 ? turns[turns.length - 1] : null;
    if (!(turn instanceof HTMLElement)) return;
    const code = turn.querySelector('pre,code,.code-block');
    const panel = turn.querySelector('[data-test-id*="artifact" i],[data-testid*="artifact" i],[class*="artifact" i]');
    const file = turn.querySelector('file-card,[class*="file-card" i],[data-test-id*="file" i]');
    const controls = Array.from(turn.querySelectorAll(controlSelector));
    const details = controls.filter(function (element) { return element instanceof HTMLElement; }).map(function (element) {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        label: element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('data-tooltip') || '',
        visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && style.pointerEvents !== 'none' && bounds.width > 0 && bounds.height > 0,
        enabled: !(element instanceof HTMLButtonElement && element.disabled) && element.getAttribute('aria-disabled') !== 'true',
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents
      };
    });
    const snapshot = {
      at: Date.now(),
      surface: file ? 'FILE_CARD' : panel ? 'ARTIFACT_PANEL' : code ? 'CODE_BLOCK' : 'UNKNOWN',
      rawControls: details.length,
      actionable: details.filter(function (detail) { return detail.visible && detail.enabled; }).length,
      controls: details
    };
    if (state.first === null && details.length > 0) state.first = snapshot;
    state.latest = snapshot;
    emit();
  };
  const observer = new MutationObserver(scan);
  const start = function () {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-disabled'] });
    scan();
  };
  document.addEventListener('mouseover', function (event) {
    const target = event.target;
    if (target instanceof Element && target.closest(containerSelector)) { state.hoverObserved = true; emit(); }
  }, true);
  document.addEventListener('focusin', function (event) {
    const target = event.target;
    if (target instanceof Element && target.closest(containerSelector)) { state.focusObserved = true; emit(); }
  }, true);
  document.addEventListener('click', function (event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(controlSelector)) state.downloadClicks += 1;
    else if (target.closest('button[aria-haspopup="menu"]')) state.expansionClicks += 1;
    emit();
  }, true);
  window[key] = state;
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
  emit();
  return state;
})()`;

export const SURFACE_OBSERVER_READ_SOURCE = "window.__gplusgSurfaceEvidence ?? null";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isControl = (value: unknown): value is SurfaceControlEvidence => {
  if (!isRecord(value)) return false;
  return typeof value.label === "string"
    && typeof value.visible === "boolean"
    && typeof value.enabled === "boolean"
    && typeof value.width === "number"
    && Number.isFinite(value.width)
    && value.width >= 0
    && typeof value.height === "number"
    && Number.isFinite(value.height)
    && value.height >= 0
    && typeof value.display === "string"
    && typeof value.visibility === "string"
    && typeof value.opacity === "string"
    && typeof value.pointerEvents === "string";
};

const isSnapshot = (value: unknown): value is SurfaceSnapshot => {
  if (!isRecord(value)) return false;
  return typeof value.at === "number"
    && Number.isFinite(value.at)
    && ["FILE_CARD", "CODE_BLOCK", "ARTIFACT_PANEL", "UNKNOWN"].includes(String(value.surface))
    && Number.isInteger(value.rawControls)
    && Number(value.rawControls) >= 0
    && Number.isInteger(value.actionable)
    && Number(value.actionable) >= 0
    && Array.isArray(value.controls)
    && value.controls.every(isControl)
    && value.rawControls === value.controls.length
    && Number(value.actionable) <= Number(value.rawControls);
};

export function parseSurfaceObserverDto(value: unknown): SurfaceObserverDto {
  if (!isRecord(value)
    || value.version !== 1
    || !(value.first === null || isSnapshot(value.first))
    || !(value.latest === null || isSnapshot(value.latest))
    || typeof value.hoverObserved !== "boolean"
    || typeof value.focusObserved !== "boolean"
    || !Number.isInteger(value.expansionClicks)
    || Number(value.expansionClicks) < 0
    || !Number.isInteger(value.downloadClicks)
    || Number(value.downloadClicks) < 0) {
    throw new Error("Invalid browser surface observer DTO");
  }
  return value as unknown as SurfaceObserverDto;
}

export async function installSurfaceObserver(page: Page): Promise<SurfaceObserverDto> {
  return parseSurfaceObserverDto(await page.evaluate(SURFACE_OBSERVER_SOURCE));
}

export async function readSurfaceObserver(page: Page): Promise<SurfaceObserverDto> {
  return parseSurfaceObserverDto(await page.evaluate(SURFACE_OBSERVER_READ_SOURCE));
}

export class SurfaceObserverCollector {
  private latest: SurfaceObserverDto | null = null;
  private readonly history: SurfaceObserverDto[] = [];

  accept(value: unknown): void {
    const dto = parseSurfaceObserverDto(value);
    this.latest = structuredClone(dto);
    this.history.push(structuredClone(dto));
  }

  current(): SurfaceObserverDto | null { return this.latest ? structuredClone(this.latest) : null; }
  events(): SurfaceObserverDto[] { return structuredClone(this.history); }
}

export async function installPersistentSurfaceObserver(page: Page): Promise<SurfaceObserverCollector> {
  const collector = new SurfaceObserverCollector();
  await page.exposeBinding("__gplusgSurfaceEvidenceSink", (_source, value: unknown) => collector.accept(value));
  await page.addInitScript({ content: SURFACE_OBSERVER_SOURCE });
  collector.accept(await page.evaluate(SURFACE_OBSERVER_SOURCE));
  return collector;
}

export function assertBrowserObserverSourceSafe(source = SURFACE_OBSERVER_SOURCE): void {
  const forbidden = ["__name", "__async", "process.", "require(", "Buffer", "globalThis.process", "node:"];
  const found = forbidden.filter((needle) => source.includes(needle));
  if (found.length > 0) throw new Error(`Browser observer contains forbidden external helpers: ${found.join(", ")}`);
  if (!source.startsWith("(() => {") || !source.endsWith("})()")) throw new Error("Browser observer must be a static self-contained IIFE");
}
