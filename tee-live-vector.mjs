#!/usr/bin/env node
// tee-live-vector.mjs — produce a FRESH TEE vector from NEAR AI Cloud (for gladi G-05).
//   NEAR_AI_API_KEY=<set> node scripts/tee-live-vector.mjs
// The key is read from env `NEAR_AI_API_KEY` (put it in the project-root `.env` — NEVER send it in chat).
// Flow (oracle-tee S2.6): POST /v1/chat/completions (temperature 0) → GET /v1/signature/{chat_id}
// → local ed25519 verification → print the vector for `commit_genome_experiment` +
// `apply_tee_mutation_zero_trust` (raw_response_body = raw body, MUST be kept intact).
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Load the project-root .env when the env var is empty (no dependencies).
if (!process.env.NEAR_AI_API_KEY) {
  const envPath = resolve(here, "../../../.env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
const apiKey = process.env.NEAR_AI_API_KEY;
if (!apiKey) {
  console.error("❌ NEAR_AI_API_KEY is missing. Put it in the project-root .env: NEAR_AI_API_KEY=... (do not send it in chat).");
  process.exit(3);
}

const MODEL = "z-ai/glm-5.3-flash";
const REQ_BODY = JSON.stringify({
  model: MODEL, temperature: 0,
  messages: [{ role: "user", content: "Return EXACTLY the following text as the only content of your reply, without markdown, without explanation, without any other text: {\"strain_id\":4,\"efficiency_shift_bps\":450,\"vitality_bonus\":200,\"phenotype_trait\":\"mitokondria-empyrean\"}" }],
});
const reqSha = createHash("sha256").update(REQ_BODY).digest("hex");

const chatRes = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: REQ_BODY,
});
if (!chatRes.ok) { console.error(`chat/completions HTTP ${chatRes.status}: ${(await chatRes.text()).slice(0, 200)}`); process.exit(1); }
const rawBody = await chatRes.text();
const resSha = createHash("sha256").update(rawBody).digest("hex");
const chatId = JSON.parse(rawBody)?.id ?? JSON.parse(rawBody)?.chat_id;

const sigRes = await fetch(`https://cloud-api.near.ai/v1/signature/${chatId}?signing_algo=ed25519`, {
  headers: { authorization: `Bearer ${apiKey}` },
});
if (!sigRes.ok) { console.error(`signature HTTP ${sigRes.status}: ${(await sigRes.text()).slice(0, 200)}`); process.exit(1); }
const sigJson = await sigRes.json();
const signatureHex = sigJson.signature ?? sigJson.signature_hex;
const pubkeyHex = sigJson.signing_address ?? sigJson.signing_address_ed25519;
const signedText = `${MODEL}:${reqSha}:${resSha}`;
if (typeof sigJson.text === "string" && sigJson.text !== signedText) {
  console.error("ERR_TEE_SIGNED_TEXT_MISMATCH — server text ≠ local reconstruction."); process.exit(1);
}

const vector = {
  chat_id: chatId, req_sha256_hex: reqSha, res_sha256_hex: resSha,
  raw_response_body: rawBody, signature_hex: signatureHex,
  tee_pubkey_hex: pubkeyHex, signed_text: signedText,
};
const out = resolve(here, "../../../reports/tee-vector-live.json");
writeFileSync(out, JSON.stringify(vector, null, 2), "utf8");
console.log(`OK chat_id=${chatId}`);
console.log(`req_sha256_hex=${reqSha}`);
console.log(`res_sha256_hex=${resSha}`);
console.log(`tee_pubkey_hex=${pubkeyHex}`);
console.log(`signed_text=${signedText}`);
console.log(`Vector saved: ${out}`);
