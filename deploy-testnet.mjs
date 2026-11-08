#!/usr/bin/env node
// deploy-testnet.mjs — deploy + migrate kontrak Snacc ke testnet (OPS gladi).
//   node scripts/deploy-testnet.mjs --key ../../.secrets/snacc/snacc-v001.testnet.json \
//     --wasm ../contracts/target/wasm32-unknown-unknown/release/snacc.wasm --contract snacc-v001.testnet
// Kunci dibaca dari file, TIDAK PERNAH dicetak/di-log. Testnet only.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = fileURLToPath(new URL(".", import.meta.url));
const { Account, JsonRpcProvider, KeyPairSigner } = createRequire(resolve(here, "../../x207/sdk/package.json"))("near-api-js");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const keyPath = resolve(arg("key"));
const wasmPath = resolve(arg("wasm"));
const contractId = arg("contract", "snacc-v001.testnet");
if (!contractId.endsWith(".testnet")) throw new Error("testnet only");

const provider = new JsonRpcProvider({ url: arg("rpc", "https://near-testnet.drpc.org") });
const keyJson = JSON.parse(readFileSync(keyPath, "utf8"));
const secret = keyJson.secret_key ?? keyJson.private_key;
if (!secret) throw new Error("file kunci tanpa secret_key/private_key");
const account = new Account(contractId, provider, KeyPairSigner.fromSecretKey(secret));

const code = readFileSync(wasmPath);
console.log(`deploy ${contractId} wasm ${code.length} B sha256 ${createHash("sha256").update(code).digest("hex")}`);
const deployed = await account.deployContract(code);
console.log(`DEPLOY_TX=${deployed.transaction.hash}`);

const migrated = await account.callFunctionRaw({
  contractId, methodName: "migrate", args: {}, deposit: 0n, gas: 100_000_000_000_000n, waitUntil: "FINAL",
});
console.log(`MIGRATE_TX=${migrated.transaction.hash}`);

// Verifikasi view pasca-migrate.
const view = async (method, args = {}) => {
  const r = await provider.query({ request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};
const md = await view("ft_metadata");
const macro = await view("get_macro_state");
const solv = await view("get_global_solvency");
const npc = await view("get_npc", { npc_id: "npc-extractor" });
console.log(`ft_metadata: name=${md.name} symbol=${md.symbol} decimals=${md.decimals}`);
console.log(`macro: epoch=${macro.current_epoch} supply=${macro.total_snacc_supply} fever_threshold=${macro.fever_threshold ?? "?"} volume=${macro.volume_epoch}`);
console.log(`solvency: solvent=${solv.solvent} drift=${solv.drift ?? "?"}`);
console.log(`npc-extractor: target=${npc.target_spores ?? npc.target_spore_stock ?? "?"} base=${npc.base_spore_price}`);
console.log("DEPLOY_OK");
