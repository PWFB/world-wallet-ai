import { HDNodeWallet, getBytes, ripemd160, sha256 } from "ethers";

const encoder = new TextEncoder();
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENCRYPTION_ITERATIONS = 310_000;
const UINT64_RANGE = 1n << 64n;
const WALLET_NUMBER_RANGE = 90_000_000_000n;

function secureCrypto() {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error("This browser does not provide the secure cryptography required to create a self-custody wallet.");
  }
  return globalThis.crypto;
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  const clean = String(value || "").replace(/^0x/i, "");
  if (!/^(?:[0-9a-f]{2})+$/i.test(clean)) throw new Error("Invalid hexadecimal key material.");
  return Uint8Array.from(clean.match(/.{2}/g), byte => Number.parseInt(byte, 16));
}

function encodeBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  return decodeBase64(normalized);
}

export function createWalletNumber(existingNumbers = []) {
  const existing = new Set((Array.isArray(existingNumbers) ? existingNumbers : []).map(value => String(value)));
  const cryptoProvider = secureCrypto();
  const cutoff = (UINT64_RANGE / WALLET_NUMBER_RANGE) * WALLET_NUMBER_RANGE;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const bytes = cryptoProvider.getRandomValues(new Uint8Array(8));
    const random = BigInt("0x" + bytesToHex(bytes));
    if (random >= cutoff) continue;
    const candidate = String(10_000_000_000n + (random % WALLET_NUMBER_RANGE));
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("A unique 11-digit wallet ID could not be generated. Please try again.");
}

async function hmacSha512(keyBytes, messageBytes) {
  const cryptoProvider = secureCrypto();
  const key = await cryptoProvider.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  return new Uint8Array(await cryptoProvider.subtle.sign("HMAC", key, messageBytes));
}

async function bip39Seed(phrase) {
  const cryptoProvider = secureCrypto();
  const normalized = String(phrase).normalize("NFKD");
  const key = await cryptoProvider.subtle.importKey(
    "raw",
    encoder.encode(normalized),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return new Uint8Array(await cryptoProvider.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode("mnemonic"), iterations: 2048, hash: "SHA-512" },
    key,
    512
  ));
}

async function deriveSlip10Ed25519(seed, accountIndex) {
  let digest = await hmacSha512(encoder.encode("ed25519 seed"), seed);
  let key = digest.slice(0, 32);
  let chainCode = digest.slice(32, 64);
  const hardened = 0x80000000;
  const path = [44 + hardened, 501 + hardened, accountIndex + hardened, hardened];
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    digest = await hmacSha512(chainCode, data);
    key = digest.slice(0, 32);
    chainCode = digest.slice(32, 64);
  }

  const pkcs8Prefix = hexToBytes("302e020100300506032b657004220420");
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + key.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(key, pkcs8Prefix.length);
  try {
    const cryptoProvider = secureCrypto();
    const privateKey = await cryptoProvider.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
    const publicJwk = await cryptoProvider.subtle.exportKey("jwk", privateKey);
    const publicKey = decodeBase64Url(publicJwk.x);
    if (publicKey.length !== 32) throw new Error("The derived Solana public key has an invalid length.");
    return encodeBase58(publicKey);
  } catch (error) {
    throw new Error("This browser cannot derive the Solana address securely. Update the browser and try again.", { cause: error });
  } finally {
    key.fill(0);
    chainCode.fill(0);
    digest.fill(0);
  }
}

function encodeBase58(bytes) {
  let value = BigInt("0x" + bytesToHex(bytes));
  let output = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    output = BASE58_ALPHABET[remainder] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = "1" + output;
  }
  return output || "1";
}

