import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function icoSizes(buffer: Buffer): Array<[number, number]> {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return [buffer[offset] || 256, buffer[offset + 1] || 256];
  });
}

describe("Windows icon assets", () => {
  it("contains every required square ICO frame and a transparent PNG master", () => {
    const root = process.cwd();
    const ico = fs.readFileSync(path.join(root, "build", "icon.ico"));
    expect(icoSizes(ico)).toEqual([
      [16, 16], [20, 20], [24, 24], [32, 32], [40, 40], [48, 48], [64, 64], [128, 128], [256, 256],
    ]);
    const png = fs.readFileSync(path.join(root, "build", "icon.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // PNG color type 6 is RGBA, required for a transparent shortcut canvas.
    expect(png[25]).toBe(6);
  });

  it("keeps icon generation reproducible and wires source assets without packaging", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts", "generate-windows-icon.py"), "utf8");
    const packageJson = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const main = fs.readFileSync(path.join(process.cwd(), "apps", "desktop", "main.ts"), "utf8");
    expect(script).toContain("Transparent outer canvas");
    expect(packageJson).toContain('"icon": "build/icon.ico"');
    expect(main).toContain('"build", "icon.png"');
  });
});
