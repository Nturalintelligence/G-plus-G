import { resolve } from "node:path";
import { chromium } from "playwright";
import { bundledChromiumExecutable } from "../src/browser/runtime.js";

const provider = process.argv[2];
const url = process.argv[3];
const root = process.env.G_PLUS_G_USER_DATA;
if (!root || !url || (provider !== "chatgpt" && provider !== "gemini")) throw new Error("provider, URL and G_PLUS_G_USER_DATA are required");
const context = await chromium.launchPersistentContext(resolve(root, "profiles", provider), { headless: true, executablePath: bundledChromiumExecutable() });
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  const evidence = await page.locator("body").evaluate((body) => ({
    buttons: [...body.querySelectorAll("button")].filter((node) => (node as HTMLElement).offsetParent).map((node) => ({ text: node.textContent?.trim().slice(0, 120), aria: node.getAttribute("aria-label"), testid: node.getAttribute("data-testid") })).slice(-80),
    links: [...body.querySelectorAll("a[href]")].map((node) => ({ text: node.textContent?.trim().slice(0, 120), aria: node.getAttribute("aria-label"), href: node.getAttribute("href"), download: node.hasAttribute("download") })).slice(-80),
    images: [...body.querySelectorAll("img")].filter((node) => (node as HTMLElement).offsetParent).map((node) => ({ alt: node.alt, src: node.currentSrc || node.src, width: node.naturalWidth, height: node.naturalHeight })).slice(-40),
    text: (body.textContent ?? "").slice(-4_000),
  }));
  console.log(JSON.stringify({ url: page.url(), evidence }, null, 2));
} finally {
  await context.close();
}
