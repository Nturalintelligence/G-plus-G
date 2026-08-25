import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const renderer = read("apps/desktop/renderer/main.tsx");
const styles = read("apps/desktop/renderer/styles.css");
const settingsModal = read("apps/desktop/renderer/components/SettingsModal.tsx");

describe("Phase B.1 UI contracts", () => {
  it("constrains composer thumbnails and full image preview", () => {
    expect(styles).toMatch(/\.attachment-thumbnail\s*\{[\s\S]*?flex:\s*0 0 72px;[\s\S]*?width:\s*72px;[\s\S]*?height:\s*72px;[\s\S]*?overflow:\s*hidden;/);
    expect(styles).toMatch(/\.output\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
    expect(styles).toMatch(/\.composer-bottom \.attached-files-row\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?max-height:\s*168px;[\s\S]*?overflow-y:\s*auto;/);
    expect(styles).toMatch(/\.attachment-thumbnail-open img\s*\{[\s\S]*?object-fit:\s*cover;/);
    expect(styles).toMatch(/\.attachment-card\s*\{[\s\S]*?position:\s*relative;[\s\S]*?overflow:\s*hidden;/);
    expect(styles).toMatch(/\.attachment-remove\s*\{[\s\S]*?top:\s*4px;[\s\S]*?right:\s*4px;[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?transform:\s*none;/);
    expect(renderer).toContain('className="attachment-remove attachment-thumbnail-remove"');
    expect(renderer).toContain('className="attachment-remove"');
    expect(styles).toMatch(/\.image-preview-modal-card\s*\{[\s\S]*?max-width:\s*90vw;[\s\S]*?max-height:\s*90vh;/);
    expect(styles).toMatch(/\.full-preview-image\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?max-height:\s*100%;[\s\S]*?object-fit:\s*contain;/);
    expect(renderer).toContain('event.key !== "Escape"');
    expect(renderer).toContain("image-preview-backdrop");
    expect(renderer).toContain("createPortal");
  });

  it("provides persistent right drawer and fullscreen discussion modes", () => {
    expect(settingsModal).toContain("RIGHT_DRAWER");
    expect(settingsModal).toContain("FULLSCREEN");
    expect(settingsModal).toContain("Отображение хода обсуждения");
    expect(renderer).toContain('? "fullscreen" : "right-drawer"');
    expect(renderer).toContain("discussion-turn-content");
    expect(styles).toMatch(/width:\s*clamp\(420px,\s*36vw,\s*650px\)/);
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toMatch(/\.discussion-view-scroll\s*\{[\s\S]*?overflow-y:\s*auto;/);
  });

  it("renders downloaded provider artifacts as compact open/save result cards", () => {
    expect(renderer).toContain("function MessageAttachments");
    expect(renderer).toContain("Файл от ${file.source}");
    expect(renderer).toContain("attachments.saveAs(file.id)");
    expect(styles).toMatch(/\.message-attachment-card\s*\{[\s\S]*?max-width:\s*min\(320px, 100%\);[\s\S]*?overflow/);
    expect(styles).toContain(".message-attachment-save");
  });

  it("keeps sidebar chrome fixed around a dedicated project scroll container", () => {
    expect(renderer).toMatch(/className="projects-list-nav"/);
    expect(renderer).toMatch(/className="sidebar-models-section"/);
    expect(renderer).toMatch(/className="sidebar-footer"/);
    expect(renderer).toMatch(/scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
    expect(renderer).toContain('window.localStorage.setItem("gplusg.selectedProjectId", id)');
    expect(renderer).toMatch(/className="project-name" title=\{project\.name\}/);
    expect(styles).toMatch(/\.sidebar-pane\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
    expect(styles).toMatch(/\.projects-list-nav\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-x:\s*hidden;/);
    expect(styles).toMatch(/\.sidebar-models-section,[\s\S]*?\.sidebar-footer\s*\{[\s\S]*?flex-shrink:\s*0;/);
    expect(styles).toMatch(/\.project-name\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
    expect(styles).toMatch(/\.project-menu-btn\s*\{[\s\S]*?flex:\s*0 0 34px;/);
  });
});
