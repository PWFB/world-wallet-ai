import { Transaction } from "@solana/web3.js";

function decodeBase64(value) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("The prepared Solana transaction is not valid base64.");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (!bytes.length) throw new Error("The prepared Solana transaction is empty.");
  return bytes;
}

export function decodePreparedSolanaDelivery(unsignedTransactionBase64, expectedAuthority) {
  if (typeof expectedAuthority !== "string" || !expectedAuthority.trim()) {
    throw new Error("The configured delivery authority is unavailable.");
  }
  let transaction;
  try {
    transaction = Transaction.from(decodeBase64(unsignedTransactionBase64));
  } catch (error) {
    throw new Error("Could not decode the prepared Solana transaction.");
  }
  const message = transaction.compileMessage();
  const feePayer = message.accountKeys?.[0]?.toBase58?.() || "";
  const requiredSigners = message.accountKeys.slice(0, message.header.numRequiredSignatures).map(key => key.toBase58());
  if (feePayer !== expectedAuthority || !requiredSigners.includes(expectedAuthority)) {
    throw new Error("The prepared transaction does not require the configured delivery authority as fee payer.");
  }
  if (message.instructions.length !== 1) {
    throw new Error("The prepared transaction does not contain exactly one instruction.");
  }
  const instruction = transaction.instructions[0];
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  if (instruction.programId?.toBase58?.() !== tokenProgram) {
    throw new Error("The prepared transaction is not a classic SPL Token instruction.");
  }
  const data = instruction.data;
  if (!(data instanceof Uint8Array) || data.length !== 10 || data[0] !== 12) {
    throw new Error("The prepared transaction is not exactly one SPL TransferChecked instruction.");
  }
  if (!Array.isArray(instruction.keys) || instruction.keys.length !== 4) {
    throw new Error("The SPL TransferChecked instruction has an unexpected account layout.");
  }
  const instructionAccounts = instruction.keys.map(account => account.pubkey?.toBase58?.() || "");
  if (instructionAccounts.some(address => !address)) {
    throw new Error("The SPL TransferChecked instruction contains an invalid account.");
  }
  return transaction;
}

export function discoverSolanaSigningProvider(scope = globalThis) {
  const candidates = [
    scope?.phantom?.solana,
    scope?.solflare,
    scope?.backpack?.solana,
    scope?.okxwallet?.solana,
    scope?.solana,
  ];
  return candidates.find(provider => provider && typeof provider.signTransaction === "function") || null;
}

export async function signPreparedSolanaDelivery({
  unsignedTransactionBase64,
  expectedAuthority,
  provider = discoverSolanaSigningProvider(),
}) {
  if (!provider) throw new Error("No supported Solana wallet with signTransaction was detected.");
  if (!provider.publicKey && typeof provider.connect === "function") {
    await provider.connect();
  }
  const connectedAddress = provider.publicKey?.toBase58?.() || String(provider.publicKey || "");
  if (connectedAddress !== expectedAuthority) {
    throw new Error("Connect the wallet that controls the configured BALMZ distribution account.");
  }

  const unsigned = decodePreparedSolanaDelivery(unsignedTransactionBase64, expectedAuthority);
  const expectedMessage = unsigned.serializeMessage();
  const signed = await provider.signTransaction(unsigned);
  if (!signed || typeof signed.serialize !== "function" || !signed.message) {
    throw new Error("The wallet did not return a signed Solana transaction.");
  }
  const actualMessage = signed.serializeMessage();
  if (actualMessage.length !== expectedMessage.length || actualMessage.some((byte, index) => byte !== expectedMessage[index])) {
    throw new Error("The wallet changed the approved transaction message; signing was rejected.");
  }
  const signedBytes = signed.serialize({ requireAllSignatures: true, verifySignatures: true });
  let binary = "";
  for (let offset = 0; offset < signedBytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...signedBytes.subarray(offset, offset + 0x8000));
  }
  return {
    signedTransactionBase64: btoa(binary),
    signerAddress: connectedAddress,
    messageUnchanged: true,
  };
}
