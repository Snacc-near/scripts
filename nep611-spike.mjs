#!/usr/bin/env node
/**
 * nep611-spike.mjs — RES-111 spike: function-call key terbatas (NEP-611 style)
 * di akun uji testnet. TANPA menyentuh kunci snacc-v001.
 *
 * Akun uji: x207-demo-buyer.testnet (kunci di .secrets/testnet-demo/testnet/).
 * Langkah:
 *   1. Buat keypair baru (implicit-account style id) — kunci penuh TIDAK dipakai user.
 *   2. Buyer membuat akun baru + top-up kecil (untuk storage/gas sendiri).
 *   3. add_key function-call key terbatas: allowance 0,001 N; method_names
 *      ["incubate_strain","feed_strain"]; receiver snacc-v001.testnet.
 *   4. Verifikasi access key di chain (allowance + method names persis).
 *   5. Hapus kunci lagi (bersih-bersih) + verifikasi hilang.
 *
 * Pakai: node nep611-spike.mjs  (butuh near-api-js — di-install lokal bila belum)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const SECRETS = resolve(ROOT, ".secrets/testnet-demo/testnet");
const BUYER_FILE = resolve(SECRETS, "x207-demo-buyer.testnet.json");
const NETWORK = "testnet";
const RPC = "https://rpc.testnet.near.org";
const CONTRACT = "snacc-v001.testnet";
const ALLOWANCE = "1000000000000000000000"; // 0.001 N
const METHODS = ["incubate_strain", "feed_strain"];

async function main() {
  if (!existsSync(BUYER_FILE)) {
    console.error(`FATAL: akun uji tidak ada: ${BUYER_FILE}`);
    process.exit(2);
  }
  const buyer = JSON.parse(readFileSync(BUYER_FILE, "utf8"));
  console.log(`Akun uji: ${buyer.account_id} (Bukan kunci snacc-v001 ✓)`);

  // near-api-js v7: provider + signer + actions (tanpa `connect`).
  const na = await import("near-api-js");
  const { KeyPair, KeyPairSigner, JsonRpcProvider, actions, keyToImplicitAddress } = na;
  const provider = new JsonRpcProvider({ url: RPC });

  const keyPairNew = KeyPair.fromRandom("ed25519");
  const pkNew = keyPairNew.getPublicKey().toString();
  const implicitId = na.keyToImplicitAddress(keyPairNew.getPublicKey());
  console.log(`Keypair baru: ${pkNew.slice(0, 20)}... - implicit id: ${implicitId.slice(0, 16)}...`);

  const buyerSigner = new KeyPairSigner(KeyPair.fromString(buyer.secret_key));
  const buyerAcc = new na.Account(buyer.account_id, provider, buyerSigner);

  // 1. create_account baru (implicit): transfer 0.02 N (storage + gas).
  const createAmt = "20000000000000000000000"; // 0.02 N
  const resCreate = await buyerAcc.signAndSendTransaction({
    receiverId: implicitId,
    actions: [actions.transfer(createAmt)],
  });
  const gasCreate = resCreate.transaction_outcome.outcome.gas_burnt;
  console.log(`OK create_account (implicit) - gas ${gasCreate} - tx ${resCreate.transaction_outcome.id.slice(0, 10)}...`);

  const newSigner = new KeyPairSigner(keyPairNew);
  const newAcc = new na.Account(implicitId, provider, newSigner);

  // 2. add_key function-call terbatas (NEP-611 style): allowance + method_names.
  const fkey = KeyPair.fromRandom("ed25519");
  const resAdd = await newAcc.addFunctionCallAccessKey({
    publicKey: fkey.getPublicKey().toString(),
    contractId: CONTRACT,
    methodNames: METHODS,
    allowance: BigInt(ALLOWANCE),
  });
  console.log(`OK add_key fcall terbatas (allowance ${ALLOWANCE}, methods ${METHODS.join(",")}) - tx ${resAdd.transaction_outcome.id.slice(0, 10)}...`);

  // 3. Verifikasi access key di chain: allowance & method_names persis.
  const pkView = await provider.query({
    request_type: "view_access_key",
    finality: "final",
    account_id: implicitId,
    public_key: fkey.getPublicKey().toString(),
  });
  const perm = pkView.permission;
  const ok =
    perm.FunctionCall &&
    perm.FunctionCall.allowance === ALLOWANCE &&
    JSON.stringify(perm.FunctionCall.method_names) === JSON.stringify(METHODS) &&
    perm.FunctionCall.receiver_id === CONTRACT;
  console.log(`${ok ? "OK" : "GAGAL"} access key di chain: allowance=${perm?.FunctionCall?.allowance} - methods=${JSON.stringify(perm?.FunctionCall?.method_names)} - receiver=${perm?.FunctionCall?.receiver_id}`);

  // 4. Bukti tanpa kunci penuh: fkey ini-lah yang dipakai browser menandatangani
  //    incubate_strain (di spike ini tidak dipanggil - butuh stake $SNACC).

  // 5. Bersih-bersih: delete_key fcall.
  const resDel = await newAcc.signAndSendTransaction({
    receiverId: implicitId,
    actions: [actions.deleteKey(fkey.getPublicKey())],
  });
  console.log(`OK delete_key (bersih-bersih) - tx ${resDel.transaction_outcome.id.slice(0, 10)}...`);

  // Tulis bukti spike.
  const out = resolve(ROOT, "evidence/nep611-spike.json");
  writeFileSync(
    out,
    JSON.stringify(
      {
        waktu: new Date().toISOString(),
        buyer: buyer.account_id,
        akun_baru: implicitId,
        public_key_baru: pkNew,
        fkey_public: fkey.getPublicKey().toString(),
        allowance: ALLOWANCE,
        method_names: METHODS,
        receiver: CONTRACT,
        verifikasi_chain: { ok, permission: perm },
        tx: {
          create: resCreate.transaction_outcome.id,
          add_key: resAdd.transaction_outcome.id,
          delete: resDel.transaction_outcome.id,
        },
        near_api_js: "v7 (dipasang --no-save dev-only)",
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`SPIKE SELESAI - bukti: ${out}`);

}

main().catch((e) => {
  console.error("SPIKE GAGAL:", e?.message ?? e);
  process.exit(1);
});
