import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const tracked = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) tracked.push(target.replaceAll("\\", "/"));
  }
};
for (const root of ["apps", "src", "scripts"]) walk(root);

const excluded = new Set(["scripts/security-source-guard.mjs"]);
const forbidden = [
  ["task-specific Snake marker", "sna" + "ke"],
  ["personal username", "ona" + "dl"],
  ["personal desktop path", "Рабочий " + "стол"],
  ["legacy CLI tag", "[[G_PLUS_G_CLI_TASK" + ":"],
  ["removed terminal IPC", "terminal" + ":execute"],
  ["removed TwoTier bridge", "TwoTier" + "Orchestrator"],
];

const failures = [];
for (const file of tracked) {
  if (excluded.has(file)) continue;
  const text = readFileSync(file, "utf8").toLowerCase();
  for (const [label, needle] of forbidden) {
    if (text.includes(needle.toLowerCase())) failures.push(`${file}: ${label}`);
  }
}

if (failures.length > 0) {
  console.error(`Security source guard failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`Security source guard passed (${tracked.length} production source files scanned).`);
