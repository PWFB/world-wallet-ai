const BACKUP_FORMAT = "world-wallet-ai-encrypted-backup-v1";
const SECRET_FIELDS = ["mnemonic", "phrase", "recoveryPhrase", "recovery_phrase", "seedPhrase", "seed_phrase"];

export function isWalletBackupFile(file) {
  const name = String(file?.name || "");
  const mimeType = String(file?.mimeType || file?.type || "").toLowerCase();
  const extensionAllowed = /\.(json|txt|wallet|backup)$/i.test(name);
  const nameRelevant = /(wallet|backup|keystore|recovery|seed|phrase)/i.test(name);
  return extensionAllowed && nameRelevant;
}

function asMnemonic(value) {
  if (typeof value !== "string") return "";
  const phrase = value.normalize("NFKD").trim().replace(/\s+/g, " ");
  const count = phrase ? phrase.split(" ").length : 0;
  return count === 12 || count === 24 ? phrase : "";
}

function validateEncryptedWallet(wallet) {
  if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) {
    throw new Error("The backup does not contain a wallet record.");
  }
  if (typeof wallet.encryptedJson !== "string" || !wallet.encryptedJson.trim() ||
      typeof wallet.encryptedMnemonic !== "string" || !wallet.encryptedMnemonic.trim()) {
    throw new Error("Only World Wallet AI encrypted vault backups with both encrypted key and recovery material are supported.");
  }
  let evmAddress = String(wallet.addresses?.ethereum || wallet.address || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(evmAddress)) {
    throw new Error("The encrypted backup has no valid Ethereum public address.");
  }
  try {
    const keyPayload = JSON.parse(wallet.encryptedJson);
    const phrasePayload = JSON.parse(wallet.encryptedMnemonic);
    if (!(keyPayload?.crypto || keyPayload?.Crypto) || phrasePayload?.version !== 1 || phrasePayload?.kdf !== "PBKDF2-SHA256" ||
        phrasePayload?.cipher !== "AES-256-GCM") throw new Error("Unsupported encryption metadata.");
  } catch {
    throw new Error("The backup encryption metadata is invalid or unsupported.");
  }
  return {
    name: String(wallet.name || "Imported wallet").slice(0, 80),
    address: evmAddress,
    addresses: wallet.addresses && typeof wallet.addresses === "object" ? wallet.addresses : { ethereum: evmAddress },
    network: ["ethereum", "bnb", "sepolia"].includes(wallet.network) ? wallet.network : "ethereum",
    encryptedJson: wallet.encryptedJson,
    encryptedMnemonic: wallet.encryptedMnemonic,
    publicKey: String(wallet.publicKey || ""),
    createdAt: String(wallet.createdAt || new Date().toISOString()),
  };
}

export function parseWalletBackupContent(content) {
  const raw = String(content ?? "").replace(/^\uFEFF/, "").trim();
  if (!raw) throw new Error("The selected backup file is empty.");

  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  if (Array.isArray(parsed)) {
    const wallets = parsed.map(validateEncryptedWallet);
    if (!wallets.length) throw new Error("The selected wallet backup contains no wallet records.");
    return wallets.length === 1 ? { kind: "encrypted", wallet: wallets[0] } : { kind: "encrypted_batch", wallets };
  }

  if (parsed && typeof parsed === "object") {
    if (parsed.format === BACKUP_FORMAT && parsed.version === 1) {
      return { kind: "encrypted", wallet: validateEncryptedWallet(parsed.wallet) };
    }

    const candidates = [parsed, parsed.wallet, parsed.backup, parsed.data].filter(
      value => value && typeof value === "object" && !Array.isArray(value)
    );
    for (const candidate of candidates) {
      if (candidate.encryptedJson && candidate.encryptedMnemonic) {
        return { kind: "encrypted", wallet: validateEncryptedWallet(candidate) };
      }
      for (const field of SECRET_FIELDS) {
        const phrase = asMnemonic(candidate[field]);
        if (phrase) return { kind: "mnemonic", phrase };
      }
    }
  }

  const phrase = asMnemonic(typeof parsed === "string" ? parsed : raw);
  if (phrase) return { kind: "mnemonic", phrase };
  throw new Error("Unsupported backup. Use a World Wallet AI encrypted backup JSON, or a TXT/JSON file containing a 12- or 24-word recovery phrase.");
}

export function createWalletBackupPayload(entry) {
  if (!entry?.encryptedJson || !entry?.encryptedMnemonic) {
    throw new Error("Unlock and re-encrypt this wallet with a recovery phrase before exporting an encrypted backup.");
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    wallet: {
      name: String(entry.name || "Wallet").slice(0, 80),
      address: String(entry.address || entry.addresses?.ethereum || ""),
      addresses: entry.addresses || {},
      network: String(entry.network || "ethereum"),
      encryptedJson: entry.encryptedJson,
      encryptedMnemonic: entry.encryptedMnemonic,
      createdAt: String(entry.createdAt || new Date().toISOString()),
    },
  };
}
