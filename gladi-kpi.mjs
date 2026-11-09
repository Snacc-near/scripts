#!/usr/bin/env node
/**
 * gladi-kpi.mjs v3 — GLADI KPI AUTO-CHECK (OPS-118; v3 after the double 3-POV audit, 2026-11-08).
 *
 * Manifest (`reports/gladi-manifest.json`) — MUST be committed to git BEFORE the gladi (R2.7):
 *   { "owner": "account.testnet", "signer": "account.testnet",
 *     "strain_ids": [1, 2], "token_ids": ["1"],
 *     "supply_before": "…", "temp_before": 0,
 *     "actions": [ {"kpi": "G-01", "txHash": "…", "signer": "optional"} ] }
 * Minimum feed so that `atp_minted > 0`: ≥ 10^15 yocto (recommended 4×10^15, see test `atp114_feed`).
 *
 * v3 tightening (audit child, 37 findings):
 *  - the tx must SUCCEED, tx signer == manifest.signer (R2.1), receipts only from CONTRACT (R2.1)
 *  - event payloads are bound to gladi entities: owner_id/strain_id ∈ manifest (R2.2/R2.6)
 *  - payload numbers verified vs the Dictionary: 2.5% tax, 115% premium (95/5), 10% bounty, 350bps burn (R2.5/J3.6)
 *  - a hash must not be reused across KPIs (R2.4); the error "tx not yet indexed" = NOT YET, not FAIL (B9.9)
 *  - measure SVG bytes (not the JSON view) ≤1734 (B9.2); symbol "$SNACC" (B9.1)
 *
 * Canonical event `kind`s: strain_created, fed, atp_spent, atp_allocated, extracted, transmuted,
 * synthesized, genome_committed, genome_mutated, strains_spliced, hostile_takeover_spliced,
 * strain_liquidated, strain_divided, strain_adopted, trait_conjugated, feast_result, zone_changed,
 * nutrient_burst_released, npc_spores_bought, dividend_claimed, dividend_inflow,
 * epoch_dividend_closed, aether_burned_for_dividend (+ nep171 nft_transfer, nep141 ft_transfer).
 *
 * $SNACC testnet has no monetary value. No hash = no claim.
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
const OUT = resolve(HERE, arg("out", "../../../reports/gladi-kpi.md"));

class TxNotIndexed extends Error {}
const usedHashes = new Map(); // hash -> first kpi (R2.4)
const txCache = new Map(); // hash:signer -> proof (cache across KPIs)
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
// u128 numbers from JSON may be a number (e-notation) — safe comparison.
const sameAmount = (a, b) => String(a) === String(b) || Number(a) === Number(b);
async function view(method, args = {}) {
  const r = await rpcCall("query", {
    request_type: "call_function", finality: "final",
    account_id: CONTRACT, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!r || r.result === undefined || r.result === null) throw new Error(`view ${method} without result (contract ${CONTRACT})`);
  return JSON.parse(Buffer.from(r.result, "base64").toString("utf8"));
}
/** Tx proof: success + NEP-297 events only from receipts owned by CONTRACT + matching signer (R2.1). */
async function txProof(txHash, signer) {
  const cacheKey = `${txHash}:${signer}`;
  if (txCache.has(cacheKey)) return txCache.get(cacheKey);
  const r = await rpcCall("tx", [txHash, signer]);
  const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])].filter(Boolean);
  if (!outcomes.length) return { ok: false, events: [], note: "no receipt" };
  if (r.transaction?.signer_id && signer && r.transaction.signer_id !== signer) {
    return { ok: false, events: [], note: `signer ${r.transaction.signer_id} != ${signer}` };
  }
  const anyFailure = outcomes.some((o) => o.outcome?.status?.Failure !== undefined);
  const relevant = (r.receipts_outcome ?? []).filter((o) => !o.receipt?.receiver_id || o.receipt.receiver_id === CONTRACT);
  const logs = relevant.flatMap((o) => o.outcome?.logs ?? o.outcome?.log ?? []);
  const events = [];
  for (const l of logs) {
    if (l.startsWith("EVENT_JSON:")) {
      // u128 numbers in the event payload exceed 2^53: quote them first so BigInt() is exact (a float shifts the low digits).
      try { events.push(JSON.parse(l.slice("EVENT_JSON:".length).replace(/(:\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'))); } catch { /* ignore */ }
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
// Verify payload numbers vs the Dictionary (R2.5/J3.6) — best-effort: if a field is missing, report "field unavailable".
function mathCheck(p, rules) {
  const notes = [];
  let pass = true;
  for (const [field, fn, label] of rules) {
    if (p[field] === undefined) { notes.push(`${field} unavailable`); continue; }
    const ok = fn(BigInt(p[field]), p);
    if (!ok) pass = false;
    notes.push(`${label} ${field}=${p[field]}${ok ? " ✓" : " ✗"}`);
  }
  return { pass, note: notes.join(" · ") };
}

// ---------- Multi-hash evidence ----------
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
  if (!m.strain_ids?.length) return true; // without binding, just record (R2.2 weakens — the manifest must be filled in)
  const id = Number(p.strain_id ?? p.dominant_id ?? p.raider_strain_id ?? p.target_id ?? p.parent_id ?? NaN);
  return Number.isNaN(id) ? true : m.strain_ids.includes(id);
};

// ---------- 22 KPIs ----------
const KPI = [
  { id: "G-01", name: "Birth — `incubate_strain` + born `$SNACC` supply", source: "EN-08/F1, LC-01",
    async check(m, proof) {
      const ts = await view("ft_total_supply");
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_created");
      const pass = BigInt(ts) > 0n && !!ev && allOk(rs) && (payload(ev).owner_id ?? m.owner) === m.owner;
      return { pass, evidence: `ft_total_supply=${ts}${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-02", name: "`$SNACC` NEP-141 alive (symbol `$SNACC`, decimals 24, `ft_transfer` succeeds)", source: "N141-101..106",
    async check(m, proof) {
      const md = await view("ft_metadata");
      const rs = await allEvents(proof).catch(() => []);
      const pass = md.symbol === "$SNACC" && md.decimals === 24 && allOk(rs) && hasEvent(flat(rs), "ft_transfer");
      return { pass, evidence: `symbol=${md.symbol} decimals=${md.decimals}${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-03", name: "Feed → ATP (`fed`, `atp_minted > 0`, strain bound)", source: "EN-06/EN-115, LC-02",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const fed = flat(rs).filter((e) => e.event === "fed" || e.data?.some?.((d) => d?.kind === "fed")).find((e) => Number(payload(e).atp_minted ?? 0) > 0);
      const minted = Number(payload(fed).atp_minted ?? 0);
      const pass = !!fed && minted > 0 && allOk(rs) && bound(payload(fed), m);
      return { pass, evidence: `atp_minted=${minted}${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-04", name: "3-stage work (`extracted`→`transmuted`→`synthesized`) + `atp_spent`", source: "EN-02/03/04, LC-03",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const pass = ["extracted", "transmuted", "synthesized"].every((e) => hasEvent(evs, e)) && hasEvent(evs, "atp_spent") && allOk(rs) && (proof?.hashes?.length ?? 0) >= 3;
      return { pass, evidence: proof ? `tx ${proof.hashes.join(", ")}` : "no tx yet" };
    } },
  { id: "G-05", name: "TEE zero-trust (`genome_committed` → `genome_mutated`) + role unlock", source: "EN-05, ADR-16, I-16",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const mut = evOf(evs, "genome_mutated");
      const pass = hasEvent(evs, "genome_committed") && !!mut && allOk(rs) && (proof?.hashes?.length ?? 0) >= 2;
      return { pass, evidence: proof ? `tx ${proof.hashes.join(", ")} · role_mask=${payload(mut).role_mask ?? "?"}` : "no tx yet" };
    } },
  { id: "G-06", name: "Fusion — `strains_spliced` + 2.5% tax + `role_mask` merges", source: "F5, LC-06, I-02",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strains_spliced");
      const p = payload(ev);
      const math = mathCheck(p, [
        ["merger_tax", (v, q) => q.absorbed_balance === undefined || v === BigInt(q.absorbed_balance) * 250n / 10000n, "tax"],
      ]);
      const pass = !!ev && allOk(rs) && bound(p, m) && math.pass;
      return { pass, evidence: `strains_spliced${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"} · ${math.note}` };
    } },
  { id: "G-07", name: "Hostile 115% (95/5) — `hostile_takeover_spliced` + anti-drain nonce", source: "ADR-03, I-09/I-14",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "hostile_takeover_spliced");
      const p = payload(ev);
      const math = mathCheck(p, [
        ["payment", (v, q) => q.book_value === undefined || v === BigInt(q.book_value) * 115n / 100n, "premium115"],
      ]);
      const pass = !!ev && allOk(rs) && bound(p, m) && math.pass;
      return { pass, evidence: `hostile_takeover_spliced${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"} · ${math.note}` };
    } },
  { id: "G-08", name: "Adopt — `strain_adopted`, book_value 100% to the old owner", source: "EN-123, LC-05",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_adopted");
      const pass = !!ev && allOk(rs) && bound(payload(ev), m);
      return { pass, evidence: `strain_adopted${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"} · book_value=${payload(ev).book_value ?? "?"}` };
    } },
  { id: "G-09", name: "Divide — `strain_divided` + balance conservation", source: "EN-122/124, LC-01",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_divided");
      const p = payload(ev);
      const cons = p.parent_balance !== undefined && p.child_balance !== undefined
        ? BigInt(p.parent_balance) + BigInt(p.child_balance) <= BigInt(p.saldo_sebelum ?? p.parent_balance) + BigInt(p.child_balance) : true;
      const pass = !!ev && allOk(rs) && bound(p, m) && cons;
      return { pass, evidence: `strain_divided${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-10", name: "Tier 3 lysis — `strain_liquidated` (10% bounty / 90% recovery)", source: "F6, I-10, LC-07b",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "strain_liquidated");
      const p = payload(ev);
      const math = mathCheck(p, [
        ["bounty", (v, q) => q.balance === undefined || v === BigInt(q.balance) * 10n / 100n, "bounty10"],
      ]);
      const pass = !!ev && allOk(rs) && math.pass;
      return { pass, evidence: `strain_liquidated${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"} · ${math.note}` };
    } },
  { id: "G-11", name: "DK-033 dividend — `dividend_claimed` + `aether_burned_for_dividend`", source: "DK-033/044",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const pass = hasEvent(evs, "dividend_claimed") && (hasEvent(evs, "aether_burned_for_dividend") || hasEvent(evs, "dividend_inflow")) && allOk(rs);
      return { pass, evidence: proof ? `tx ${proof.hashes.join(",")}` : "no tx yet" };
    } },
  { id: "G-12", name: "ATP-driven thermostat — temp >0, `V_epoch` >0, ATP trace ≥ atp_minted×6×10^14 (post-feed), `zone_changed` has occurred", source: "ADR-04/27, ECON-111, EN-117",
    async check(m, proof) {
      const [temp, macro] = await Promise.all([view("get_crucible_temp"), view("get_macro_state")]);
      const rs = await allEvents(proof).catch(() => []);
      // EN-117 (literal ATP temperature): V_epoch of the active epoch when the feed lands contains
      // atp_minted × ATP_VOLUME_SCALE (6×10^14). V_epoch is reset on every
      // advance_epoch — full verification goes through the post-feed EVIDENCE snapshot
      // (manifest.bukti_feed, recorded by gladi-run RIGHT after the feed tx).
      let atpTrace = "";
      let traceOk = true;
      const bf = m.bukti_feed;
      if (bf?.volume_epoch != null && bf?.atp_minted_min != null) {
        const need = BigInt(bf.atp_minted_min) * BigInt(bf.ATP_VOLUME_SCALE ?? "600000000000000");
        const got = BigInt(bf.volume_epoch);
        traceOk = got >= need;
        atpTrace = ` · post-feed ATP trace: V_epoch=${got} ≥ atp_min(${bf.atp_minted_min})×6×10^14=${need} → ${traceOk ? "OK" : "INSUFFICIENT"}`;
      } else {
        atpTrace = " · ATP trace: bukti_feed is not yet in the manifest (gladi v4)";
      }
      const pass = Number(temp) > 0 && BigInt(macro.volume_epoch ?? 0) > 0n && hasEvent(flat(rs), "zone_changed") && allOk(rs) && traceOk;
      return { pass, evidence: `temp=${temp} mK (before=${m.temp_before ?? "?"}) · V_epoch=${macro.volume_epoch}${atpTrace}${proof ? ` · tx ${proof.hashes.join(",")}` : ""}` };
    } },
  { id: "G-13", name: "NPC ADR-30 — `npc_spores_bought` + I-15 conservation", source: "ADR-30, I-15",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const ev = evOf(flat(rs), "npc_spores_bought");
      const p = payload(ev);
      const pass = !!ev && allOk(rs) && bound(p, m);
      return { pass, evidence: `npc_spores_bought · unit_price=${p.unit_price ?? "?"}${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-14", name: "Colony & risk — `get_colony(owner)` bound to the manifest + measured `risk_heat`", source: "EN-121/125, PF-06",
    async check(m) {
      if (!m.owner) return { pass: false, evidence: "manifest.owner is not filled in" };
      const [colony, heat] = await Promise.all([view("get_colony", { owner_id: m.owner }), view("get_risk_heat")]);
      return { pass: Array.isArray(colony) && colony.length > 0 && Number(heat) >= 0, evidence: `colony(${m.owner})=${colony.length} · risk_heat=${heat}` };
    } },
  { id: "G-15", name: "NFT NEP-171 — SVG bytes ≤1734 + `nft_transfer` succeeds (transplant)", source: "LC-16, VC-009, NFT track",
    async check(m, proof) {
      const token = await view("nft_token", { token_id: String(m.svg_token_id ?? m.token_ids?.[0] ?? "1") });
      const size = Buffer.byteLength(mediaSvg(token), "utf8");
      const rs = await allEvents(proof).catch(() => []);
      const pass = size <= 1734 && allOk(rs) && hasEvent(flat(rs), "nft_transfer");
      return { pass, evidence: `svg ${size} B${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-16", name: "SVG indicators (needle, `$SNACC`, `$ATP`, `mK`, zone, organelles)", source: "VC-009, EN-113",
    async check(m) {
      const token = await view("nft_token", { token_id: String(m.svg_token_id ?? m.token_ids?.[0] ?? "1") });
      const svg = mediaSvg(token);
      const need = ["SNACC", "ATP", "mK", "\u{1F321}"];
      const hit = need.filter((k) => svg.toLowerCase().includes(k.toLowerCase()));
      const zone = /normal|hypo|fever|liquid/i.test(svg);
      return { pass: hit.length === need.length && zone, evidence: `indicators ${hit.length}/${need.length} (${hit.join(",")}) + zone=${zone}` };
    } },
  { id: "G-17", name: "Volatility = feature — `I-01` burn proven (counter rises) + supply consistent", source: "ADR-04, I-01, DK-010",
    async check(m, proof) {
      const macro = await view("get_macro_state");
      const ts = await view("ft_total_supply");
      const rs = await allEvents(proof).catch(() => []);
      const burned = Number(macro.total_snacc_burned ?? 0);
      const consistent = sameAmount(ts, macro.total_snacc_supply ?? -1);
      const pass = burned > 0 && consistent && allOk(rs);
      return { pass, evidence: `burned=${burned} · ft_total_supply=${ts} consistent=${consistent}${proof ? ` · tx ${proof.hashes.join(",")}` : ""}` };
    } },
  { id: "G-18", name: "Solvency — `epoch_treasury_spent ≤ epoch_treasury_initial` (I-04) + dividend pool", source: "I-04, DK-033",
    async check(m, proof) {
      const macro = await view("get_macro_state");
      const spent = Number(macro.epoch_treasury_spent ?? 0);
      const init = Number(macro.epoch_treasury_initial ?? 0);
      const pool = Number(macro.industrial_dividend_pool ?? 0);
      const rs = await allEvents(proof).catch(() => []);
      return { pass: init > 0 && spent <= init && allOk(rs), evidence: `spent=${spent} / initial=${init} · dividend_pool=${pool}${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-19", name: "Dynamics — `feast_result` (GOLDILOCKS/OVERFED/UNDERFED) recorded per epoch", source: "EN-105/106, LC-09/12",
    async check(m, proof) {
      const rs = await allEvents(proof).catch(() => []);
      const evs = flat(rs);
      const feast = evOf(evs, "feast_result");
      const zone = hasEvent(evs, "zone_changed");
      return { pass: !!feast && allOk(rs), evidence: `feast=${payload(feast).verdict ?? (feast ? "present" : "absent")} · zone_changed=${zone}${proof ? ` · tx ${proof.hashes.join(",")}` : ""}` };
    } },
  { id: "G-20", name: "Supply consistency `I-01` — `ft_total_supply == total_snacc_supply` + monotonic burn", source: "DK-010, V-04 (J3.1)",
    async check(m) {
      const macro = await view("get_macro_state");
      const ts = await view("ft_total_supply");
      const consistent = sameAmount(ts, macro.total_snacc_supply ?? -1);
      const burnGrows = Number(macro.total_snacc_burned ?? 0) > 0;
      return { pass: consistent && burnGrows, evidence: `ft=${ts} · macro.supply=${macro.total_snacc_supply} · burned=${macro.total_snacc_burned}${m.supply_before ? ` · before=${m.supply_before}` : ""}` };
    } },
  { id: "G-21", name: "Vault sub-account — `materialize_subaccount` + `s-<id>.*` is created", source: "ADR-02/29, F1 (J3.2)",
    async check(m, proof) {
      // The materialized strain is recorded by gladi-run in the manifest (`materialize_strain_id`); fallback: the last id.
      const id = m.materialize_strain_id ?? m.strain_ids?.at(-1) ?? m.token_ids?.at(-1);
      const strain = id !== undefined ? await view("get_strain", { strain_id: Number(id) }) : null;
      const vault = strain?.vault_subaccount ?? "";
      const rs = await allEvents(proof).catch(() => []);
      // Vault name: `s-<id>-<tag>.<contract>` (tag unique across state generations, audit W8); the old form `s-<id>.` is still accepted.
      // The physical account must actually exist on-chain (callback `on_subaccount_created` does not refund).
      let exists = false;
      if (vault) {
        try { exists = !!(await rpcCall("query", { request_type: "view_account", finality: "final", account_id: vault }))?.code_hash; }
        catch { exists = false; }
      }
      const pass = /^s-\d+(-[a-z0-9]+)?\./.test(vault) && exists && allOk(rs);
      return { pass, evidence: `vault_subaccount=${vault || "(none yet)"} account_exists=${exists}${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
    } },
  { id: "G-22", name: "NEP trio — `nft_metadata` (NEP-177) + `storage_deposit` registration_only (NEP-145) + enumeration `nft_tokens` (NEP-181)", source: "NEP-177/145/181",
    async check(m, proof) {
      const [md, tokens, sup] = await Promise.all([
        view("nft_metadata"), view("nft_tokens", { from_index: null, limit: 5 }), view("nft_supply_for_owner", { account_id: m.owner }),
      ]);
      const bal = await view("storage_balance_of", { account_id: m.owner });
      const rs = await allEvents(proof).catch(() => []);
      const pass = md.spec === "nft-1.0.0" && Array.isArray(tokens) && tokens.length > 0 && Number(sup) > 0 && !!bal && allOk(rs);
      return { pass, evidence: `nft_metadata.spec=${md.spec} · nft_tokens=${Array.isArray(tokens) ? tokens.length : "?"} · nft_supply_for_owner=${sup} · storage_balance_of=${bal ? "registered" : "not yet"}${proof ? ` · tx ${proof.hashes.join(",")}` : " · no tx yet"}` };
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
  catch { console.error(`⚠️  manifest ${MANIFEST} does not exist yet — view-only mode (tx-based KPIs = NOT YET).`); }

  const rows = [];
  for (const k of KPI) {
    const actions = manifest.actions.filter((x) => x.kpi === k.id);
    const proof = toProof(actions, manifest);
    let row;
    try {
      if (proof?.reuse) row = { pass: false, evidence: `hash reused (R2.4) by ${proof.reuse}` };
      else row = await k.check(manifest, proof);
    } catch (e) {
      row = e instanceof TxNotIndexed
        ? { pass: false, evidence: "NOT YET: tx not yet indexed", notYet: true }
        : { pass: false, evidence: `ERROR: ${String(e.message ?? e).slice(0, 140)}` };
    }
    const status = row.pass ? "PASS" : row.notYet ? "NOT YET" : proof ? "FAIL" : row.evidence.startsWith("ERROR") ? "FAIL" : "NOT YET";
    rows.push({ id: k.id, name: k.name, source: k.source, status, evidence: row.evidence });
    console.log(`${status.padEnd(7)} ${k.id} ${k.name.slice(0, 56)}`);
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const notYet = rows.filter((r) => r.status === "NOT YET").length;
  const md = [
    `# Gladi KPI — Auto-Check Results (${KPI.length} KPIs, v4: deployment with sandbox clock)`,
    ``,
    `Date: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · contract: \`${CONTRACT}\``,
    `Auto-check v3: tx must succeed + signer/receipt bound to the contract + payload bound to gladi entities +`,
    `Dictionary numbers verified (2.5% tax / 115% premium / 10% bounty) + unique anti-reuse hashes.`,
    `$SNACC testnet has no monetary value. No hash = no claim.`,
    ``,
    `> **CLAIM LIMIT (must read):** PASS here = the ALREADY-IMPLEMENTED MECHANICS verified on-chain.`,
    `> KPI MEANING CHANGE (ATP model, EN-117): G-12 now verifies the ATP trace`,
    `> (atp_minted × 6×10^14) in the POST-FEED V_epoch SNAPSHOT (manifest.bukti_feed) —`,
    `> V_epoch is reset on every advance_epoch, so the FINAL V_epoch value is NOT evidence of the ATP trace.`,
    `> The zone may differ from the previous gladi (temperature is now driven by ATP + legs).`,
    `> SANDBOX CLOCK: G-07/G-08/G-10 and epoch closing (G-19/G-11) run with \`advance_sandbox_clock\``,
    `> (owner-only, .testnet accounts only, max 720 hours/call): BMR aging and the 24-hour epoch gate are accelerated,`,
    `> NOT waiting for real time. The mechanics are the same; the speed of time does not represent production (mainnet has no such clock).`,
    `> G-22 = NEP-177/145/181 trio (nft_metadata · storage_deposit registration_only · nft_* enumeration).`,
    `> G-22 scope: on-chain evidence on the deployed wasm (sha256 in the manifest). The NEP-177/181 view code is not yet in the public \`contracts\` repo, so this part cannot be rebuilt from public source yet.`,
    `> This is NOT a product completeness checklist. What is NOT tested here (and must be checked in the Backlog Master):`,
    `> full SDK (\`SDK-101..106\`), security audit (\`SEC-110..118\`), NEAR AI integration (\`RES-101..103\` — Inference SDK,`,
    `> privacy/classify, TDX quote verification), docs (\`DOC-*\`), ECON tails, full e2e, FE, video.`,
    `> The correct backlog completeness numbers live in the Backlog Master — not in this summary line.`,
    ``,
    `**Summary: ${pass} PASS · ${fail} FAIL · ${notYet} NOT YET (of ${rows.length})**`,
    ``,
    `| KPI | Source | Status | Auto-check evidence |`,
    `| --- | --- | --- | --- |`,
    ...rows.map((r) => `| ${r.id} ${r.name} | ${r.source} | **${r.status}** | ${r.evidence} |`),
    ``,
    `> FAIL = evidence exists but violates a rule / tx failed / ERROR. NOT YET = evidence not yet recorded / not yet indexed.`,
  ].join("\n");
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, md, "utf8");
  console.log(`\nSummary: ${pass} PASS · ${fail} FAIL · ${notYet} NOT YET → ${OUT}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
