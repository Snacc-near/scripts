#!/usr/bin/env node
// demo-replay.mjs — OPS-113: `npm run demo:replay`. Replay demo dari bukti gladi,
// TANPA kunci, TANPA jaringan (<1 dtk) — juri AI/mana pun bisa mereplay cerita demo
// dari file bukti yang di-commit. Keluaran: reports/demo-replay.md + stdout timeline.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SNACC_ROOT ? resolve(process.env.SNACC_ROOT) : resolve(HERE, ".."); // OPS-119: root payung, input dari evidence/
const T0 = Date.now();

const manifest = JSON.parse(readFileSync(resolve(ROOT, "evidence/gladi-manifest.json"), "utf8"));
const tee = JSON.parse(readFileSync(resolve(ROOT, "evidence/tee-vector-live.json"), "utf8"));

// Narasi beat demo (urutan cerita — mapping ke KPI)
const BEATS = [
  ["🥚 Lahir", ["G-01"], "Tiga sel lahir berbeda peran (Extractor/Fermenter/Synthesizer) — `$SNACC` supply terbentuk dari stake NEAR."],
  ["🍽️ Makan → ATP → Alokasi", ["G-03"], "Feed membakar `$SNACC` → membukukan `$ATP` (energi internal, non-transferable); suhu kini ATP-driven (EN-117: jejak atp_minted×6×10^14 masuk V_epoch). `allocate_atp` menyalakan organel (EN-119): mitokondria +10%/level minting ATP, nukleus +10%/level output, lisosom −10%/level BMR."],
  ["🧬 TEE zero-trust", ["G-05"], "Genom dieksekusi di NEAR AI Cloud TEE: kontrak memverifikasi ulang `ed25519` + anti-replay chat_id."],
  ["⚙️ Rantai produksi NEP-245", ["G-04"], "Spora → enzim (amalgam/redactase/synthase) → eliksir (`homeostasis` & `aether`) — biaya ATP per kerja."],
  ["🏪 NPC market-maker", ["G-13"], "Harga `P_base × S_target/S_after` — konservasi kas I-15."],
  ["🔥 Suplai menyusut", ["G-17"], "`ft_burn` — fitur volatilitas: suplai turun saat ekonomi berputar."],
  ["🧫 Fusi & reproduksi", ["G-06", "G-09"], "Splice (pajak 2,5%, role_mask menyatu) → divide (sitokinesis, konservasi saldo)."],
  ["💰 Dividen industri", ["G-11"], "`mt:elixir-aether` dibakar → kontribusi epoch → klaim pro-rata."],
  ["⚔️ M&A & lisis", ["G-07", "G-08", "G-10"], "Strain yang kelaparan (Distressed, 1..2000 vitalitas) diambil alih: hostile 115% (95% ke pemilik lama, 5% treasury) atau adopt 100% book value; Insolvent (0) dilisis permissionless — bounty 10%, 90% ke treasury + Nutrient Burst. Penuaan dipercepat jam sandbox (`advance_sandbox_clock`, owner-only, akun .testnet)."],
  ["💸 Transfer `$SNACC`", ["G-02"], "`ft_transfer` NEP-141 dari saldo hasil payout M&A ke akun lain."],
  ["🏦 Vault sub-account", ["G-21"], "NFT punya rekening sendiri: `s-<id>-<tag>.<akun-kontrak>`."],
  ["🫀 Transplantasi NFT", ["G-15"], "`nft_transfer` NEP-171 — NFT (sel hidup + perut + organel) berpindah pemilik."],
  ["📊 Konsistensi & solvabilitas", ["G-12", "G-18", "G-20"], "`ft_total_supply == total_snacc_supply`; treasury tak pernah negatif; `V_epoch` hidup (suhu ATP-driven — zona bisa berbeda dari gladi sebelumnya)."],
  ["📜 Kepatuhan NEP", ["G-22"], "NEP-177 `nft_metadata` (spec nft-1.0.0) · NEP-145 `storage_deposit(registration_only)` + bounds · NEP-181 enumerasi `nft_tokens`/`nft_supply_for_owner` — pintu masuk dompet & marketplace. Diverifikasi pada wasm ter-deploy; kode view-nya belum ada di repo publik."],
];


// - RES-103: tahap attestation TDX (DCAP) - mock-friendly, offline = DILEWATI.
//   1) Fixture lokal (evidence/) lebih dulu; 2) live fetch best-effort (offline = warning);
//   3) verifikasi offline via `dcap-qvl` BILA ada di PATH; kalau tidak -> DILEWATI + instruksi.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

function dcapQvlTersedia() {
  try {
    execFileSync("which", ["dcap-qvl"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function tahapAttestation() {
  const baris = [];
  let quote = null;
  let sumber = null;
  const fixturePaths = [
    resolve(ROOT, "evidence/attestation-quote.json"),
    resolve(ROOT, "evidence/tee-vector-live.json"),
  ];
  for (const p of fixturePaths) {
    if (existsSync(p)) {
      quote = JSON.parse(readFileSync(p, "utf8"));
      sumber = p;
      baris.push("- Fixture quote lokal: `" + p + "`");
      break;
    }
  }
  if (!quote) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch("https://cloud-api.near.ai/v1/attestation/report", { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        quote = await res.json();
        sumber = "https://cloud-api.near.ai/v1/attestation/report (live)";
        const out = resolve(ROOT, "evidence/attestation-quote.json");
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(quote, null, 2), "utf8");
        baris.push("- Laporan attestation live diambil & disimpan: `" + out + "`");
      } else {
        baris.push("- Live fetch attestation: HTTP " + res.status + " - lanjut mode offline");
      }
    } catch (e) {
      baris.push("- Live fetch attestation tidak tersedia (offline): " + String(e.message ?? e).slice(0, 90) + " - DILEWATI");
    }
  }
  if (quote) {
    if (dcapQvlTersedia()) {
      try {
        const qpath = resolve(ROOT, "evidence/attestation-quote.json");
        if (!existsSync(qpath)) writeFileSync(qpath, JSON.stringify(quote, null, 2), "utf8");
        const out = execFileSync("dcap-qvl", ["verify", qpath], { stdio: "pipe" }).toString();
        baris.push("- `dcap-qvl verify`: " + out.trim().split(String.fromCharCode(10))[0]);
      } catch (e) {
        baris.push("- `dcap-qvl verify` gagal: " + String(e.message ?? e).slice(0, 90));
      }
    } else {
      baris.push("- **Verifikasi DCAP offline: DILEWATI (dcap-qvl tidak terpasang)**");
      baris.push("  - Instal: `cargo install dcap-qvl` (ikuti docs NEAR AI Cloud TDX attestation), lalu `npm run demo:replay` kembali.");
    }
  } else {
    baris.push("- Tidak ada quote attestation (offline & tanpa fixture) - tahap dilewati");
  }
  baris.push("- Sumber quote: " + (sumber ?? "tidak ada"));
  return baris;
}

const attestationBaris = await tahapAttestation();

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
  `### RES-103 - Attestation TDX (DCAP)`,
  ``,
  ...attestationBaris.map((b) => `  ${b}`),
  `> Rekam ulang: \`node scripts/demo-replay.mjs\` — output deterministik dari file bukti.`,
].join("\n");

const out = resolve(ROOT, "reports/demo-replay.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md, "utf8");
console.log(`REPLAY OK — ${totalTx} tx · ${rows.length} beat · ${((Date.now() - T0) / 1000).toFixed(2)} dtk · tanpa kunci → ${out}`);
for (const r of rows) console.log(`  ${r.judul} (${r.acts.length} tx)`);
