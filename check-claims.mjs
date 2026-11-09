#!/usr/bin/env node
// check-claims.mjs — OPS-115 / DK-085: detect overclaims and forbidden words in public docs.
// Scans: README.md, HACKATHON.md, docs/*.md
// Two checks:
//  1) FORBIDDEN WORDS: gamefi / investing / investment / yield / casino (case-insensitive).
//     Rule lines (the honesty rule itself) are excluded — see RULE_KEYS + 1-line lookback.
//  2) "ready/live" CLAIMS without evidence: the strong phrases below must carry an evidence marker
//     (evidence/, verify:thesis, LOLOS, tx hash, commit hash, "hash", "from evidence").
// Exits 1 on any finding. Used in CI (see .github/workflows/ci.yml).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  "README.md",
  "HACKATHON.md",
  ...readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f)),
];

const BANNED = ["gamefi", "investing", "investment", "yield", "casino"];

// Keywords that mark a line as quoting/explaining the RULE (not a claim). Applied to this line
// or the previous one (for multi-line rule blocks).
const RULE_KEYS =
  /forbidden|prohibited|without the words?|banned|wording|honesty rules?|rule of honesty|replace\b|sync note|framing\s*$/i;

// Strong claim phrases that need evidence on the same line.
const CLAIM_PATTERNS = [
  /submission\s*\(\s*ready\s*\)/i,
  /submission\s+ready/i,
  /ready\s+to\s+submit/i,
  /fully\s+(ready|live|complete|done)/i,
  /is\s+live\s+now/i,
  /already\s+(live|ready\s+to\s+submit)/i,
  /100\s*%\s*(complete|done|tested|passed?)/i,
  /all\s+(tests?|checks?)\s+(pass|passed|green)/i,
  /no\s+(known\s+)?(bugs?|failures?)\b/i,
];

// Evidence markers that exempt a line from claim findings.
const EVIDENCE_KEYS =
  /evidence\/|verify:thesis|demo:replay|LOLOS|PASSED|PASS\b|NOT YET|\btx\b|hash|from evidence|point-in-time|spot-check/i;

const findings = [];

function ruleish(line, prevLine) {
  return RULE_KEYS.test(line) || RULE_KEYS.test(prevLine || "");
}

function hasEvidence(line) {
  return EVIDENCE_KEYS.test(line);
}

for (const rel of FILES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const prev = i > 0 ? lines[i - 1] : "";
    const lower = line.toLowerCase();

    // 1) forbidden words
    for (const w of BANNED) {
      if (lower.includes(w) && !ruleish(line, prev)) {
        findings.push({
          kind: "banned-word",
          file: rel,
          line: i + 1,
          detail: `"${w}": ${line.slice(0, 140)}`,
        });
      }
    }

    // 2) ready/live claim without evidence
    for (const re of CLAIM_PATTERNS) {
      if (re.test(line) && !hasEvidence(line) && !ruleish(line, prev)) {
        findings.push({
          kind: "overclaim",
          file: rel,
          line: i + 1,
          detail: `${re.source}: ${line.slice(0, 140)}`,
        });
      }
    }
  });
}

if (findings.length === 0) {
  console.log(`check:claims OK — ${FILES.length} files scanned, 0 findings`);
  process.exit(0);
}
console.log(`check:claims FAILED — ${findings.length} findings:\n`);
for (const f of findings) {
  console.log(`  [${f.kind}] ${f.file}:${f.line}`);
  console.log(`      ${f.detail}`);
}
process.exit(1);
