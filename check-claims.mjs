#!/usr/bin/env node
// check-claims.mjs — OPS-115 / DK-085: deteksi overclaim & kata terlarang di dokumen publik.
// Pindai: README.md, HACKATHON.md, docs/*.md
// Dua pemeriksaan:
//  1) KATA TERLARANG: gamefi / investasi / investment / yield / kasino (case-insensitive).
//     Baris aturan (aturan kejujuran itu sendiri) dikecualikan — lihat RULE_KEYS + lookback 1 baris.
//  2) KLAIM "ready/live" tanpa bukti: frasa kuat berikut wajib disertai penanda bukti
//     (evidence/, verify:thesis, LOLOS, tx hash, hash commit, "hash", "dari bukti").
// Exit 1 bila ada temuan. Dipakai di CI (lihat .github/workflows/ci.yml).
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

const BANNED = ["gamefi", "investasi", "investment", "yield", "kasino"];

// Kata kunci yang menandai baris = mengutip/menjelaskan ATURAN (bukan klaim). Dipakai di baris ini
// atau baris sebelumnya (untuk blok aturan multi-baris).
const RULE_KEYS =
  /dilarang|tanpa kata|banned|wording|honesty rules|aturan kejujuran|ganti\b|catatan sinkron|framing\s*$/i;

// Frasa klaim kuat yang butuh bukti pada baris yang sama.
const CLAIM_PATTERNS = [
  /submission\s*\(\s*ready\s*\)/i,
  /submission\s+ready/i,
  /ready\s+to\s+submit/i,
  /fully\s+(ready|live|complete|done)/i,
  /is\s+live\s+now/i,
  /sudah\s+(live|siap\s+submit)/i,
  /100\s*%\s*(complete|done|tested|lulus)/i,
  /all\s+(tests?|checks?)\s+(pass|green|lulus)/i,
  /no\s+(known\s+)?(bugs?|failures?)\b/i,
];

// Penanda bukti yang membebaskan baris dari temuan klaim.
const EVIDENCE_KEYS =
  /evidence\/|verify:thesis|demo:replay|LOLOS|PASS\b|BELUM|\btx\b|hash|dari bukti|point-in-time|spot-check/i;

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

    // 1) kata terlarang
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

    // 2) klaim ready/live tanpa bukti
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
  console.log(`check:claims OK — ${FILES.length} file dipindai, 0 temuan`);
  process.exit(0);
}
console.log(`check:claims GAGAL — ${findings.length} temuan:\n`);
for (const f of findings) {
  console.log(`  [${f.kind}] ${f.file}:${f.line}`);
  console.log(`      ${f.detail}`);
}
process.exit(1);
