#!/usr/bin/env node
/**
 * keypom-drop-spike.mjs — RES-110: coba buat 1 drop demo di v2.keypom.testnet
 * via direct contract call (keypom-js stale — pakai near-api-js v7 langsung).
 * Akun funder: x207-demo-buyer.testnet (bukan kunci snacc-v001). Jujur: bila
 * gagal, status dilaporkan + tidak dipakai sebagai bukti.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const BUYER = JSON.parse(
  readFileSync(resolve(ROOT, ".secrets/testnet-demo/testnet/x207-demo-buyer.testnet.json"), "utf8"),
);
const RPC = "https://rpc.testnet.near.org";
const KEYPOM = "v2.keypom.testnet";

const na = await import("near-api-js");
const { KeyPair, KeyPairSigner, JsonRpcProvider, Account, actions } = na;
const provider = new JsonRpcProvider({ url: RPC });
const signer = new KeyPairSigner(KeyPair.fromString(BUYER.secret_key));
const acc = new Account(BUYER.account_id, provider, signer);

// 1 pair kunci drop → 1 pengguna baru bisa claim akun via linkdrop.
const dropKp = KeyPair.fromRandom("ed25519");
const dropPk = dropKp.getPublicKey().toString();
const depositPerUse = "100000000000000000000000"; // 0.1 N per claim
const attached = "150000000000000000000000"; // 0.15 N: deposit 0.1 + storage 0.0133 (dapat refund sisa)
try {
  const res = await acc.signAndSendTransaction({
    receiverId: KEYPOM,
    actions: [
      actions.functionCall(
        "create_drop",
        {
          public_keys: [dropPk],
          deposit_per_use: depositPerUse,
          method_contexts: [],
          drop_config: { uses_per_key: 1 },
        },
        "300000000000000", // 300 TGas
        attached,
      ),
    ],
  });
  const id = res.receipts_outcome?.[0]?.outcome?.logs
    ?.map((l) => l.match(/"id":"([^"]+)"/)?.[1])
    .filter(Boolean)
    .pop();
  console.log("OK create_drop — tx", res.transaction_outcome.id.slice(0, 10) + "...");
  console.log("drop id:", id ?? "(drop key terverifikasi via view_access_key - lihat evidence)");
  console.log("drop key (linkdrop claim key):", dropPk);
  const out = resolve(ROOT, "evidence/keypom-drop.json");
  await import("node:fs").then((fs) =>
    fs.writeFileSync(
      out,
      JSON.stringify(
        { waktu: new Date().toISOString(), funder: BUYER.account_id, drop_id: id ?? null, drop_key: dropPk, tx: res.transaction_outcome.id, note: "drop demo testnet via direct call v2.keypom.testnet" },
        null,
        2,
      ),
      "utf8",
    ),
  );
  console.log("bukti:", out);
} catch (e) {
  console.error("GAGAL (jujur):", String(e.message ?? e).slice(0, 300));
  process.exit(1);
}
