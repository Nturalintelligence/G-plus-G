import { _electron as electron } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase } from "../dist/src/storage/database.js";
import { LocalArtifactStore } from "../dist/src/attachments/artifact-store.js";
import { ResponseArtifactDownloader } from "../dist/src/attachments/artifact-downloader.js";

const root = await mkdtemp(join(tmpdir(), "gplusg-settling-electron-")); const body = "G_PLUS_G_INBOUND_FINAL_2026"; let app;
try {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: root, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } }); await app.firstWindow();
  const fixtureWindow = app.waitForEvent("window"); const html = await readFile(resolve("tests/fixtures/gemini-hidden-download-control.html"), "utf8");
  await app.evaluate(({ BrowserWindow }, markup) => { globalThis.__settlingFixture = new BrowserWindow({ show: false }); void globalThis.__settlingFixture.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`); }, html);
  const page = await fixtureWindow; await page.waitForLoadState("domcontentloaded"); let clicks = 0;
  await page.route("https://gemini.google.com/download/gplusg-inbound-final.txt", async (route) => route.fulfill({ status: 200, contentType: "text/plain", headers: { "Content-Disposition": 'attachment; filename="gplusg-inbound-final.txt"' }, body }));
  await page.locator("button").evaluate((button) => button.addEventListener("click", () => { window.__fixtureClicks = (window.__fixtureClicks || 0) + 1; }));
  const db = new AppDatabase(":memory:"); db.migrate(); db.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('p','p','ACTIVE','x','x')").run();
  const downloader = new ResponseArtifactDownloader(db.raw, new LocalArtifactStore(join(root, "artifacts")), { resolveHostname: async () => ["93.184.216.34"] });
  const result = await downloader.downloadTurnArtifactsFromPage(page, ".turn", { projectId: "p", messageId: "turn", providerId: "gemini", expectArtifact: true, downloadEventTimeoutMs: 1500 });
  clicks = await page.evaluate(() => window.__fixtureClicks || 0); const visible = await page.locator("button").isVisible();
  if (result[0]?.status !== "READY" || result[0].sizeBytes !== 27 || clicks !== 1 || !visible) throw new Error(JSON.stringify({ result, clicks, visible }));
  console.log(JSON.stringify({ ok: true, providerTraffic: 0, revealPath: "scroll+hover+bounded-settling", visible, clicks, bytes: result[0].sizeBytes, sha256: result[0].sha256 })); db.close();
} finally { await app?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); }
