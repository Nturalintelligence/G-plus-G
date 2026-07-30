import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
let commit = "unknown";
try {
  commit = execFileSync(
    "git",
    ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "rev-parse", "HEAD"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
} catch {
  // A source archive without .git remains buildable and reports "unknown".
}

const manifest = {
  format: 1,
  commit,
  builtAt: new Date().toISOString(),
};
await writeFile(
  resolve(root, "build-info.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(`Build manifest: ${commit.slice(0, 12)}`);
