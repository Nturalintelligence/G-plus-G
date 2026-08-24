import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = resolve("release/win-unpacked/G plus G.exe");
const out = resolve("output/playwright/phase-b1-real-gate");
const capture = resolve("tests/capture-native-window.ps1");
const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-phase-b1-real-"));
const results = [];
await mkdir(out, { recursive: true });
let app;

const fixtures = [
  { fileName: "screenshot-1920x1080.png", mimeType: "image/png", width: 1920, height: 1080, seed: 11 },
  { fileName: "screenshot-2560x1440.png", mimeType: "image/png", width: 2560, height: 1440, seed: 23 },
  { fileName: "screenshot-3840x2160.png", mimeType: "image/png", width: 3840, height: 2160, seed: 37 },
  { fileName: "screenshot-vertical-1080x1920.png", mimeType: "image/png", width: 1080, height: 1920, seed: 41 },
  { fileName: "screenshot-ultrawide-3440x1440.png", mimeType: "image/png", width: 3440, height: 1440, seed: 53 },
  { fileName: "photo-normal-2400x1600.jpeg", mimeType: "image/jpeg", width: 2400, height: 1600, seed: 67 },
  { fileName: "screenshot-normal-1920x1080.webp", mimeType: "image/webp", width: 1920, height: 1080, seed: 79 },
];
const assert = (ok, message) => { if (!ok) throw new Error(message); };

