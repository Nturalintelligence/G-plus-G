import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  { fileName: "user-regression-screenshot.png", mimeType: "image/png", width: 1912, height: 1199, fixturePath: resolve("tests/fixtures/user-regression-screenshot.png") },
  { fileName: "screenshot-1920x1080.png", mimeType: "image/png", width: 1920, height: 1080, seed: 11 },
  { fileName: "screenshot-3840x2160.png", mimeType: "image/png", width: 3840, height: 2160, seed: 37 },
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
  const before = (await page.evaluate((id) => window.orchestrator.attachments.listDraft(id), projectId))?.attachments.length ?? 0;
  const base64 = spec.fixturePath ? (await readFile(spec.fixturePath)).toString("base64") : await page.evaluate(async (f) => {
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
    return canvas.toDataURL(f.mimeType, .9).split(",")[1];
  }, spec);
  await app.evaluate(({ clipboard, nativeImage }, bytes) => clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(bytes, "base64"))), base64);
  const textarea = page.getByLabel("Сообщение для моделей");
  await textarea.focus();
  await page.keyboard.press("Control+V");
  await page.waitForFunction(async ({ id, count }) => ((await window.orchestrator.attachments.listDraft(id))?.attachments.length ?? 0) === count + 1, { id: projectId, count: before });
}
async function geometry(page) {
  return page.evaluate(() => {
    const b = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const composer = document.querySelector(".composer-bottom"), strip = document.querySelector(".composer-bottom .attached-files-row");
    const textarea = document.querySelector('.composer-bottom textarea[aria-label="Сообщение для моделей"]'), send = document.querySelector('.composer-bottom [title="Отправить сообщение"]');
    const attachmentImages = [...document.querySelectorAll('img[src^="attachment-preview:"]')];
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, composer: b(composer), strip: b(strip), textarea: b(textarea), send: b(send), attachmentImages: attachmentImages.map((n) => ({ ...b(n), inThumbnail: Boolean(n.closest(".attachment-thumbnail")), inTranscriptCard: Boolean(n.closest(".message-attachment-card")), inModal: Boolean(n.closest(".image-preview-backdrop")) })), cards: [...document.querySelectorAll(".composer-bottom .attachment-card")].map((n) => ({ ...b(n), kind: n.classList.contains("attachment-image-card") ? "image" : "document", remove: b(n.querySelector(".attachment-remove")) })) };
  });
}
function assertGeometry(g, allowWrap = false) {
  assert(!g.overflow && g.scrollWidth <= g.clientWidth, `Horizontal overflow: ${JSON.stringify(g)}`);
  assert(g.composer.right <= g.viewport.width + 1 && g.strip.left >= g.composer.left - 1 && g.strip.right <= g.composer.right + 1, "Composer/strip exits viewport");
  assert(g.composer.top >= 0 && g.composer.bottom <= g.viewport.height + 1, `Composer exits viewport vertically: ${JSON.stringify(g.composer)}`);
  assert(g.textarea.top >= 0 && g.textarea.bottom <= g.viewport.height + 1 && g.send.top >= 0 && g.send.bottom <= g.viewport.height + 1, "Textarea/send is not fully visible");
  assert(g.textarea.right <= g.send.left + 1, "Textarea overlaps send");
  assert(g.strip.height <= (allowWrap ? 168 : 88), `Attachment strip exceeds its bound: ${g.strip.height}`);
  const composerImages = g.attachmentImages.filter((image) => image.inThumbnail);
  assert(composerImages.length === g.cards.filter((card) => card.kind === "image").length, `Composer image/card mismatch: ${JSON.stringify(g.attachmentImages)}`);
  assert(g.attachmentImages.every((image) => (image.inThumbnail || image.inTranscriptCard) && !image.inModal && image.width <= 72 && image.height <= 72), `Closed DOM contains an inline original: ${JSON.stringify(g.attachmentImages)}`);
  for (const card of g.cards) {
    if (card.kind === "image") assert(card.width === 72 && card.height === 72, `Image card must be exactly 72x72: ${JSON.stringify(card)}`);
    else assert(card.width <= 320 && card.height >= 58, `Document card is outside its fixed bounds: ${JSON.stringify(card)}`);
    assert(card.left >= g.strip.left - 1 && card.right <= g.strip.right + 1 && card.top >= g.strip.top - 1 && card.bottom <= g.strip.bottom + 1, "Card exits strip");
    assert(card.remove.width === 24 && card.remove.height === 24, `Remove must be exactly 24x24: ${JSON.stringify(card.remove)}`);
    assert(Math.abs(card.remove.left - (card.right - 28)) < .01 && Math.abs(card.remove.top - (card.top + 4)) < .01, `Remove offset must be top/right 4px: ${JSON.stringify(card)}`);
    assert(card.remove.left >= card.left && card.remove.right <= card.right && card.remove.top >= card.top && card.remove.bottom <= card.bottom, "Remove exits card");
  }
  if (allowWrap) assert(new Set(g.cards.map((card) => card.top)).size >= 2, `Mixed cards did not wrap: ${JSON.stringify(g.cards)}`);
  for (let index = 0; index < g.cards.length; index += 1) for (let neighbor = index + 1; neighbor < g.cards.length; neighbor += 1) {
    const a = g.cards[index].remove, b = g.cards[neighbor];
    assert(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom, `Remove intersects neighboring card: ${JSON.stringify({ remove: a, neighbor: b })}`);
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
        results.push({ scenario: "composer-closed", theme, window: `${width}x${height}`, zoomFactor: zoom, windowsScale: `${Math.round(scale * 100)}%`, effectiveWindowDpi: shot.Dpi, source: "3 fullscreen screenshots via Ctrl+V", sourceDimensions: fixtures.map((x) => `${x.width}x${x.height}`).join(", "), fileSizeBytes: fixtures.reduce((n, x) => n + x.sizeBytes, 0), cardBounds: g.cards, stripBounds: g.strip, scrollWidth: g.scrollWidth, clientWidth: g.clientWidth, screenshot: shot.path, status: "PASS" });
      }
    }
    await app.close(); app = undefined;
  }

  page = await launch(); await setTheme(page, "dark"); await selectProject(page, projectName); await setWindow(1920, 1080);
  const thumbs = page.locator(".attachment-thumbnail");
  await thumbs.first().locator(".attachment-thumbnail-open").click(); const modal = page.locator(".image-preview-modal-card"); await modal.waitFor();
  const mg = await page.evaluate(() => { const card = document.querySelector(".image-preview-modal-card"), backdrop = document.querySelector(".image-preview-backdrop"), r = card.getBoundingClientRect(), style = getComputedStyle(backdrop); return { width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight, portalParentIsBody: backdrop.parentElement === document.body, position: style.position, inset: [style.top, style.right, style.bottom, style.left] }; });
  assert(mg.portalParentIsBody && mg.position === "fixed" && mg.inset.every((value) => value === "0px"), `Preview is not a fixed body portal: ${JSON.stringify(mg)}`);
  assert(mg.width <= mg.vw * .9 + 2 && mg.height <= mg.vh * .9 + 2 && mg.left >= 0 && mg.top >= 0 && mg.right <= mg.vw && mg.bottom <= mg.vh, `Bad modal: ${JSON.stringify(mg)}`);
  let shot = await screenshot("preview-open-user-regression-dark-1920x1080.png"); results.push({ scenario: "preview-open", theme: "dark", window: "1920x1080", zoomFactor: 1, windowsScale: "100%", source: fixtures[0].fileName, sourceDimensions: "1912x1199", fileSizeBytes: fixtures[0].sizeBytes, screenshot: shot.path, status: "PASS" });
  await page.keyboard.press("Escape"); await modal.waitFor({ state: "hidden" }); const closedGeometry = await geometry(page); assertGeometry(closedGeometry);
  shot = await screenshot("preview-closed-three-thumbnails-dark-1920x1080.png"); results.push({ scenario: "preview-closed", theme: "dark", window: "1920x1080", zoomFactor: 1, windowsScale: "100%", source: "3 fullscreen screenshots", sourceDimensions: fixtures.map((x) => `${x.width}x${x.height}`).join(", "), fileSizeBytes: fixtures.reduce((n, x) => n + x.sizeBytes, 0), cardBounds: closedGeometry.cards, stripBounds: closedGeometry.strip, scrollWidth: closedGeometry.scrollWidth, clientWidth: closedGeometry.clientWidth, screenshot: shot.path, status: "PASS" });
  await thumbs.first().locator(".attachment-thumbnail-open").click(); await page.locator(".image-preview-backdrop").click({ position: { x: 5, y: 5 } }); await modal.waitFor({ state: "hidden" }); await thumbs.first().locator(".attachment-thumbnail-open").click(); await page.getByLabel("Закрыть просмотр").click(); await modal.waitFor({ state: "hidden" }); assertGeometry(await geometry(page));

  const mixedDraftMessageId = await page.evaluate(async (id) => (await window.orchestrator.attachments.listDraft(id))?.messageId, projectId);
  assert(mixedDraftMessageId, "Draft missing before mixed attachment scenario");
  await app.close(); app = undefined;
  const mixedSeedDb = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  const insertDocument = mixedSeedDb.prepare(`INSERT INTO message_attachments
    (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, quarantine_reason, provider_metadata_json, created_at, draft_expires_at, last_error, updated_at)
    VALUES (?, ?, ?, 'document', ?, ?, ?, ?, ?, 'file_picker', 'STAGED', NULL, NULL, ?, ?, NULL, ?)`);
  const seededAt = "2026-08-24T10:10:00.000Z";
  const expiresAt = "2026-08-31T10:10:00.000Z";
  const documentSpecs = [
    ["visual-pdf", "Очень длинное имя документа — проверка Unicode — финансовый отчёт 2026.pdf", "application/pdf", 72, "a".repeat(64), "visual-fixtures/report.pdf"],
    ["visual-md-unicode", "Технические заметки — очень длинное Unicode имя — финальная версия.md", "text/markdown", 55, "b".repeat(64), "visual-fixtures/notes.md"],
    ["visual-md-readme", "README attachment controls regression.md", "text/markdown", 32, "c".repeat(64), "visual-fixtures/readme.md"],
  ];
  for (const spec of documentSpecs) insertDocument.run(spec[0], mixedDraftMessageId, projectId, spec[1], spec[2], spec[3], spec[4], spec[5], seededAt, expiresAt, seededAt);
  mixedSeedDb.close();
  page = await launch(); await setTheme(page, "dark"); await selectProject(page, projectName);
  await page.waitForFunction(() => document.querySelectorAll(".composer-bottom .attachment-card").length === 6);
  await setWindow(1280, 720); await page.waitForTimeout(200);
  const mixedGeometry = await geometry(page); assertGeometry(mixedGeometry, true);
  const removeButtons = page.locator(".composer-bottom .attachment-remove");
  await removeButtons.nth(2).hover(); await removeButtons.nth(2).focus(); assertGeometry(await geometry(page), true);
  shot = await screenshot("attachments-mixed-wrap-hover-focus-1280x720-dark.png");
  results.push({ scenario: "mixed-wrap-hover-focus", theme: "dark", window: "1280x720", zoomFactor: 1, windowsScale: "100%", effectiveWindowDpi: shot.Dpi, cardBounds: mixedGeometry.cards, screenshot: shot.path, status: "PASS" });
  await app.close(); app = undefined;
  const transcriptSeedDb = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  transcriptSeedDb.prepare(`INSERT INTO message_attachments
    (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, quarantine_reason, provider_metadata_json, created_at, draft_expires_at, last_error, updated_at)
    SELECT 'transcript-' || id, 'visual-user', project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, quarantine_reason, provider_metadata_json, created_at, NULL, last_error, updated_at
    FROM message_attachments WHERE project_id = ?`).run(projectId);
  transcriptSeedDb.close();
  page = await launch(); await setTheme(page, "dark"); await selectProject(page, projectName); await setWindow(1280, 720);
  const removeButtonsAfterRestart = page.locator(".composer-bottom .attachment-remove");
  for (const targetIndex of [0, 2, -1]) {
    const beforeRemoval = await geometry(page);
    const index = targetIndex < 0 ? beforeRemoval.cards.length - 1 : targetIndex;
    const targetSlot = beforeRemoval.cards[index];
    await removeButtonsAfterRestart.nth(index).click();
    await page.waitForFunction((count) => document.querySelectorAll(".composer-bottom .attachment-card").length === count, beforeRemoval.cards.length - 1);
    const afterRemoval = await geometry(page); assertGeometry(afterRemoval);
    if (index < afterRemoval.cards.length) {
      const replacement = afterRemoval.cards[index];
      const targetRelative = { left: targetSlot.left - beforeRemoval.strip.left, top: targetSlot.top - beforeRemoval.strip.top };
      const replacementRelative = { left: replacement.left - afterRemoval.strip.left, top: replacement.top - afterRemoval.strip.top };
      assert(Math.abs(replacementRelative.left - targetRelative.left) < .01 && Math.abs(replacementRelative.top - targetRelative.top) < .01, `Attachment slot jumped after removal at ${index}: ${JSON.stringify({ targetSlot, replacement, targetRelative, replacementRelative })}`);
    }
  }

  await page.getByRole("button", { name: /Показать ход обсуждения/ }).click(); let discussion = page.getByLabel("Ход обсуждения моделей"); await discussion.waitFor(); assert(await discussion.locator(".discussion-turn").count() === 7, "Drawer lost turns");
  shot = await screenshot("discussion-right-drawer-long-russian-dark.png"); results.push({ scenario: "right-drawer", theme: "dark", window: "1366x768", zoomFactor: 1, windowsScale: "100%", source: "7 long Russian turns", sourceDimensions: "n/a", fileSizeBytes: 0, screenshot: shot.path, status: "PASS" });
  await page.getByLabel("Вернуться к итоговому ответу").click(); await page.evaluate(async () => { const s = await window.orchestrator.settings.get(); await window.orchestrator.settings.save({ ...s, appearance: { ...s.appearance, discussionView: "FULLSCREEN" } }); });
  await page.reload(); await selectProject(page, projectName); await page.getByRole("button", { name: /Показать ход обсуждения/ }).click(); discussion = page.getByLabel("Ход обсуждения моделей"); await discussion.waitFor();
  shot = await screenshot("discussion-fullscreen-long-russian-dark.png"); results.push({ scenario: "fullscreen", theme: "dark", window: "1366x768", zoomFactor: 1, windowsScale: "100%", source: "7 long Russian turns", sourceDimensions: "n/a", fileSizeBytes: 0, screenshot: shot.path, status: "PASS" });
  await setWindow(700, 760); await page.waitForTimeout(200); const narrow = await discussion.boundingBox(); assert(narrow?.width >= 690, "Narrow view is not fullscreen");
  shot = await screenshot("discussion-narrow-700x760-dark.png"); results.push({ scenario: "narrow-fullscreen", theme: "dark", window: "700x760", zoomFactor: 1, windowsScale: "100%", source: "7 long Russian turns", sourceDimensions: "n/a", fileSizeBytes: 0, screenshot: shot.path, status: "PASS" });

  await page.getByLabel("Вернуться к итоговому ответу").click(); await setWindow(1920, 1080);
  const transcriptCards = page.locator(".message.user .message-attachment-card");
  await transcriptCards.nth(5).waitFor();
  const transcriptGeometry = await transcriptCards.evaluateAll((nodes) => nodes.map((node) => { const card = node.getBoundingClientRect(), imageNode = node.querySelector("img"), image = imageNode ? imageNode.getBoundingClientRect() : null; return { card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom, width: card.width, height: card.height }, image: image ? { width: image.width, height: image.height } : null, documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; }));
  assert(transcriptGeometry.length === 6 && transcriptGeometry.filter((item) => item.image).length === 3 && transcriptGeometry.filter((item) => item.image).every((item) => item.image.width === 38 && item.image.height === 38) && transcriptGeometry.every((item) => item.card.width <= 320 && !item.documentOverflow), `Transcript attachments are not compact: ${JSON.stringify(transcriptGeometry)}`);
  shot = await screenshot("transcript-six-compact-attachments-dark-1920x1080.png");
  results.push({ scenario: "transcript-compact", theme: "dark", window: "1920x1080", zoomFactor: 1, windowsScale: "100%", effectiveWindowDpi: shot.Dpi, source: "3 screenshots + PDF + 2 MD", sourceDimensions: fixtures.map((x) => `${x.width}x${x.height}`).join(", "), cardBounds: transcriptGeometry, screenshot: shot.path, status: "PASS" });

  const reportPath = join(out, "visual-gate-report.json"); await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), fixtures, results }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, screenshots: results.length, fixtures: fixtures.length, report: reportPath }, null, 2));
} finally {
  await app?.close().catch(() => undefined); await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
