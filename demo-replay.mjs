#!/usr/bin/env node
// demo-replay.mjs — OPS-113: `npm run demo:replay`. Replay demo dari bukti gladi,
// TANPA kunci, TANPA jaringan (<1 dtk) — juri AI/mana pun bisa mereplay cerita demo
// dari file bukti yang di-commit. Keluaran: reports/demo-replay.md + stdout timeline.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const T0 = Date.now();

const manifest = JSON.parse(readFileSync(resolve(ROOT, "reports/gladi-manifest.json"), "utf8"));
const tee = JSON.parse(readFileSync(resolve(ROOT, "reports/tee-vector-live.json"), "utf8"));

// Narasi beat demo (urutan cerita — mapping ke KPI)
const BEATS = [
  ["🥚 Lahir", ["G-01"], "Tiga sel lahir berbeda peran (Extractor/Fermenter/Synthesizer) — `$SNACC` supply terbentuk dari stake NEAR."],
  ["🍽️ Makan → ATP", ["G-03"], "Feed membakar `$SNACC` → membukukan `$ATP` (energi internal, non-transferable)."],
  ["🧬 TEE zero-trust", ["G-05"], "Genom dieksekusi di NEAR AI Cloud TEE: kontrak memverifikasi ulang `ed25519` + anti-replay chat_id."],
  ["⚙️ Rantai produksi NEP-245", ["G-04"], "Spora → enzim (amalgam/redactase/synthase) → eliksir (`homeostasis` & `aether`) — biaya ATP per kerja."],
  ["🏪 NPC market-maker", ["G-13"], "Harga `P_base × S_target/S_after` — konservasi kas I-15."],
  ["🔥 Suplai menyusut", ["G-17"], "`ft_burn` — fitur volatilitas: suplai turun saat ekonomi berputar."],
  ["🧫 Fusi & reproduksi", ["G-06", "G-09"], "Splice (pajak 2,5%, role_mask menyatu) → divide (sitokinesis, konservasi saldo)."],
  ["💰 Dividen industri", ["G-11"], "`mt:elixir-aether` dibakar → kontribusi epoch → klaim pro-rata."],
  ["🏦 Vault sub-account", ["G-21"], "NFT punya rekening sendiri: `s-<id>.<akun-kontrak>`."],
  ["🫀 Transplantasi NFT", ["G-15"], "`nft_transfer` NEP-171 — NFT (sel hidup + perut + organel) berpindah pemilik."],
  ["📊 Konsistensi & solvabilitas", ["G-12", "G-18", "G-20"], "`ft_total_supply == total_snacc_supply`; treasury tak pernah negatif; `V_epoch` hidup."],
];

const rows = [];
for (const [judul, kpis, narasi] of BEATS) {
  const acts = manifest.actions.filter((a) => kpis.includes(a.kpi) && a.txHash);
  rows.push({ judul, narasi, kpis, acts });
}

const totalTx = manifest.actions.filter((a) => a.txHash).length;
const md = [
  `# Demo Replay — Snacc (OPS-113)`,
  ``,
  `Direplay dari bukti gladi ter-commit: \`reports/gladi-manifest.json\` (${totalTx} tx) + vektor TEE \`tee-vector-live.json\`.`,
  `TANPA kunci · TANPA jaringan · ${((Date.now() - T0) / 1000).toFixed(2)} dtk. Kontrak: \`${manifest.owner}\`. $SNACC testnet tanpa nilai uang.`,
  ``,
  ...rows.flatMap((r) => [
    `## ${r.judul}`,
    ``,
    r.narasi,
    ``,
    ...r.acts.slice(0, 3).map((a) => `- \`${a.txHash}\` — ${a.note}`),
    ...(r.acts.length > 3 ? [`- … +${r.acts.length - 3} tx lain di manifest`] : []),
    ``,
  ]),
  `## Bukti TEE (replay offline)`,
  ``,
  `- chat_id: \`${tee.chat_id}\` · signed_text: \`${tee.signed_text}\``,
  `- pubkey enclave: \`${tee.tee_pubkey_hex}\` — verifikasi ed25519 ulang ada di \`verify-thesis.mjs\` (F-03 LOLOS).`,
  ``,
  `> Rekam ulang: \`node scripts/demo-replay.mjs\` — output deterministik dari file bukti.`,
].join("\n");

const out = resolve(ROOT, "reports/demo-replay.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md, "utf8");
console.log(`REPLAY OK — ${totalTx} tx · ${rows.length} beat · ${((Date.now() - T0) / 1000).toFixed(2)} dtk · tanpa kunci → ${out}`);
for (const r of rows) console.log(`  ${r.judul} (${r.acts.length} tx)`);