async function launch(scale = 1) {
  app = await electron.launch({ executablePath: exe, args: [`--force-device-scale-factor=${scale}`], env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return page;
}
async function setWindow(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(size.width, size.height, false); win.center(); }, { width, height });
}
async function screenshot(name) {
  const path = join(out, name);
  const handle = await app.evaluate(({ BrowserWindow }) => {
    const bytes = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
    return (bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString();
  });
  const json = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", capture, "-WindowHandle", handle, "-OutputPath", path], { encoding: "utf8" }).trim();
  return { path, ...JSON.parse(json) };
}
async function selectProject(page, name) {
  await page.getByText(name, { exact: true }).click();
  await page.getByLabel("Сообщение для моделей").waitFor();
}
async function setTheme(page, theme) {
  await page.evaluate(async (value) => { const s = await window.orchestrator.settings.get(); await window.orchestrator.settings.save({ ...s, appearance: { ...s.appearance, theme: value } }); }, theme);
  await page.reload();
}
async function pasteFixture(page, projectId, spec) {
  await page.getByLabel("Сообщение для моделей").evaluate(async (textarea, f) => {
    const canvas = document.createElement("canvas"); canvas.width = f.width; canvas.height = f.height;
    const c = canvas.getContext("2d");
    const g = c.createLinearGradient(0, 0, canvas.width, canvas.height);
    g.addColorStop(0, `hsl(${f.seed * 3},72%,38%)`); g.addColorStop(.5, `hsl(${f.seed * 5},68%,24%)`); g.addColorStop(1, `hsl(${f.seed * 7},76%,42%)`);
    c.fillStyle = g; c.fillRect(0, 0, canvas.width, canvas.height);
    const unit = Math.max(48, Math.round(Math.min(canvas.width, canvas.height) / 18));
    for (let y = 0; y < canvas.height; y += unit) for (let x = 0; x < canvas.width; x += unit) {
      const hue = (f.seed * 13 + x / unit * 17 + y / unit * 29) % 360;
      c.fillStyle = `hsla(${hue},80%,65%,${(x / unit + y / unit) % 3 === 0 ? .32 : .13})`; c.fillRect(x + 4, y + 4, unit - 8, unit - 8);
    }
    c.lineWidth = Math.max(2, unit / 16); c.strokeStyle = "rgba(255,255,255,.72)"; c.strokeRect(unit, unit, canvas.width - unit * 2, canvas.height - unit * 2);
    c.fillStyle = "white"; c.shadowColor = "rgba(0,0,0,.7)"; c.shadowBlur = 10; c.font = `700 ${Math.max(28, unit * .55)}px Segoe UI`; c.fillText(f.fileName, unit * 1.35, unit * 2.1);
    c.font = `500 ${Math.max(20, unit * .38)}px Segoe UI`; c.fillText(`${f.width} × ${f.height} · детализированный тестовый снимок`, unit * 1.35, unit * 2.75); c.shadowBlur = 0;
    for (let i = 0; i < 12; i += 1) { c.beginPath(); c.fillStyle = `hsl(${(f.seed + i * 31) % 360},85%,62%)`; c.arc(unit * (1.5 + (i % 6) * 2.1), canvas.height - unit * (1.5 + Math.floor(i / 6) * 1.7), unit * .38, 0, Math.PI * 2); c.fill(); }
    const blob = await new Promise((done) => canvas.toBlob(done, f.mimeType, .9));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], f.fileName, { type: f.mimeType }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, spec);
  await page.waitForFunction(async ({ id, fileName }) => (await window.orchestrator.attachments.listDraft(id))?.attachments.some((x) => x.fileName === fileName && x.status === "READY"), { id: projectId, fileName: spec.fileName });
}
async function geometry(page) {
  return page.evaluate(() => {
    const b = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const composer = document.querySelector(".composer-bottom"), strip = document.querySelector(".composer-bottom .attached-files-row");
    const textarea = document.querySelector('.composer-bottom textarea[aria-label="Сообщение для моделей"]'), send = document.querySelector('.composer-bottom [title="Отправить сообщение"]');
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, composer: b(composer), strip: b(strip), textarea: b(textarea), send: b(send), cards: [...document.querySelectorAll(".composer-bottom .attachment-thumbnail")].map((n) => ({ ...b(n), remove: b(n.querySelector(".attachment-thumbnail-remove")) })) };
  });
}
function assertGeometry(g) {
  assert(!g.overflow, `Horizontal overflow: ${JSON.stringify(g)}`);
  assert(g.composer.right <= g.viewport.width + 1 && g.strip.left >= g.composer.left - 1 && g.strip.right <= g.composer.right + 1, "Composer/strip exits viewport");
  assert(g.composer.top >= 0 && g.composer.bottom <= g.viewport.height + 1, `Composer exits viewport vertically: ${JSON.stringify(g.composer)}`);
  assert(g.textarea.top >= 0 && g.textarea.bottom <= g.viewport.height + 1 && g.send.top >= 0 && g.send.bottom <= g.viewport.height + 1, "Textarea/send is not fully visible");
  assert(g.textarea.right <= g.send.left + 1, "Textarea overlaps send");
  for (const card of g.cards) {
    assert(card.width <= 88 && card.height <= 88, `Card exceeds 88x88: ${JSON.stringify(card)}`);
    assert(card.left >= g.strip.left - 1 && card.right <= g.strip.right + 1 && card.top >= g.strip.top - 1 && card.bottom <= g.strip.bottom + 1, "Card exits strip");
    assert(card.remove.left >= card.left && card.remove.right <= card.right && card.remove.top >= card.top && card.remove.bottom <= card.bottom, "Remove exits card");
  }
}

