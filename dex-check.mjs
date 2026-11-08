#!/usr/bin/env node
// dex-check.mjs — VERIFIKATOR STATUS DEX $SNACC (jujur: ADA / TIDAK ADA / TIDAK BISA DICEK).
//   node scripts/dex-check.mjs [--token <alamat kontrak>]
// Mengecek berlapis: (1) token hidup di chain (ft_metadata/ft_total_supply),
// (2) keberadaan pool/pasar di DEX publik (Ref/Meme Cooking) berdasarkan ALAMAT KONTRAK
// (bukan ticker — ticker bisa dipalsukan), (3) cetak kesimpulan apa adanya.
// Prinsip: kalau tidak bisa memverifikasi = tulis "TIDAK BISA DICEK", jangan pernah mengarang.
const CONTRACT = process.argv.includes("--token") ? process.argv[process.argv.indexOf("--token") + 1] : "snacc-v001.testnet";

async function probe(name, url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    return { name, ok: res.ok, status: res.status, body: text.slice(0, 400) };
  } catch (e) {
    return { name, ok: false, status: 0, body: `tidak terjangkau: ${String(e.message).slice(0, 60)}` };
  }
}
async function rpcView(method, args = {}) {
  const r = await fetch("https://near-testnet.drpc.org", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

console.log(`# Cek status DEX $SNACC — kontrak: ${CONTRACT}\n`);
const kesimpulan = [];

// (1) Token hidup di chain?
try {
  const md = await rpcView("ft_metadata");
  const ts = await rpcView("ft_total_supply");
  console.log(`✅ TOKEN HIDUP di chain: name=${md.name} symbol=${md.symbol} decimals=${md.decimals} · ft_total_supply=${ts}`);
  kesimpulan.push("Token NEP-141 HIDUP di testnet (bukan token rekaan).");
} catch (e) {
  console.log(`❌ Token TIDAK terbaca: ${String(e.message).slice(0, 80)}`);
  kesimpulan.push("Token tidak terbaca di chain — klaim 'ada' TIDAK sah.");
}

// (2) Cek DEX via ALAMAT KONTRAK (bukan ticker)
// Ref Finance (mainnet) — pools API publik; Meme Cooking — pencarian token.
const targets = [
  ["Ref Finance (mainnet) — cari alamat kontrak di pools", "https://api.ref.finance/list-pairs"],
  ["Meme Cooking — pencarian token", `https://meme.cooking/api/tokens?search=${CONTRACT}`],
  ["NEAR Blocks (testnet) — jejak kontrak", `https://api-testnet.nearblocks.io/v1/account/${CONTRACT}`],
];
for (const [name, url] of targets) {
  const r = await probe(name, url);
  const mentions = r.body.includes(CONTRACT) || r.body.toLowerCase().includes("snacc");
  if (!r.ok) console.log(`⚠️  ${name}: TIDAK BISA DICEK (HTTP ${r.status}) — ${r.body.slice(0, 60)}`);
  else if (mentions) console.log(`🔎 ${name}: ADA KEMUNCULAN — periksa manual: ${r.body.slice(0, 120)}`);
  else console.log(`🚫 ${name}: TIDAK ditemukan entri untuk ${CONTRACT}`);
  kesimpulan.push(`- ${name}: ${!r.ok ? "tidak bisa dicek otomatis (periksa manual via link)" : mentions ? "ada kemunculan — verifikasi manual" : "tidak ditemukan"}`);
}

// (3) Kesimpulan jujur
console.log("\n## Kesimpulan");
console.log(kesimpulan.join("\n"));
console.log(`
Kriteria "TERDAFTAR DI DEX" yang SAH (cek saat listing nanti):
1. Pool/likuiditas ADA di DEX (Ref / Meme Cooking) untuk ALAMAT KONTRAK (bukan ticker).
2. Alamat kontrak cocok dengan yang dipublikasikan resmi (README/HACKATHON.md).
3. Ada likuiditas terkunci/tercatat (TVL) + volume transaksi nyata.
4. Jangan pernah percaya pencarian berbasis NAMA — $SNACC bisa ditiru; yang sah = ALAMAT.`);
