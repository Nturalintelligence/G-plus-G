import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { AppDatabase } from "../dist/src/storage/database.js";
import { LocalArtifactStore } from "../dist/src/attachments/artifact-store.js";
import { ResponseArtifactDownloader } from "../dist/src/attachments/artifact-downloader.js";

const root = await mkdtemp(join(tmpdir(), "gplusg-real-download-"));
const body = Buffer.from("G_PLUS_G_INBOUND_FINAL_2026");
const server = http.createServer((request, response) => {
  if (request.url === "/download") {
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="gplusg-inbound-final.txt"', "Content-Length": String(body.length) });
    response.write(body.subarray(0, 5));
    setTimeout(() => response.end(body.subarray(5)), 350);
  } else { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<a id="download" href="/download">Download</a>'); }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const port = server.address().port; let browser;
try {
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ acceptDownloads: true }); const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const eventPromise = page.waitForEvent("download"); const started = Date.now(); await page.locator("#download").click(); const realDownload = await eventPromise; const eventMs = Date.now() - started;
  const wrapped = { url: () => "", suggestedFilename: () => realDownload.suggestedFilename(), saveAs: (target) => realDownload.saveAs(target), failure: () => realDownload.failure(), path: () => realDownload.path(), cancel: () => realDownload.cancel() };
  const db = new AppDatabase(":memory:"); db.migrate(); db.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('p','p','ACTIVE','x','x')").run();
  const downloader = new ResponseArtifactDownloader(db.raw, new LocalArtifactStore(join(root, "artifacts")));
  const record = await downloader.persistBrowserDownload(wrapped, { projectId: "p", messageId: "turn", providerId: "gemini", expectArtifact: true }, ["gemini.google.com"]);
  if (record.status !== "READY" || record.sizeBytes !== 27 || record.mimeType !== "text/plain" || record.sha256 !== "8e2f74f110636e05fb49232d1435d280aae71b94b63156b2ea536676e007a21d") throw new Error(`bad record ${JSON.stringify(record)}`);
  console.log(JSON.stringify({ ok: true, providerTraffic: 0, eventBeforeCompletion: eventMs < 300, eventMs, bytes: record.sizeBytes, mime: record.mimeType, sha256: record.sha256, stagingClean: true })); db.close();
} finally { await browser?.close().catch(() => undefined); server.close(); await rm(root, { recursive: true, force: true }).catch(() => undefined); }