try {
  let page = await launch();
  const projectName = `Phase B.1 real gate ${Date.now()}`;
  await page.getByRole("button", { name: "Новый" }).click(); await page.getByPlaceholder("Например: Мой Салон Красоты").fill(projectName); await page.getByRole("button", { name: "Создать проект" }).click();
  await page.getByText(projectName, { exact: true }).waitFor();
  const projectId = await page.evaluate(async (name) => (await window.orchestrator.projects.list()).find((x) => x.name === name)?.id, projectName);
  assert(projectId, "Project missing");
  const longText = "Проверь вложенные снимки интерфейса без обрезания и изменения исходного разрешения. ".repeat(12);
  await page.getByLabel("Сообщение для моделей").fill(longText);
  for (const fixture of fixtures) await pasteFixture(page, projectId, fixture);
  await page.locator(".attachment-thumbnail").nth(fixtures.length - 1).waitFor();
  const draft = (await page.evaluate((id) => window.orchestrator.attachments.listDraft(id), projectId))?.attachments ?? [];
  console.log("Staged fixtures:", draft.map((item) => ({ fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes, status: item.status })));
  assert(draft.length === fixtures.length, `Expected ${fixtures.length} files, got ${draft.length}`);
  for (const [index, fixture] of fixtures.entries()) {
    const item = draft[index]; assert(item?.sizeBytes > 20_000, `${fixture.fileName} is too small (${item?.sizeBytes})`);
    const natural = await page.evaluate((url) => new Promise((done, fail) => { const i = new Image(); i.onload = () => done({ width: i.naturalWidth, height: i.naturalHeight }); i.onerror = fail; i.src = url; }), item.previewUrl);
    assert(natural.width === fixture.width && natural.height === fixture.height, `${fixture.fileName} was rescaled`); fixture.sizeBytes = item.sizeBytes; fixture.stagedFileName = item.fileName;
  }

  await app.close(); app = undefined;
  const db = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  const insert = db.prepare("INSERT INTO conversation_entries (id, project_id, run_id, role, provider_id, round, content, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)");
  insert.run("visual-user", projectId, "USER", null, null, longText, "2026-08-24T10:00:00.000Z");
  const answer = "Полный длинный ответ модели сохраняет абзацы, переносы и всю хронологию без визуального обрезания. ".repeat(80);
  for (let round = 1; round <= 7; round += 1) insert.run(`visual-turn-${round}`, projectId, "ASSISTANT", round % 2 ? "chatgpt" : "gemini", round, `${answer}\n\nРаунд ${round}: причина продолжения — требуется взаимная проверка вывода.`, `2026-08-24T10:0${round}:00.000Z`);
  insert.run("visual-final", projectId, "ASSISTANT", "final", 8, "Итоговый ответ остаётся видимым отдельно от полного обсуждения.", "2026-08-24T10:08:00.000Z"); db.close();

  for (const scale of [1, 1.25, 1.5]) {
    page = await launch(scale);
    const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()); assert(Math.abs(zoom - 1) < .001, `Zoom is ${zoom}`);
    for (const theme of ["light", "dark"]) {
      await setTheme(page, theme); await selectProject(page, projectName);
      for (const [width, height] of [[1280, 720], [1366, 768], [1920, 1080]]) {
        await setWindow(width, height); await page.waitForTimeout(250); const g = await geometry(page); assertGeometry(g); assert(Math.abs(g.viewport.dpr - scale) < .15, `DPR ${g.viewport.dpr} != ${scale}`);
        const shot = await screenshot(`composer-${theme}-${width}x${height}-scale-${Math.round(scale * 100)}.png`);
        results.push({ scenario: "composer", theme, window: `${width}x${height}`, zoomFactor: zoom, windowsScale: `${Math.round(scale * 100)}%`, source: "7 detailed originals", sourceDimensions: fixtures.map((x) => `${x.width}x${x.height}`).join(", "), fileSizeBytes: fixtures.reduce((n, x) => n + x.sizeBytes, 0), screenshot: shot.path, status: "PASS" });
      }
    }
    await app.close(); app = undefined;
  }

  page = await launch(); await setTheme(page, "dark"); await selectProject(page, projectName); await setWindow(1366, 768);
  const thumbs = page.locator(".attachment-thumbnail");
  const before = await thumbs.evaluateAll((nodes) => nodes.map((n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top }; }));
  await thumbs.nth(3).locator(".attachment-thumbnail-remove").click(); await page.waitForFunction((count) => document.querySelectorAll(".attachment-thumbnail").length === count, fixtures.length - 1);
  const after = await thumbs.evaluateAll((nodes) => nodes.map((n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top }; }));
  assert(after[3].left === before[3].left && after[3].top === before[3].top, "No reflow after middle removal"); assertGeometry(await geometry(page));
  let shot = await screenshot("composer-remove-middle-dark-1366x768.png"); results.push({ scenario: "remove-middle", theme: "dark", window: "1366x768", zoomFactor: 1, windowsScale: "100%", source: fixtures[3].fileName, sourceDimensions: `${fixtures[3].width}x${fixtures[3].height}`, fileSizeBytes: fixtures[3].sizeBytes, screenshot: shot.path, status: "PASS" });

  await thumbs.first().locator(".attachment-thumbnail-open").click(); const modal = page.locator(".image-preview-modal-card"); await modal.waitFor();
  const mg = await page.evaluate(() => { const r = document.querySelector(".image-preview-modal-card").getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight }; });
  assert(mg.width <= mg.vw * .9 + 2 && mg.height <= mg.vh * .9 + 2 && mg.left >= 0 && mg.top >= 0 && mg.right <= mg.vw && mg.bottom <= mg.vh, `Bad modal: ${JSON.stringify(mg)}`);
  shot = await screenshot("preview-open-1920x1080-dark-1366x768.png"); results.push({ scenario: "preview-open", theme: "dark", window: "1366x768", zoomFactor: 1, windowsScale: "100%", source: fixtures[0].fileName, sourceDimensions: "1920x1080", fileSizeBytes: fixtures[0].sizeBytes, screenshot: shot.path, status: "PASS" });
  await page.keyboard.press("Escape"); await modal.waitFor({ state: "hidden" }); await thumbs.first().locator(".attachment-thumbnail-open").click(); await page.locator(".image-preview-backdrop").click({ position: { x: 5, y: 5 } }); await modal.waitFor({ state: "hidden" }); await thumbs.first().locator(".attachment-thumbnail-open").click(); await page.getByLabel("Закрыть просмотр").click(); await modal.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: /Показать ход обсуждения/ }).click(); let discussion = page.getByLabel("Ход обсуждения моделей"); await discussion.waitFor(); assert(await discussion.locator(".discussion-turn").count() === 7, "Drawer lost turns");
  shot = await screenshot("discussion-right-drawer-long-russian-dark.png"); results.push({ scenario: "right-drawer", theme: "dark", window: "1366x768", zoomFactor: 1, windowsScale: "100%", source: "7 long Russian turns", sourceDimensions: "n/a", fileSizeBytes: 0, screenshot: shot.path, status: "PASS" });
  await page.getByLabel("Вернуться к итоговому ответу").click(); await page.evaluate(async () => { const s = await window.orchestrator.settings.get(); await window.orchestrator.settings.save({ ...s, appearance: { ...s.appearance, discussionView: "FULLSCREEN" } }); });
  await page.reload(); await selectProject(page, projectName); await page.getByRole("button", { name: /Показать ход обсуждения/ }).click(); discussion = page.getByLabel("Ход обсуждения моделей"); await discussion.waitFor();
  shot = await screenshot("discussion-fullscreen-long-russian-dark.png"); results.push({ scenario: "fullscreen", theme: "dark", window: "1366x768", zoomFactor: 1, windowsScale: "100%", source: "7 long Russian turns", sourceDimensions: "n/a", fileSizeBytes: 0, screenshot: shot.path, status: "PASS" });
  await setWindow(700, 760); await page.waitForTimeout(200); const narrow = await discussion.boundingBox(); assert(narrow?.width >= 690, "Narrow view is not fullscreen");
  shot = await screenshot("discussion-narrow-700x760-dark.png"); results.push({ scenario: "narrow-fullscreen", theme: "dark", window: "700x760", zoomFactor: 1, windowsScale: "100%", source: "7 long Russian turns", sourceDimensions: "n/a", fileSizeBytes: 0, screenshot: shot.path, status: "PASS" });

  const reportPath = join(out, "visual-gate-report.json"); await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), fixtures, results }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, screenshots: results.length, fixtures: fixtures.length, report: reportPath }, null, 2));
} finally {
  await app?.close().catch(() => undefined); await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
