import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const renderer = read("apps/desktop/renderer/main.tsx");
const styles = read("apps/desktop/renderer/styles.css");
const settingsModal = read("apps/desktop/renderer/components/SettingsModal.tsx");

describe("Phase B.1 UI contracts", () => {
  it("constrains composer thumbnails and full image preview", () => {
    expect(styles).toMatch(/\.attachment-thumbnail\s*\{[\s\S]*?width:\s*64px;[\s\S]*?height:\s*64px;/);
    expect(styles).toMatch(/\.attachment-thumbnail-open img\s*\{[\s\S]*?object-fit:\s*cover;/);
    expect(styles).toMatch(/\.image-preview-modal-card\s*\{[\s\S]*?max-width:\s*90vw;[\s\S]*?max-height:\s*90vh;/);
    expect(styles).toMatch(/\.full-preview-image\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?max-height:\s*100%;[\s\S]*?object-fit:\s*contain;/);
    expect(renderer).toContain('event.key !== "Escape"');
    expect(renderer).toContain("image-preview-backdrop");
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
});