function convertBits(data, fromBits, toBits, pad) {
  let accumulator = 0;
  let bitCount = 0;
  const result = [];
  const maxValue = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || (value >>> fromBits) !== 0) throw new Error("Invalid witness-program data.");
    accumulator = (accumulator << fromBits) | value;
    bitCount += fromBits;
    while (bitCount >= toBits) {
      bitCount -= toBits;
      result.push((accumulator >>> bitCount) & maxValue);
    }
  }
  if (pad) {
    if (bitCount) result.push((accumulator << (toBits - bitCount)) & maxValue);
  } else if (bitCount >= fromBits || ((accumulator << (toBits - bitCount)) & maxValue)) {
    throw new Error("Invalid Bech32 padding.");
  }
  return result;
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function encodeBitcoinSegwitAddress(hrp, witnessProgram) {
  const data = [0, ...convertBits(Array.from(witnessProgram), 8, 5, true)];
  const expandedHrp = [
    ...Array.from(hrp, character => character.charCodeAt(0) >>> 5),
    0,
    ...Array.from(hrp, character => character.charCodeAt(0) & 31),
  ];
  const polymod = bech32Polymod([...expandedHrp, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  return hrp + "1" + [...data, ...checksum].map(value => alphabet[value]).join("");
}

export async function deriveWalletAddresses(mnemonicPhrase) {
  const phrase = String(mnemonicPhrase || "").normalize("NFKD").trim().replace(/\s+/g, " ");
  if (!phrase) throw new Error("A valid recovery phrase is required to derive wallet addresses.");

  const ethereum = HDNodeWallet.fromPhrase(phrase, "", "m/44'/60'/0'/0/0").address;
  const bnb = ethereum;
  const sepolia = HDNodeWallet.fromPhrase(phrase, "", "m/44'/60'/1'/0/0").address;

  const bitcoinWallet = HDNodeWallet.fromPhrase(phrase, "", "m/84'/0'/0'/0/0");
  const witnessHash = getBytes(ripemd160(sha256(getBytes(bitcoinWallet.publicKey))));
  const bitcoin = encodeBitcoinSegwitAddress("bc", witnessHash);

  const seed = await bip39Seed(phrase);
  try {
    const [solanaMainnet, solanaDevnet] = await Promise.all([
      deriveSlip10Ed25519(seed, 0),
      deriveSlip10Ed25519(seed, 1),
    ]);
    return Object.freeze({
      ethereum,
      bnb,
      bitcoin,
      solana_mainnet: solanaMainnet,
      sepolia,
      solana_devnet: solanaDevnet,
    });
  } finally {
    seed.fill(0);
  }
}

export async function encryptMnemonic(mnemonicPhrase, password) {
  if (typeof password !== "string" || password.length < 10) {
    throw new Error("Use a vault password of at least 10 characters.");
  }
  const cryptoProvider = secureCrypto();
  const salt = cryptoProvider.getRandomValues(new Uint8Array(16));
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
  const material = await cryptoProvider.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await cryptoProvider.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ENCRYPTION_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(String(mnemonicPhrase).normalize("NFKD").trim().replace(/\s+/g, " "))
  );
  return JSON.stringify({
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: ENCRYPTION_ITERATIONS,
    cipher: "AES-256-GCM",
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptMnemonic(encryptedValue, password) {
  if (typeof password !== "string" || !password) throw new Error("Enter the vault password.");
  let payload;
  try { payload = JSON.parse(String(encryptedValue)); } catch {
    throw new Error("Encrypted recovery material is invalid.");
  }
  if (
    payload?.version !== 1 ||
    payload?.kdf !== "PBKDF2-SHA256" ||
    payload?.cipher !== "AES-256-GCM" ||
    !Number.isSafeInteger(payload.iterations) ||
    payload.iterations < 100_000 ||
    payload.iterations > 1_000_000 ||
    !payload.salt ||
    !payload.iv ||
    !payload.ciphertext
  ) throw new Error("Unsupported encrypted recovery material.");

  const cryptoProvider = secureCrypto();
  const material = await cryptoProvider.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await cryptoProvider.subtle.deriveKey(
    { name: "PBKDF2", salt: decodeBase64(payload.salt), iterations: payload.iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  try {
    const plaintext = await cryptoProvider.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(payload.iv) },
      key,
      decodeBase64(payload.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Could not unlock the encrypted recovery material. Check the vault password.");
  }
}
