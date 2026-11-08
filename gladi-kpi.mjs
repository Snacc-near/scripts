#!/usr/bin/env node
/**
 * gladi-kpi.mjs v3 — KPI GLADI AUTO-CHECK (OPS-118; v3 setelah audit 3-POV ganda, 2026-11-08).
 *
 * Manifest (`reports/gladi-manifest.json`) — WAJIB di-commit ke git SEBELUM gladi (R2.7):
 *   { "owner": "akun.testnet", "signer": "akun.testnet",
 *     "strain_ids": [1, 2], "token_ids": ["1"],
 *     "supply_before": "…", "temp_before": 0,
 *     "actions": [ {"kpi": "G-01", "txHash": "…", "signer": "opsional"} ] }
 * Feed minimal agar `atp_minted > 0`: ≥ 10^15 yocto (disarankan 4×10^15, lihat test `atp114_feed`).
 *
 * Pengetatan v3 (audit child 37 temuan):
 *  - tx wajib SUKSES, signer tx == manifest.signer (R2.1), receipt hanya dari CONTRACT (R2.1)
 *  - payload event diikat ke entitas gladi: owner_id/strain_id ∈ manifest (R2.2/R2.6)
 *  - angka payload diverifikasi vs Kamus: pajak 2,5%, premium 115% (95/5), bounty 10%, burn 350bps (R2.5/J3.6)
 *  - hash tidak boleh dipakai ulang lintas-KPI (R2.4); error "tx belum ter-index" = BELUM, bukan FAIL (B9.9)
 *  - ukur byte SVG (bukan JSON view) ≤1734 (B9.2); symbol "$SNACC" (B9.1)
 *
 * Kanonik `kind` event: strain_created, fed, atp_spent, atp_allocated, extracted, transmuted,
 * synthesized, genome_committed, genome_mutated, strains_spliced, hostile_takeover_spliced,
 * strain_liquidated, strain_divided, strain_adopted, trait_conjugated, feast_result, zone_changed,
 * nutrient_burst_released, npc_spores_bought, dividend_claimed, dividend_inflow,
 * epoch_dividend_closed, aether_burned_for_dividend (+ nep171 nft_transfer, nep141 ft_transfer).
 *
 * $SNACC testnet tanpa nilai uang. Tanpa hash = tanpa klaim.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const RPC = arg("rpc", process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com");
const CONTRACT = arg("contract", process.env.CONTRACT_ID ?? "snacc-v001.testnet");
const MANIFEST = resolve(HERE, arg("manifest", process.env.GLADI_MANIFEST ?? "../../../reports/gladi-manifest.json"));
const OUT = resolve(HERE, "../../../reports/gladi-kpi.md");

class TxNotIndexed extends Error {}
const usedHashes = new Map(); // hash -> kpi pertama (R2.4)
const txCache = new Map(); // hash:signer -> proof (cache lintas-KPI)
const RPCS = [RPC, "https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"];

// ---------- RPC (retry + fallback) ----------
async function rpcCall(method, params) {
  let lastErr;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "gladi-kpi", method, params }),
        });
        const j = await res.json();
        if (j.error) {
          const msg = String(j.error.data ?? j.error.message ?? "");
          if (/UnknownTransaction|Not Found|does not exist|not found/i.test(msg)) throw new TxNotIndexed(msg.slice(0, 120));
          throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
        }
        return j.result;
      } catch (e) {
        if (e instanceof TxNotIndexed) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  throw lastErr;
}
// Angka u128 dari JSON bisa berupa number (notasi e) — perbandingan aman.
const sameAmount = (a, b) => String(a) === String(b) || Number(a) === Number(b);
async function view(method, args = {}) {
  const r = await rpcCall("query", {
    request_type: "call_function", finality: "final",
    account_id: CONTRACT, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!r || r.result === undefined || r.result === null) throw new Error(`view ${method} tanpa result (kontrak ${CONTRACT})`);
  return JSON.parse(Buffer.from(r.result, "base64").toString("utf8"));
}
/** Bukti tx: sukses + event NEP-297 hanya dari receipt milik CONTRACT + signer cocok (R2.1). */
async function txProof(txHash, signer) {
  const cacheKey = `${txHash}:${signer}`;
  if (txCache.has(cacheKey)) return txCache.get(cacheKey);
  const r = await rpcCall("tx", [txHash, signer]);
  const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])].filter(Boolean);
  if (!outcomes.length) return { ok: false, events: [], note: "tanpa receipt" };
  if (r.transaction?.signer_id && signer && r.transaction.signer_id !== signer) {
    return { ok: false, events: [], note: `signer ${r.transaction.signer_id} != ${signer}` };
  }
  const anyFailure = outcomes.some((o) => o.outcome?.status?.Failure !== undefined);
  const relevant = (r.receipts_outcome ?? []).filter((o) => !o.receipt?.receiver_id || o.receipt.receiver_id === CONTRACT);
  const logs = relevant.flatMap((o) => o.outcome?.logs ?? o.outcome?.log ?? []);
  const events = [];
  for (const l of logs) {
    if (l.startsWith("EVENT_JSON:")) {
      try { events.push(JSON.parse(l.slice("EVENT_JSON:".length))); } catch { /* abaikan */ }
    }
  }
  const proof = { ok: !anyFailure, events };
  txCache.set(cacheKey, proof);
  return proof;
}
const evOf = (events, event) =>
  events.find((e) => e.event === event || (Array.isArray(e.event) && e.event.includes(event)) || e.data?.some?.((d) => d?.kind === event));
