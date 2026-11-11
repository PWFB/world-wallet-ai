const FRIENDLY_ADDRESS_PATTERN = /^[A-Za-z0-9+/_-]{48}$/;
const RAW_ADDRESS_PATTERN = /^(?:-1|0):[0-9a-fA-F]{64}$/;

function crc16Ccitt(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1)) & 0xffff;
    }
  }
  return crc;
}

function decodeFriendlyTonAddress(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length !== 36) throw new Error("TON address must decode to exactly 36 bytes.");
  const tag = bytes[0];
  const workchain = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt8(1);
  if (![0x11, 0x51, 0x91, 0xd1].includes(tag) || ![-1, 0].includes(workchain)) {
    throw new Error("Unsupported TON address tag or workchain.");
  }
  const expected = crc16Ccitt(bytes.subarray(0, 34));
  const actual = (bytes[34] << 8) | bytes[35];
  if (expected !== actual) throw new Error("TON address checksum is invalid.");
  return { bytes, workchain, testOnly: Boolean(tag & 0x80) };
}

export function isValidTonAddress(value) {
  const address = String(value || "").trim();
  if (RAW_ADDRESS_PATTERN.test(address)) return true;
  if (!FRIENDLY_ADDRESS_PATTERN.test(address)) return false;
  try {
    decodeFriendlyTonAddress(address);
    return true;
  } catch {
    return false;
  }
}

export function tonNetworkFromChainId(chainId) {
  if (String(chainId) === "-239") return "ton_mainnet";
  if (String(chainId) === "-3") return "ton_testnet";
  return "";
}

export function tonFriendlyAddress(value, testOnly = false) {
  const address = String(value || "").trim();
  if (FRIENDLY_ADDRESS_PATTERN.test(address)) {
    const decoded = decodeFriendlyTonAddress(address);
    if (testOnly && !decoded.testOnly) {
      const changed = decoded.bytes.slice();
      changed[0] |= 0x80;
      const checksum = crc16Ccitt(changed.subarray(0, 34));
      changed[34] = checksum >> 8;
      changed[35] = checksum & 0xff;
      return btoa(String.fromCharCode(...changed)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }
    if (!testOnly && decoded.testOnly) throw new Error("A test-only TON address cannot be used for a Mainnet transfer.");
    return address;
  }
  if (!RAW_ADDRESS_PATTERN.test(address)) throw new Error("Enter a valid TON raw or user-friendly address.");
  const [, workchainText, hash] = address.match(/^(-1|0):([0-9a-fA-F]{64})$/);
  const workchain = Number(workchainText);
  const bytes = new Uint8Array(36);
  bytes[0] = testOnly ? 0x91 : 0x11;
  bytes[1] = workchain < 0 ? 0xff : workchain;
  for (let i = 0; i < 32; i += 1) bytes[i + 2] = Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
  const checksum = crc16Ccitt(bytes.subarray(0, 34));
  bytes[34] = checksum >> 8;
  bytes[35] = checksum & 0xff;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function tonToNano(value) {
  const input = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(input)) {
    throw new Error("Enter a positive TON amount with no more than 9 decimal places.");
  }
  const [whole, fraction = ""] = input.split(".");
  const nano = BigInt(whole) * 1_000_000_000n + BigInt((fraction + "000000000").slice(0, 9));
  if (nano <= 0n) throw new Error("TON amount must be greater than zero.");
  return nano.toString();
}
