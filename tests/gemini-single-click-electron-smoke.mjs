import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase } from "../dist/src/storage/database.js";
import { LocalArtifactStore } from "../dist/src/attachments/artifact-store.js";
import { ResponseArtifactDownloader } from "../dist/src/attachments/artifact-downloader.js";

const root = await mkdtemp(join(tmpdir(), "gplusg-gemini-electron-"));
const body = "G_PLUS_G_INBOUND_FINAL_2026";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;
try {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: root, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  await app.firstWindow();
  const fixtureWindow = app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__artifactFixtureWindow = new BrowserWindow({ show: false });
    void globalThis.__artifactFixtureWindow.loadURL("data:text/html,<section class='turn'><button aria-label='Download'>Download</button></section>");
  });
  const page = await fixtureWindow; await page.waitForLoadState("domcontentloaded");
  await page.route("https://gemini.google.com/download/gplusg-inbound-final.txt", (route) => route.fulfill({
    status: 200, contentType: "text/plain", headers: { "Content-Disposition": 'attachment; filename="gplusg-inbound-final.txt"', "Access-Control-Allow-Origin": "*" }, body,
  }));
  await page.evaluate(() => {
    window.__clicks = 0;
    document.querySelector("button").addEventListener("click", () => {
      window.__clicks += 1;
      fetch("https://gemini.google.com/download/gplusg-inbound-final.txt");
      window.open("about:blank", "_blank");
      const a = document.createElement("a"); a.href = "data:text/plain,empty"; a.download = "empty.txt"; a.click();
    });
  });
  const db = new AppDatabase(":memory:"); db.migrate();
  db.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('fixture','fixture','ACTIVE','x','x')").run();
  const downloader = new ResponseArtifactDownloader(db.raw, new LocalArtifactStore(join(root, "artifacts")), { resolveHostname: async () => ["93.184.216.34"] });
  const options = { projectId: "fixture", messageId: "gemini-turn", providerId: "gemini", expectArtifact: true, downloadEventTimeoutMs: 1000 };
  const first = await downloader.downloadTurnArtifactsFromPage(page, ".turn", options);
  const second = await downloader.downloadTurnArtifactsFromPage(page, ".turn", options);
  const clickCount = await page.evaluate(() => window.__clicks);
  const rows = db.raw.prepare("SELECT status,COUNT(*) count FROM downloaded_artifacts GROUP BY status").all();
  assert(first.length === 1 && first[0].status === "READY", `multi-channel acquisition did not produce READY: ${JSON.stringify(first)}`);
  assert(second[0].id === first[0].id, "repeat acquisition did not return persisted result");
  assert(clickCount === 1, `expected one physical click, got ${clickCount}`);
  assert(rows.length === 1 && rows[0].status === "READY" && rows[0].count === 1, "channel attempts created duplicate records");
  console.log(JSON.stringify({ ok: true, providerTraffic: 0, physicalClicks: clickCount, channels: ["download", "popup", "network response"], records: 1, status: "READY", repeatClick: false }));
  db.close();
} finally {
  await app?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