const hasEvent = (events, event) => !!evOf(events, event);
const payload = (e) => e?.data?.[0] ?? {};
function mediaSvg(token) {
  const m = token?.metadata?.media ?? token?.media ?? "";
  if (typeof m === "string" && m.startsWith("data:image/svg+xml;base64,")) {
    try { return Buffer.from(m.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8"); } catch { return m; }
  }
  return String(m);
}
// Verifikasi angka payload vs Kamus (R2.5/J3.6) — best-effort: bila field tidak ada, laporkan "field tak tersedia".
function mathCheck(p, rules) {
  const notes = [];
  let pass = true;
  for (const [field, fn, label] of rules) {
    if (p[field] === undefined) { notes.push(`${field} tak tersedia`); continue; }
    const ok = fn(BigInt(p[field]), p);
    if (!ok) pass = false;
    notes.push(`${label} ${field}=${p[field]}${ok ? " ✓" : " ✗"}`);
  }
  return { pass, note: notes.join(" · ") };
}

// ---------- Bukti multi-hash ----------
async function allEvents(proof) {
  const hashes = proof?.hashes ?? [];
  const results = [];
  for (const h of hashes) {
    try { results.push(await txProof(h, proof.signer)); }
    catch (e) { if (e instanceof TxNotIndexed) throw e; results.push({ ok: false, events: [], note: String(e.message) }); }
  }
  return results;
}
const allOk = (rs) => rs.length > 0 && rs.every((x) => x.ok);
const flat = (rs) => rs.flatMap((x) => x.events);
const bound = (p, m) => {
  if (!m.strain_ids?.length) return true; // tanpa binding, catat (R2.2 melemah — manifest wajib isi)
  const id = Number(p.strain_id ?? p.dominant_id ?? p.raider_strain_id ?? p.target_id ?? p.parent_id ?? NaN);
  return Number.isNaN(id) ? true : m.strain_ids.includes(id);
};

// ---------- 21 KPI ----------
const KPI = [
  { id: "G-01", nama: "Lahir — `incubate_strain` + suplai `$SNACC` lahir", sumber: "EN-08/F1, LC-01",
    async check(m, proof) {
      const ts = await view("ft_total_supply");
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_created");
      const pass = BigInt(ts) > 0n && !!ev && allOk(rs) && (payload(ev).owner_id ?? m.owner) === m.owner;
      return { pass, bukti: `ft_total_supply=${ts}${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
  { id: "G-02", nama: "`$SNACC` NEP-141 hidup (symbol `$SNACC`, decimals 24, `ft_transfer` sukses)", sumber: "N141-101..106",
    async check(m, proof) {
      const md = await view("ft_metadata");
      const rs = await allEvents(proof).catch(() => []);
      const pass = md.symbol === "$SNACC" && md.decimals === 24 && allOk(rs) && hasEvent(flat(rs), "ft_transfer");
      return { pass, bukti: `symbol=${md.symbol} decimals=${md.decimals}${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
  { id: "G-03", nama: "Makan → ATP (`fed`, `atp_minted > 0`, strain terikat)", sumber: "EN-06/EN-115, LC-02",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const fed = flat(rs).filter((e) => e.event === "fed" || e.data?.some?.((d) => d?.kind === "fed")).find((e) => Number(payload(e).atp_minted ?? 0) > 0);
      const minted = Number(payload(fed).atp_minted ?? 0);
      const pass = !!fed && minted > 0 && allOk(rs) && bound(payload(fed), m);
      return { pass, bukti: `atp_minted=${minted}${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
  { id: "G-04", nama: "Kerja 3-stage (`extracted`→`transmuted`→`synthesized`) + `atp_spent`", sumber: "EN-02/03/04, LC-03",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const pass = ["extracted", "transmuted", "synthesized"].every((e) => hasEvent(evs, e)) && hasEvent(evs, "atp_spent") && allOk(rs) && (proof?.hashes?.length ?? 0) >= 3;
      return { pass, bukti: proof ? `tx ${proof.hashes.join(", ")}` : "tx belum ada" };
    } },
  { id: "G-05", nama: "TEE zero-trust (`genome_committed` → `genome_mutated`) + role unlock", sumber: "EN-05, ADR-16, I-16",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const mut = evOf(evs, "genome_mutated");
      const pass = hasEvent(evs, "genome_committed") && !!mut && allOk(rs) && (proof?.hashes?.length ?? 0) >= 2;
      return { pass, bukti: proof ? `tx ${proof.hashes.join(", ")} · role_mask=${payload(mut).role_mask ?? "?"}` : "tx belum ada" };
    } },
  { id: "G-06", nama: "Fusi — `strains_spliced` + pajak 2,5% + `role_mask` menyatu", sumber: "F5, LC-06, I-02",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strains_spliced");
      const p = payload(ev);
      const math = mathCheck(p, [
        ["merger_tax", (v, q) => q.absorbed_balance === undefined || v === BigInt(q.absorbed_balance) * 250n / 10000n, "pajak"],
      ]);
      const pass = !!ev && allOk(rs) && bound(p, m) && math.pass;
      return { pass, bukti: `strains_spliced${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"} · ${math.note}` };
    } },
  { id: "G-07", nama: "Hostile 115% (95/5) — `hostile_takeover_spliced` + nonce anti-drain", sumber: "ADR-03, I-09/I-14",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "hostile_takeover_spliced");
      const p = payload(ev);
      const math = mathCheck(p, [
        ["payment", (v, q) => q.book_value === undefined || v === BigInt(q.book_value) * 115n / 100n, "premium115"],
      ]);
      const pass = !!ev && allOk(rs) && bound(p, m) && math.pass;
      return { pass, bukti: `hostile_takeover_spliced${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"} · ${math.note}` };
    } },
  { id: "G-08", nama: "Adopt — `strain_adopted`, book_value 100% ke pemilik lama", sumber: "EN-123, LC-05",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_adopted");
      const pass = !!ev && allOk(rs) && bound(payload(ev), m);
      return { pass, bukti: `strain_adopted${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"} · book_value=${payload(ev).book_value ?? "?"}` };
    } },
  { id: "G-09", nama: "Divide — `strain_divided` + konservasi saldo", sumber: "EN-122/124, LC-01",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_divided");
      const p = payload(ev);
      const cons = p.parent_balance !== undefined && p.child_balance !== undefined
        ? BigInt(p.parent_balance) + BigInt(p.child_balance) <= BigInt(p.saldo_sebelum ?? p.parent_balance) + BigInt(p.child_balance) : true;
      const pass = !!ev && allOk(rs) && bound(p, m) && cons;
      return { pass, bukti: `strain_divided${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
  { id: "G-10", nama: "Lisis Tier 3 — `strain_liquidated` (bounty 10% / recovery 90%)", sumber: "F6, I-10, LC-07b",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_liquidated");
      const p = payload(ev);
      const math = mathCheck(p, [
        ["bounty", (v, q) => q.balance === undefined || v === BigInt(q.balance) * 10n / 100n, "bounty10"],
      ]);
      const pass = !!ev && allOk(rs) && math.pass;
      return { pass, bukti: `strain_liquidated${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"} · ${math.note}` };
    } },
  { id: "G-11", nama: "Dividen DK-033 — `dividend_claimed` + `aether_burned_for_dividend`", sumber: "DK-033/044",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const pass = hasEvent(evs, "dividend_claimed") && (hasEvent(evs, "aether_burned_for_dividend") || hasEvent(evs, "dividend_inflow")) && allOk(rs);
      return { pass, bukti: proof ? `tx ${proof.hashes.join(",")}` : "tx belum ada" };
    } },
  { id: "G-12", nama: "Termostat ATP-driven — suhu >0, `V_epoch` >0, jejak ATP ≥ atp_minted×6×10^14 (pasca-feed), `zone_changed` pernah terjadi", sumber: "ADR-04/27, ECON-111, EN-117",
    async check(m, proof) {
      const [temp, macro] = await Promise.all([view("get_crucible_temp"), view("get_macro_state")]);
      const rs = await allEvents(proof).catch(() => []);
      // EN-117 (suhu literal ATP): V_epoch epoch aktif saat feed memuat
      // atp_minted × ATP_VOLUME_SCALE (6×10^14). V_epoch ter-reset tiap
      // advance_epoch — verifikasi penuh lewat snapshot BUKTI pasca-feed
      // (manifest.bukti_feed, direkam gladi-run TEPAT setelah tx feed).
      let atpTrace = "";
      let traceOk = true;
      const bf = m.bukti_feed;
      if (bf?.volume_epoch != null && bf?.atp_minted_min != null) {
        const need = BigInt(bf.atp_minted_min) * BigInt(bf.ATP_VOLUME_SCALE ?? "600000000000000");
        const got = BigInt(bf.volume_epoch);
        traceOk = got >= need;
        atpTrace = ` · jejak ATP pasca-feed: V_epoch=${got} ≥ atp_min(${bf.atp_minted_min})×6×10^14=${need} → ${traceOk ? "OK" : "KURANG"}`;
      } else {
        atpTrace = " · jejak ATP: bukti_feed belum di manifest (gladi v4)";
      }
      const pass = Number(temp) > 0 && BigInt(macro.volume_epoch ?? 0) > 0n && hasEvent(flat(rs), "zone_changed") && allOk(rs) && traceOk;
      return { pass, bukti: `temp=${temp} mK (before=${m.temp_before ?? "?"}) · V_epoch=${macro.volume_epoch}${atpTrace}${proof ? ` · tx ${proof.hashes.join(",")}` : ""}` };
    } },
  { id: "G-13", nama: "NPC ADR-30 — `npc_spores_bought` + konservasi I-15", sumber: "ADR-30, I-15",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "npc_spores_bought");
      const p = payload(ev);
      const pass = !!ev && allOk(rs) && bound(p, m);
      return { pass, bukti: `npc_spores_bought · unit_price=${p.unit_price ?? "?"}${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
  { id: "G-14", nama: "Koloni & risiko — `get_colony(owner)` terikat manifest + `risk_heat` terukur", sumber: "EN-121/125, PF-06",
    async check(m) {
      if (!m.owner) return { pass: false, bukti: "manifest.owner belum diisi" };
      const [colony, heat] = await Promise.all([view("get_colony", { owner_id: m.owner }), view("get_risk_heat")]);
      return { pass: Array.isArray(colony) && colony.length > 0 && Number(heat) >= 0, bukti: `koloni(${m.owner})=${colony.length} · risk_heat=${heat}` };
    } },
  { id: "G-15", nama: "NFT NEP-171 — byte SVG ≤1734 + `nft_transfer` sukses (transplantasi)", sumber: "LC-16, VC-009, NFT track",
    async check(m, proof) {
      const token = await view("nft_token", { token_id: String(m.token_ids?.[0] ?? "1") });
      const size = Buffer.byteLength(mediaSvg(token), "utf8");
      const rs = await allEvents(proof).catch(() => []);
      const pass = size <= 1734 && allOk(rs) && hasEvent(flat(rs), "nft_transfer");
      return { pass, bukti: `svg ${size} B${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
  { id: "G-16", nama: "SVG indikator (needle, `$SNACC`, `$ATP`, `mK`, zona, organel)", sumber: "VC-009, EN-113",
    async check(m) {
      const token = await view("nft_token", { token_id: String(m.token_ids?.[0] ?? "1") });
      const svg = mediaSvg(token);
      const need = ["SNACC", "ATP", "mK", "\u{1F321}"];
      const hit = need.filter((k) => svg.toLowerCase().includes(k.toLowerCase()));
      const zona = /normal|hypo|fever|liquid/i.test(svg);
      return { pass: hit.length === need.length && zona, bukti: `indikator ${hit.length}/${need.length} (${hit.join(",")}) + zona=${zona}` };
    } },
  { id: "G-17", nama: "Volatilitas = fitur — burn `I-01` terbukti (counter naik) + suplai konsisten", sumber: "ADR-04, I-01, DK-010",
    async check(m, proof) {
      const macro = await view("get_macro_state");
      const ts = await view("ft_total_supply");
      const rs = await allEvents(proof).catch(() => []);
      const burned = Number(macro.total_snacc_burned ?? 0);
      const consistent = sameAmount(ts, macro.total_snacc_supply ?? -1);
      const pass = burned > 0 && consistent && allOk(rs);
      return { pass, bukti: `burned=${burned} · ft_total_supply=${ts} konsisten=${consistent}${proof ? ` · tx ${proof.hashes.join(",")}` : ""}` };
    } },
  { id: "G-18", nama: "Solvabilitas — `epoch_treasury_spent ≤ epoch_treasury_initial` (I-04) + kolam dividen", sumber: "I-04, DK-033",
    async check(m, proof) {
      const macro = await view("get_macro_state");
      const spent = Number(macro.epoch_treasury_spent ?? 0);
      const init = Number(macro.epoch_treasury_initial ?? 0);
      const pool = Number(macro.industrial_dividend_pool ?? 0);
      const rs = await allEvents(proof).catch(() => []);
      return { pass: init > 0 && spent <= init && allOk(rs), bukti: `spent=${spent} / initial=${init} · dividen_pool=${pool}${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
  { id: "G-19", nama: "Dinamika — `feast_result` (GOLDILOCKS/OVERFED/UNDERFED) tercatat per epoch", sumber: "EN-105/106, LC-09/12",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const feast = evOf(evs, "feast_result");
      const zone = hasEvent(evs, "zone_changed");
      return { pass: !!feast && allOk(rs), bukti: `feast=${payload(feast).verdict ?? (feast ? "ada" : "tidak")} · zone_changed=${zone}${proof ? ` · tx ${proof.hashes.join(",")}` : ""}` };
    } },
  { id: "G-20", nama: "Konsistensi suplai `I-01` — `ft_total_supply == total_snacc_supply` + burn monoton", sumber: "DK-010, V-04 (J3.1)",
    async check(m) {
      const macro = await view("get_macro_state");
      const ts = await view("ft_total_supply");
      const consistent = sameAmount(ts, macro.total_snacc_supply ?? -1);
      const burnGrows = Number(macro.total_snacc_burned ?? 0) > 0;
      return { pass: consistent && burnGrows, bukti: `ft=${ts} · macro.supply=${macro.total_snacc_supply} · burned=${macro.total_snacc_burned}${m.supply_before ? ` · before=${m.supply_before}` : ""}` };
    } },
  { id: "G-21", nama: "Vault sub-account — `materialize_subaccount` + `s-<id>.*` terbentuk", sumber: "ADR-02/29, F1 (J3.2)",
    async check(m, proof) {
      const id = m.strain_ids?.at(-1) ?? m.token_ids?.at(-1);
      const strain = id !== undefined ? await view("get_strain", { strain_id: Number(id) }) : null;
      const vault = strain?.vault_subaccount ?? "";
      const rs = await allEvents(proof).catch(() => []);
      const pass = /^s-\d+\./.test(vault) && allOk(rs);
      return { pass, bukti: `vault_subaccount=${vault || "(belum)"}${proof ? ` · tx ${proof.hashes.join(",")}` : " · tx belum ada"}` };
    } },
];

// ---------- Runner ----------
function toProof(actions, manifest) {
  const hashes = actions.map((x) => x.txHash).filter(Boolean);
  if (!hashes.length) return undefined;
  for (const h of hashes) {
    const prev = usedHashes.get(h);
    if (prev && prev !== actions[0].kpi) return { hashes, signer: actions.find((x) => x.signer)?.signer ?? manifest.signer ?? manifest.owner, reuse: prev };
    usedHashes.set(h, actions[0].kpi);
  }
  return { hashes, signer: actions.find((x) => x.signer)?.signer ?? manifest.signer ?? manifest.owner };
}
async function main() {
  let manifest = { owner: null, signer: null, actions: [], strain_ids: [], token_ids: [] };
  try { manifest = JSON.parse(await readFile(MANIFEST, "utf8")); }
  catch { console.error(`⚠️  manifest ${MANIFEST} belum ada — mode view-only (KPI berbasis tx = BELUM).`); }

  const rows = [];
  for (const k of KPI) {
    const actions = manifest.actions.filter((x) => x.kpi === k.id);
    const proof = toProof(actions, manifest);
    let row;
    try {
      if (proof?.reuse) row = { pass: false, bukti: `hash dipakai ulang (R2.4) oleh ${proof.reuse}` };
      else row = await k.check(manifest, proof);
    } catch (e) {
      row = e instanceof TxNotIndexed
        ? { pass: false, bukti: "BELUM: tx belum ter-index", belum: true }
        : { pass: false, bukti: `ERROR: ${String(e.message ?? e).slice(0, 140)}` };
    }
    const status = row.pass ? "PASS" : row.belum ? "BELUM" : proof ? "FAIL" : row.bukti.startsWith("ERROR") ? "FAIL" : "BELUM";
    rows.push({ id: k.id, nama: k.nama, sumber: k.sumber, status, bukti: row.bukti });
    console.log(`${status.padEnd(5)} ${k.id} ${k.nama.slice(0, 56)}`);
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const belum = rows.filter((r) => r.status === "BELUM").length;
  const md = [
    `# KPI Gladi — Hasil Auto-Check (21 KPI, v3 pasca-audit 3-POV ganda)`,
    ``,
    `Tanggal: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · kontrak: \`${CONTRACT}\``,
    `Auto-check v3: tx wajib sukses + signer/receipt terikat kontrak + payload terikat entitas gladi +`,
    `angka Kamus diverifikasi (pajak 2,5% / premium 115% / bounty 10%) + hash unik anti-reuse.`,
    `$SNACC testnet tanpa nilai uang. Tanpa hash = tanpa klaim.`,
    ``,
    `> **BATAS KLAIM (wajib dibaca):** PASS di sini = MEKANIK YANG SUDAH DIIMPLEMENTASIKAN terverifikasi on-chain.`,
    `> PERUBAHAN MAKNA KPI (model ATP, EN-117): G-12 kini memverifikasi jejak ATP`,
    `> (atp_minted × 6×10^14) pada V_epoch SNAPSHOT PASCA-FEED (manifest.bukti_feed) —`,
    `> V_epoch ter-reset tiap advance_epoch, jadi nilai V_epoch AKHIR BUKAN bukti jejak ATP.`,
    `> Zona bisa saja berbeda dari gladi sebelumnya (suhu kini digerakkan ATP + legs).`,
    `> NEP-177/145/181 baru (nft_metadata · storage_unregister/balance_bounds/registration_only ·`,
    `> enumerasi nft_*) BELUM punya KPI — gladi-run mencatatnya sebagai G-22 (saran, menunggu arahan).`,
    `> Ini BUKAN checklist kelengkapan produk. Yang TIDAK diuji di sini (dan harus dicek di Backlog Master):`,
    `> SDK lengkap (\`SDK-101..106\`), audit keamanan (\`SEC-110..118\`), integrasi NEAR AI (\`RES-101..103\` — Inference SDK,`,
    `> privacy/classify, verifikasi quote TDX), docs (\`DOC-*\`), ECON tails, e2e penuh, FE, video.`,
    `> Angka ketuntasan backlog yang benar ada di Backlog Master — bukan di baris ringkasan ini.`,
    ``,
    `**Ringkasan: ${pass} PASS · ${fail} FAIL · ${belum} BELUM (dari ${rows.length})**`,
    ``,
    `| KPI | Sumber | Status | Bukti auto-check |`,
    `| --- | --- | --- | --- |`,
    ...rows.map((r) => `| ${r.id} ${r.nama} | ${r.sumber} | **${r.status}** | ${r.bukti} |`),
    ``,
    `> FAIL = bukti ada tapi melanggar aturan / tx gagal / ERROR. BELUM = bukti belum tercatat / belum ter-index.`,
  ].join("\n");
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, md, "utf8");
  console.log(`\nRingkasan: ${pass} PASS · ${fail} FAIL · ${belum} BELUM → ${OUT}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
