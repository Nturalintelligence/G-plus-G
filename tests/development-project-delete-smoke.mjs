import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-dev-delete-"));
const fixture = [...new Uint8Array(await readFile(resolve("tests/fixtures/remove-controls-regression.png")))];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;

try {
  app = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const firstName = `Dev delete A ${Date.now()}`;
  const secondName = `Dev delete B ${Date.now()}`;
  const setup = await page.evaluate(async ({ firstName, secondName, fixture }) => {
    const first = await window.orchestrator.projects.create(firstName, ["chatgpt"]);
    const second = await window.orchestrator.projects.create(secondName, ["chatgpt"]);
    const firstAttachment = await window.orchestrator.attachments.stageClipboard(
      first.id, `msg_${first.id}`, new Uint8Array(fixture), "image/png", "shared.png",
    );
    const secondAttachment = await window.orchestrator.attachments.stageClipboard(
      second.id, `msg_${second.id}`, new Uint8Array(fixture), "image/png", "shared-copy.png",
    );
    return { first, second, firstAttachment, secondAttachment };
  }, { firstName, secondName, fixture });

  const setupDb = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  const stagedPaths = setupDb.prepare("SELECT project_id, local_relative_path, sha256 FROM message_attachments WHERE id IN (?, ?) ORDER BY project_id")
    .all(setup.firstAttachment.id, setup.secondAttachment.id);
  setupDb.close();
  assert(stagedPaths.length === 2 && stagedPaths[0].sha256 === stagedPaths[1].sha256, "Fixture content hashes are not deduplicated");
  const survivingRelativePath = stagedPaths.find((row) => row.project_id === setup.second.id).local_relative_path;
  await page.reload();
  const firstRow = page.locator(".project-row").filter({ hasText: firstName });
  await firstRow.getByTitle("Действия с проектом").click();
  await firstRow.getByRole("button", { name: "В корзину" }).click();
  await page.getByText(firstName, { exact: true }).waitFor({ state: "detached" });
  await page.getByText(secondName, { exact: true }).waitFor();
  await page.getByRole("button", { name: /Корзина/ }).click();
  const trashedRow = page.locator(".project-row").filter({ hasText: firstName });
  await trashedRow.getByTitle("Действия с проектом").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await trashedRow.getByRole("button", { name: "Удалить навсегда" }).click();
  await page.getByText(firstName, { exact: true }).waitFor({ state: "detached" });

  const db = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  const firstCount = db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(setup.first.id).count;
  const secondCount = db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(setup.second.id).count;
  const firstRefs = db.prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE project_id = ?").get(setup.first.id).count;
  const secondRefs = db.prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE project_id = ?").get(setup.second.id).count;
  db.close();
  assert(firstCount === 0 && firstRefs === 0, "Deleted project remains in local database");
  assert(secondCount === 1 && secondRefs === 1, "Shared attachment reference of surviving project was removed");
  await access(join(dataRoot, "artifacts", survivingRelativePath));

  console.log(JSON.stringify({ ok: true, deletedProject: firstName, survivingProject: secondName, sharedBlobPreserved: true }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
