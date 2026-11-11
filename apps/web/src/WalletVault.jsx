import { useEffect, useRef, useState } from "react";
import { Contract, HDNodeWallet, JsonRpcProvider, Wallet, formatEther, formatUnits, hashMessage, isAddress, keccak256, parseEther, parseUnits, toUtf8Bytes } from "ethers";
import { createWalletBackupPayload, isWalletBackupFile, parseWalletBackupContent } from "./google-drive-wallet-backup.js";
import { getNeonAccessToken } from "./auth-client.js";
import { createWalletNumber, decryptMnemonic, deriveWalletAddresses, encryptMnemonic, signSolanaMessage } from "./wallet-addresses.js";
import { verifyEip1271Signature, verifyEvmMessageSignature, verifyEvmTypedDataSignature } from "./wallet-signatures.js";
import { encodeOkxWalletCoreSelfExecution, isExpectedOkxWalletCoreDelegation } from "./okx-walletcore.js";

const VAULT_KEY = "world_wallet_encrypted_vault_v1";
const SEPOLIA_RPC = (import.meta.env.VITE_WORLD_WALLET_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com").trim();
const GOOGLE_API_KEY = String(import.meta.env.VITE_GOOGLE_API_KEY || "").trim();
const GOOGLE_CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function readVault() {
  try {
    const value = JSON.parse(localStorage.getItem(VAULT_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readVaultForAccount(userId, allowedServerWalletIds = []) {
  const allowed = new Set((Array.isArray(allowedServerWalletIds) ? allowedServerWalletIds : []).map(String));
  const currentUserId = String(userId || "");
  return readVault().filter(entry => {
    if (entry?.ownerUserId) return currentUserId && String(entry.ownerUserId) === currentUserId;
    const serverWalletId = entry?.serverWalletId || (String(entry?.walletId || "").startsWith("wallet_") ? entry.walletId : "");
    return Boolean(serverWalletId && allowed.has(String(serverWalletId)));
  });
}

export default function WalletVault({ accessToken, apiBaseUrl, onWalletCreated, onWalletSelected, activeWalletId = "", allowedServerWalletIds = [], serverWalletNumberById = {}, userId = "" }) {
  const [entries, setEntries] = useState([]);
  const [walletName, setWalletName] = useState("Personal Wallet");
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("ethereum");
  const [generated, setGenerated] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [unlocked, setUnlocked] = useState(null);
  const [unlockedAddresses, setUnlockedAddresses] = useState(null);
  const [keyRevealPassword, setKeyRevealPassword] = useState("");
  const [revealedPrivateKey, setRevealedPrivateKey] = useState("");
  const [signMessage, setSignMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [typedDataDomainJson, setTypedDataDomainJson] = useState("");
  const [typedDataTypesJson, setTypedDataTypesJson] = useState("");
  const [typedDataValueJson, setTypedDataValueJson] = useState("");
  const [typedDataSignature, setTypedDataSignature] = useState("");
  const [typedDataResult, setTypedDataResult] = useState(null);
  const [smartWalletNetwork, setSmartWalletNetwork] = useState("ethereum");
  const [smartWalletBusy, setSmartWalletBusy] = useState(false);
  const [smartWalletResult, setSmartWalletResult] = useState(null);
  const [smartWalletAddress, setSmartWalletAddress] = useState("0xBbDb482aE0895e496676eC84501d2945a404FF2C");
  const [smartWalletMessage, setSmartWalletMessage] = useState("");
  const [smartWalletSignature, setSmartWalletSignature] = useState("");
  const [smartWalletTransferType, setSmartWalletTransferType] = useState("native");
  const [smartWalletTransferRecipient, setSmartWalletTransferRecipient] = useState("");
  const [smartWalletTransferAmount, setSmartWalletTransferAmount] = useState("");
  const [smartWalletTokenAddress, setSmartWalletTokenAddress] = useState("");
  const [smartWalletTxBusy, setSmartWalletTxBusy] = useState(false);
  const [smartWalletTxResult, setSmartWalletTxResult] = useState(null);
  const [verifyAddressInput, setVerifyAddressInput] = useState("");
  const [verifyMessageInput, setVerifyMessageInput] = useState("");
  const [verifySignatureInput, setVerifySignatureInput] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);
  const [nativeBalance, setNativeBalance] = useState("");
  const [recipient, setRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [txHash, setTxHash] = useState("");
  const [tokenContractAddress, setTokenContractAddress] = useState("");
  const [tokenRecipient, setTokenRecipient] = useState("");
  const [tokenAmount, setTokenAmount] = useState("");
  const [tokenTxHash, setTokenTxHash] = useState("");
  const [deployedContracts, setDeployedContracts] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [googleReady, setGoogleReady] = useState(false);
  const [driveAccessToken, setDriveAccessToken] = useState("");
  const [driveFiles, setDriveFiles] = useState([]);
  const [driveBusy, setDriveBusy] = useState(false);
  const [importPassword, setImportPassword] = useState("");

  useEffect(() => {
    if (!GOOGLE_API_KEY || !GOOGLE_CLIENT_ID) return undefined;
    if (window.google?.accounts?.oauth2) { setGoogleReady(true); return undefined; }
    let cancelled = false;
    let script = document.getElementById("world-wallet-google-identity-script");
    const onLoad = () => { if (!cancelled) setGoogleReady(Boolean(window.google?.accounts?.oauth2)); };
    const onError = () => { if (!cancelled) setMessage("Google sign-in could not load. Check the frontend Content Security Policy and try again."); };
    if (!script) {
      script = document.createElement("script");
      script.id = "world-wallet-google-identity-script";
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    if (window.google?.accounts?.oauth2) onLoad();
    return () => {
      cancelled = true;
      script?.removeEventListener("load", onLoad);
      script?.removeEventListener("error", onError);
    };
  }, []);

  const allowedServerWalletIdKey = (Array.isArray(allowedServerWalletIds) ? allowedServerWalletIds : []).map(String).sort().join("|");
  const serverWalletNumberKey = Object.entries(serverWalletNumberById || {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, number]) => id + ":" + number).join("|");

  useEffect(() => {
    const saved = readVaultForAccount(userId, allowedServerWalletIds).map(entry => {
      const serverWalletId = entry.serverWalletId || (String(entry.walletId || "").startsWith("wallet_") ? entry.walletId : "");
      return {
        ...entry,
        serverWalletId,
        walletNumber: entry.walletNumber || String(serverWalletNumberById[serverWalletId || entry.walletId] || ""),
      };
    });
    setEntries(saved);
    try { const deployed = JSON.parse(localStorage.getItem("world_wallet_deployed_contracts_v1") || "[]"); setDeployedContracts(Array.isArray(deployed) ? deployed : []); } catch { setDeployedContracts([]); }
    const refreshDeployedContracts = () => { try { const deployed = JSON.parse(localStorage.getItem("world_wallet_deployed_contracts_v1") || "[]"); setDeployedContracts(Array.isArray(deployed) ? deployed : []); } catch { setDeployedContracts([]); } };
    window.addEventListener("world-wallet-contracts-updated", refreshDeployedContracts);
    const activeEntry = saved.find(item => item.serverWalletId === activeWalletId || item.walletId === activeWalletId);
    if (activeEntry) setSelectedId(activeEntry.walletId);
    else if (!activeWalletId && saved.length) setSelectedId(saved[0].walletId);
    else setSelectedId("");
    // Contract Generator can hand off a deployed token address to this page.
    try {
      const pending = JSON.parse(localStorage.getItem("world_wallet_pending_token_contract") || "null");
      if (pending && /^0x[a-fA-F0-9]{40}$/.test(String(pending.address || ""))) {
        setTokenContractAddress(pending.address);
        if (pending.network === "sepolia" || pending.network === "ethereum") setNetwork(pending.network);
        setMessage("Loaded " + (pending.symbol || "token") + " contract address from Contract Generator (" + (pending.network || "selected network") + "). Confirm the network and address before interacting.");
        localStorage.removeItem("world_wallet_pending_token_contract");
      }
    } catch {}
    return () => window.removeEventListener("world-wallet-contracts-updated", refreshDeployedContracts);
  }, [userId, allowedServerWalletIdKey, serverWalletNumberKey]);

  const walletContextRef = useRef({ activeWalletId: String(activeWalletId || ""), userId: String(userId || "") });

  useEffect(() => {
    const nextContext = { activeWalletId: String(activeWalletId || ""), userId: String(userId || "") };
    const previousContext = walletContextRef.current;
    if (previousContext.activeWalletId === nextContext.activeWalletId && previousContext.userId === nextContext.userId) return;
    walletContextRef.current = nextContext;
    const activeEntry = entries.find(item => item.serverWalletId === activeWalletId || item.walletId === activeWalletId);
    const localSelection = entries.find(item => item.walletId === selectedId && !item.serverWalletId);
    const keepFreshlyGeneratedRecovery = Boolean(activeEntry && generated && String(generated.walletId) === String(activeEntry.walletId));
    setSelectedId(activeEntry?.walletId || localSelection?.walletId || "");
    if (keepFreshlyGeneratedRecovery) return;
    setUnlocked(null);
    setUnlockedAddresses(null);
    setGenerated(null);
    setPassword("");
    setNativeBalance("");
    setTxHash("");
    setTokenTxHash("");
    setMessage("");
  }, [activeWalletId, userId, entries, generated]);

  useEffect(() => {
    if (!accessToken) return;
    fetch(apiBaseUrl + "/api/v1/tokens", { headers: { Authorization: "Bearer " + accessToken } })
      .then(async response => {
        const data = await response.json();
        if (response.ok) {
          const tokens = data.tokens || [];
          setContracts(tokens);
          const balmzSepolia = tokens.find(item => item.symbol === "BALMZ-SEP" && item.network === "sepolia")?.contract_address;
          if (balmzSepolia) setTokenContractAddress(current => current || balmzSepolia);
        }
      })
      .catch(() => {});
  }, [accessToken, apiBaseUrl]);

  function persistVault(next, removeWalletIds = []) {
    const managedIds = new Set([...entries, ...next].map(item => String(item.walletId || "")));
    for (const id of removeWalletIds) managedIds.add(String(id));
    const preservedEntries = readVault().filter(item => !managedIds.has(String(item.walletId || "")));
    localStorage.setItem(VAULT_KEY, JSON.stringify([...next, ...preservedEntries]));
    setEntries(next);
    try { window.dispatchEvent(new Event("world-wallet-local-vault-updated")); } catch {}
  }

  async function importWalletBackupContent(content, sourceName = "backup file") {
    setBusy(true);
    setMessage("");
    try {
      const parsed = parseWalletBackupContent(content);
      let walletDataList;
      if (parsed.kind === "mnemonic") {
        if (importPassword.length < 10) throw new Error("Enter a new local vault password of at least 10 characters before importing a recovery phrase.");
        const phrase = parsed.phrase;
        const signer = HDNodeWallet.fromPhrase(phrase);
        const addresses = await deriveWalletAddresses(phrase);
        walletDataList = [{
          name: String(sourceName || "Imported wallet").replace(/\.(json|txt|wallet|backup)$/i, "").slice(0, 80) || "Imported wallet",
          address: addresses.ethereum,
          addresses,
          network: "ethereum",
          encryptedJson: await signer.encrypt(importPassword),
          encryptedMnemonic: await encryptMnemonic(phrase, importPassword),
          publicKey: signer.publicKey,
          createdAt: new Date().toISOString(),
        }];
      } else {
        walletDataList = parsed.kind === "encrypted_batch" ? parsed.wallets : [parsed.wallet];
      }

      const importedEntries = [];
      let duplicateCount = 0;
      for (const walletData of walletDataList) {
        const importedAddress = walletData.address || walletData.addresses?.ethereum;
        const duplicate = entries.find(item => String(item.address || item.addresses?.ethereum || "").toLowerCase() === String(importedAddress || "").toLowerCase())
          || importedEntries.find(item => String(item.address || item.addresses?.ethereum || "").toLowerCase() === String(importedAddress || "").toLowerCase());
        if (duplicate) {
          duplicateCount += 1;
          if (!importedEntries.length) setSelectedId(duplicate.walletId);
          continue;
        }

        const walletNumber = createWalletNumber(readVault().map(item => item.walletNumber).filter(Boolean).concat(importedEntries.map(item => item.walletNumber)));
        const localWalletId = "local-" + walletNumber;
        importedEntries.push({
          walletId: localWalletId,
          serverWalletId: "",
          walletNumber,
          ownerUserId: String(userId || ""),
          name: walletData.name || "Imported wallet",
          address: importedAddress,
          addresses: walletData.addresses || { ethereum: importedAddress },
          publicKey: walletData.publicKey || "",
          network: walletData.network || "ethereum",
          encryptedJson: walletData.encryptedJson,
          encryptedMnemonic: walletData.encryptedMnemonic,
          createdAt: walletData.createdAt || new Date().toISOString(),
          importedFrom: String(sourceName || "backup file").slice(0, 120),
        });
      }
      if (!importedEntries.length) {
        setMessage("All wallet addresses in this backup are already saved in this browser. No duplicates were added.");
        return;
      }
      persistVault([...importedEntries, ...entries]);
      setSelectedId(importedEntries[0].walletId);
      setPassword("");
      setImportPassword("");
      setUnlocked(null);
      setUnlockedAddresses(null);
      setGenerated(null);
      setMessage(importedEntries.length + " wallet(s) imported locally" + (duplicateCount ? "; " + duplicateCount + " duplicate(s) skipped" : "") + ". Public addresses are ready for review. Nothing was sent to the World Wallet AI backend; attach each wallet's public addresses only after reviewing them.");
    } catch (error) {
      setMessage(error?.message || "The selected backup could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLocalBackupFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Backup file exceeds the 10 MB local import limit.");
      const content = await file.text();
      await importWalletBackupContent(content, file.name);
    } catch (error) {
      setMessage(error?.message || "Could not read the selected backup file.");
    } finally {
      event.target.value = "";
    }
  }

  function connectGoogleDrive() {
    if (!GOOGLE_API_KEY || !GOOGLE_CLIENT_ID) {
      setMessage("Google Drive is not configured. Add VITE_GOOGLE_API_KEY and VITE_GOOGLE_CLIENT_ID to the World Wallet AI frontend build environment, then rebuild the frontend.");
      return;
    }
    if (!window.google?.accounts?.oauth2) {
      setMessage("Google sign-in is still loading. Refresh this page and try Connect Google Drive again.");
      return;
    }
    try {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_DRIVE_READONLY_SCOPE,
        callback: async response => {
          if (response?.error || !response?.access_token) {
            setMessage("Google Drive authorization was not completed. No wallet data was imported.");
            return;
          }
          const token = response.access_token;
          setDriveAccessToken(token);
          setDriveBusy(true);
          setMessage("");
          try {
            const params = new URLSearchParams({
              key: GOOGLE_API_KEY,
              q: "trashed = false and mimeType != 'application/vnd.google-apps.folder' and (name contains 'wallet' or name contains 'backup' or name contains 'keystore' or name contains 'recovery' or name contains 'seed' or name contains 'phrase')",
              pageSize: "100",
              orderBy: "modifiedTime desc",
              fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
            });
            const response = await fetch("https://www.googleapis.com/drive/v3/files?" + params.toString(), {
              headers: { Authorization: "Bearer " + token },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error?.message || "Google Drive file listing failed.");
            const files = (Array.isArray(data.files) ? data.files : []).filter(isWalletBackupFile);
            setDriveFiles(files);
            setMessage(files.length
              ? "Google Drive connected with read-only access. Select a backup file to inspect locally."
              : "Google Drive connected, but no matching wallet or backup filenames were found. You can still import a file from this device.");
          } catch (error) {
            setMessage("Google Drive file listing failed: " + (error?.message || "request error") + ". Reconnect and check the Drive API configuration.");
          } finally {
            setDriveBusy(false);
          }
        },
      });
      tokenClient.requestAccessToken({ prompt: driveAccessToken ? "" : "consent" });
    } catch (error) {
      setMessage("Google Drive connection could not start: " + (error?.message || "Google sign-in unavailable"));
    }
  }

  async function importGoogleDriveFile(file) {
    if (!driveAccessToken || !file?.id) {
      setMessage("Reconnect Google Drive before selecting a backup.");
      return;
    }
    if (String(file.mimeType || "").startsWith("application/vnd.google-apps.")) {
      setMessage("Google Docs-native files are not supported yet. Download the backup as JSON or TXT, then import that file.");
      return;
    }
    if (Number(file.size || 0) > 10 * 1024 * 1024) {
      setMessage("This Google Drive backup exceeds the 10 MB import limit. Download a smaller backup or split the file.");
      return;
    }
    setDriveBusy(true);
    setMessage("");
    try {
      const response = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(file.id) + "?alt=media&key=" + encodeURIComponent(GOOGLE_API_KEY), {
        headers: { Authorization: "Bearer " + driveAccessToken },
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message || (response.status === 401 ? "Google authorization expired; reconnect Drive." : "The selected file could not be downloaded."));
      }
      const content = await response.text();
      await importWalletBackupContent(content, file.name);
    } catch (error) {
      setMessage("Could not read the selected Google Drive backup: " + (error?.message || "download failed"));
    } finally {
      setDriveBusy(false);
    }
  }

  async function attachSelectedWalletToAccount() {
    const entry = entries.find(item => item.walletId === selectedId);
    if (!entry || entry.serverWalletId) {
      setMessage("Choose an imported local wallet that is not already attached.");
      return;
    }
    if (!unlocked || !unlockedAddresses || unlocked.address.toLowerCase() !== String(entry.addresses?.ethereum || entry.address || "").toLowerCase()) {
      setMessage("Unlock this imported wallet with its vault password before attaching it. This verifies the saved addresses against locally decrypted recovery material.");
      return;
    }
    const addressPairs = Object.entries(unlockedAddresses).filter(([networkName, address]) => {
      if (typeof address !== "string" || !address.trim()) return false;
      if (["ethereum", "bnb", "sepolia"].includes(networkName)) return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
      if (networkName === "bitcoin") return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i.test(address.trim());
      if (["solana_mainnet", "solana_devnet"].includes(networkName)) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim());
      return false;
    });
    if (!addressPairs.some(([networkName]) => networkName === "ethereum")) {
      setMessage("This wallet has no verified Ethereum public address to attach.");
      return;
    }
    if (!window.confirm("Attach this wallet to your World Wallet AI account? Only the wallet name, wallet ID, and public network addresses will be sent. Recovery phrases, private keys, and encrypted recovery files stay on this device.")) return;
    setBusy(true);
    setMessage("");
    try {
      const sessionToken = String(accessToken || "").startsWith("wwpin_")
      ? accessToken
      : (await getNeonAccessToken()) || accessToken;
      if (!sessionToken) throw new Error("No valid sign-in session.");
      const profileResponse = await fetch(apiBaseUrl + "/api/v1/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
        body: JSON.stringify({ name: entry.name || "Imported wallet" }),
      });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok) throw new Error(profile.detail || "Wallet profile request failed.");
      const serverWalletId = profile.wallet?.id;
      if (!serverWalletId) throw new Error("The API did not return a wallet ID.");
      const serverWalletNumber = String(profile.wallet?.wallet_number || entry.walletNumber);
      const attachmentFailures = [];
      for (const [addressNetwork, addressValue] of addressPairs) {
        try {
          const addressResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(serverWalletId) + "/addresses", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
            body: JSON.stringify({ network: addressNetwork, address: addressValue, label: "imported " + serverWalletNumber }),
          });
          const addressData = await addressResponse.json().catch(() => ({}));
          if (!addressResponse.ok) throw new Error(addressData.detail || "Address save failed.");
        } catch (error) {
          attachmentFailures.push(addressNetwork + ": " + (error?.message || "save failed"));
        }
      }
      const verificationFailures = [];
      const verifiedNetworks = [];
      if (!attachmentFailures.length) {
        const recoveryPhrase = entry.encryptedMnemonic
          ? await decryptMnemonic(entry.encryptedMnemonic, password)
          : (unlocked.mnemonic?.phrase || "");
        const proofTargets = [
          ["ethereum", "evm", "m/44'/60'/0'/0/0"],
          ["bnb", "evm", "m/44'/60'/0'/0/0"],
          ["sepolia", "evm", "m/44'/60'/1'/0/0"],
          ["bitcoin", "bitcoin", "m/84'/0'/0'/0/0"],
          ["solana_mainnet", "solana", 0],
          ["solana_devnet", "solana", 1],
        ];
        for (const [proofNetwork, proofType, derivation] of proofTargets) {
          const proofAddress = unlockedAddresses[proofNetwork];
          if (!proofAddress || !addressPairs.some(([name,address]) => name === proofNetwork && address === proofAddress)) continue;
          try {
            if (!recoveryPhrase && !["ethereum", "bnb"].includes(proofNetwork)) {
              throw new Error("This local backup has no encrypted recovery phrase for deriving this network key.");
            }
            const challengeResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(serverWalletId) + "/addresses/challenge", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
              body: JSON.stringify({ network: proofNetwork, address: proofAddress }),
            });
            const challenge = await challengeResponse.json().catch(() => ({}));
            if (!challengeResponse.ok) throw new Error(challenge.detail || "Ownership challenge request failed.");
            let proofSignature;
            if (proofType === "evm") {
              const proofWallet = recoveryPhrase
                ? HDNodeWallet.fromPhrase(recoveryPhrase, "", derivation)
                : unlocked;
              if (proofWallet.address.toLowerCase() !== proofAddress.toLowerCase()) throw new Error("Derived EVM address did not match the saved address.");
              proofSignature = await proofWallet.signMessage(challenge.message);
            } else if (proofType === "bitcoin") {
              const proofWallet = HDNodeWallet.fromPhrase(recoveryPhrase, "", derivation);
              const digest = keccak256(toUtf8Bytes(challenge.message));
              proofSignature = proofWallet.signingKey.sign(digest).serialized;
            } else {
              proofSignature = await signSolanaMessage(recoveryPhrase, derivation, challenge.message);
            }
            const verifyResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(serverWalletId) + "/addresses/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
              body: JSON.stringify({ challenge_id: challenge.challenge_id, signature: proofSignature }),
            });
            const verified = await verifyResponse.json().catch(() => ({}));
            if (!verifyResponse.ok || verified.ownership_verified !== true) throw new Error(verified.detail || "Ownership proof was not accepted.");
            verifiedNetworks.push(proofNetwork);
          } catch (error) {
            verificationFailures.push(proofNetwork + ": " + (error?.message || "verification failed"));
          }
        }
      }
      const linkedEntry = { ...entry, walletId: serverWalletId, serverWalletId, walletNumber: serverWalletNumber };
      const currentEntries = entries.filter(item => item.walletId !== entry.walletId && item.walletId !== serverWalletId);
      persistVault([linkedEntry, ...currentEntries], [entry.walletId]);
      setSelectedId(serverWalletId);
      try { await onWalletCreated?.(); } catch {}
      setMessage(attachmentFailures.length
        ? "Wallet profile attached, but some public addresses did not sync: " + attachmentFailures.join("; ") + ". Recovery material remains local; retry the missing address sync from Wallets."
        : verificationFailures.length
          ? "Wallet attached with all public addresses saved. Ownership verified: " + (verifiedNetworks.join(", ") || "none") + ". Proof pending: " + verificationFailures.join("; ") + ". Encrypted recovery material remains on this device."
          : "Wallet attached and ownership signatures verified for: " + verifiedNetworks.join(", ") + ". Encrypted recovery material remains on this device.");
    } catch (error) {
      setMessage("Wallet remains saved locally, but account attachment failed: " + (error?.message || "server unavailable"));
    } finally {
      setBusy(false);
    }
  }

  async function verifySelectedWalletAddresses() {
    const entry = entries.find(item => item.walletId === selectedId);
    const walletId = entry?.serverWalletId || "";
    if (!entry || !walletId || !unlocked || !unlockedAddresses) {
      setMessage("Select an attached wallet, unlock its local encrypted copy, then verify its network addresses.");
      return;
    }
    const addressPairs = Object.entries(unlockedAddresses).filter(([networkName, address]) => {
      if (typeof address !== "string" || !address.trim()) return false;
      if (["ethereum", "bnb", "sepolia"].includes(networkName)) return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
      if (networkName === "bitcoin") return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i.test(address.trim());
      if (["solana_mainnet", "solana_devnet"].includes(networkName)) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim());
      return false;
    });
    if (!addressPairs.length) {
      setMessage("The unlocked wallet contains no supported public network addresses to verify.");
      return;
    }
    if (!window.confirm("Verify ownership of every supported public address in this wallet? World Wallet AI will receive only the public addresses and one-time signatures. Recovery material stays in this browser; no transfer will occur.")) return;
    setBusy(true);
    setMessage("");
    try {
      const sessionToken = String(accessToken || "").startsWith("wwpin_")
        ? accessToken
        : (await getNeonAccessToken()) || accessToken;
      if (!sessionToken) throw new Error("No valid wallet PIN session. Sign in and unlock the wallet first.");
      const recoveryPhrase = entry.encryptedMnemonic
        ? await decryptMnemonic(entry.encryptedMnemonic, password)
        : (unlocked.mnemonic?.phrase || "");
      const walletNumber = String(entry.walletNumber || serverWalletNumberById[walletId] || "");
      const attachmentFailures = [];
      const attached = [];
      for (const [networkName, publicAddress] of addressPairs) {
        try {
          const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
            body: JSON.stringify({ network: networkName, address: publicAddress, label: "verified " + (walletNumber || "wallet") }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.detail || "Address attachment failed.");
          attached.push([networkName, publicAddress]);
        } catch (error) {
          attachmentFailures.push(networkName + ": " + (error?.message || "address save failed"));
        }
      }

      const proofTargets = [
        ["ethereum", "evm", "m/44'/60'/0'/0/0"],
        ["bnb", "evm", "m/44'/60'/0'/0/0"],
        ["sepolia", "evm", "m/44'/60'/1'/0/0"],
        ["bitcoin", "bitcoin", "m/84'/0'/0'/0/0"],
        ["solana_mainnet", "solana", 0],
        ["solana_devnet", "solana", 1],
      ];
      const verifiedNetworks = [];
      const verificationFailures = [];
      for (const [networkName, proofType, derivation] of proofTargets) {
        const publicAddress = attached.find(([name]) => name === networkName)?.[1];
        if (!publicAddress) continue;
        try {
          if (!recoveryPhrase && !["ethereum", "bnb"].includes(networkName)) {
            throw new Error("Encrypted recovery phrase is unavailable for deriving this network key.");
          }
          const challengeResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses/challenge", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
            body: JSON.stringify({ network: networkName, address: publicAddress }),
          });
          const challenge = await challengeResponse.json().catch(() => ({}));
          if (!challengeResponse.ok) throw new Error(challenge.detail || "Ownership challenge request failed.");
          let signature;
          if (proofType === "evm") {
            const proofWallet = recoveryPhrase
              ? HDNodeWallet.fromPhrase(recoveryPhrase, "", derivation)
              : unlocked;
            if (proofWallet.address.toLowerCase() !== publicAddress.toLowerCase()) throw new Error("Derived EVM address does not match the attached address.");
            signature = await proofWallet.signMessage(challenge.message);
          } else if (proofType === "bitcoin") {
            const proofWallet = HDNodeWallet.fromPhrase(recoveryPhrase, "", derivation);
            signature = proofWallet.signingKey.sign(keccak256(toUtf8Bytes(challenge.message))).serialized;
          } else {
            signature = await signSolanaMessage(recoveryPhrase, derivation, challenge.message);
          }
          const verifyResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
            body: JSON.stringify({ challenge_id: challenge.challenge_id, signature }),
          });
          const verified = await verifyResponse.json().catch(() => ({}));
          if (!verifyResponse.ok || verified.ownership_verified !== true) throw new Error(verified.detail || "Ownership proof was not accepted.");
          verifiedNetworks.push(networkName);
        } catch (error) {
          verificationFailures.push(networkName + ": " + (error?.message || "verification failed"));
        }
      }
      try { await onWalletCreated?.(); } catch {}
      setMessage(
        attachmentFailures.length || verificationFailures.length
          ? "Wallet address review completed. Verified: " + (verifiedNetworks.join(", ") || "none") +
            ". Address failures: " + (attachmentFailures.join("; ") || "none") +
            ". Ownership proof pending: " + (verificationFailures.join("; ") || "none") +
            ". Only verified addresses will be used for balances or transaction history."
          : "All attached network addresses passed ownership verification: " + verifiedNetworks.join(", ") + ". No transfer was made."
      );
    } catch (error) {
      setMessage(error?.message || "Network address verification failed.");
    } finally {
      setBusy(false);
    }
  }

  function downloadEncryptedBackup() {
    const entry = entries.find(item => item.walletId === selectedId);
    if (!entry) { setMessage("Choose a saved wallet before exporting its encrypted backup."); return; }
    try {
      const payload = createWalletBackupPayload(entry);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "world-wallet-" + String(entry.walletNumber || "backup") + "-encrypted-backup.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Encrypted backup downloaded. Upload that JSON file to Google Drive yourself; World Wallet AI does not upload it.");
    } catch (error) {
      setMessage(error?.message || "Encrypted backup export failed.");
    }
  }

  async function createWallet() {
    if (password.length < 10) {
      setMessage("Use a vault password of at least 10 characters. It is not sent to World Wallet AI.");
      return;
    }
    setBusy(true);
    setMessage("");
    setSignature("");
    setUnlocked(null);
    setUnlockedAddresses(null);
    try {
      const signer = Wallet.createRandom();
      const mnemonic = signer.mnemonic?.phrase;
      if (!mnemonic) throw new Error("The wallet provider did not return a recovery phrase. No incomplete wallet was saved.");
      const addresses = await deriveWalletAddresses(mnemonic);
      const encryptedJson = await signer.encrypt(password);
      const encryptedMnemonic = await encryptMnemonic(mnemonic, password);
      const walletNumber = createWalletNumber(readVault().map(item => item.walletNumber).filter(Boolean));
      const localWalletId = "local-" + walletNumber;
      const createdAt = new Date().toISOString();
      let walletId = localWalletId;
      const primaryAddress = addresses[network] || addresses.ethereum;
      const localEntry = {
        walletId,
        serverWalletId: "",
        walletNumber,
        ownerUserId: String(userId || ""),
        name: walletName.trim() || "New Wallet",
        address: primaryAddress,
        addresses,
        publicKey: signer.publicKey,
        network,
        encryptedJson,
        encryptedMnemonic,
        createdAt,
      };
      persistVault([localEntry, ...entries]);
      setSelectedId(walletId);
      setGenerated({
        walletId,
        walletNumber,
        name: localEntry.name,
        address: primaryAddress,
        addresses,
        publicKey: signer.publicKey,
        privateKey: signer.privateKey,
        mnemonic,
        network,
      });
      setPassword("");
      setMessage("Wallet created locally. Mainnet and separate testnet/devnet receiving addresses are ready. Save the recovery phrase securely.");

      try {
        const sessionToken = String(accessToken || "").startsWith("wwpin_")
        ? accessToken
        : (await getNeonAccessToken()) || accessToken;
        if (!sessionToken) throw new Error("No valid sign-in session.");
        const profileResponse = await fetch(apiBaseUrl + "/api/v1/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
          body: JSON.stringify({ name: localEntry.name }),
        });
        const profile = await profileResponse.json().catch(() => ({}));
        if (!profileResponse.ok) throw new Error(profile.detail || "Wallet profile request failed.");
        const serverWalletId = profile.wallet?.id;
        if (!serverWalletId) throw new Error("The API did not return a wallet ID.");
        const serverWalletNumber = String(profile.wallet?.wallet_number || walletNumber);
        const linkedEntry = { ...localEntry, walletId: serverWalletId, serverWalletId, walletNumber: serverWalletNumber };
        const attachmentFailures = [];
        for (const [addressNetwork, addressValue] of Object.entries(addresses)) {
          try {
            const addressResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(serverWalletId) + "/addresses", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
              body: JSON.stringify({ network: addressNetwork, address: addressValue, label: "generated " + serverWalletNumber }),
            });
            const addressData = await addressResponse.json().catch(() => ({}));
            if (!addressResponse.ok) throw new Error(addressData.detail || "Address save failed.");
          } catch (error) {
            attachmentFailures.push(addressNetwork + ": " + (error?.message || "save failed"));
          }
        }

        const verificationFailures = [];
        const verifiedNetworks = [];
        if (!attachmentFailures.length) {
          const proofTargets = [
            ["ethereum", addresses.ethereum, "evm", "m/44'/60'/0'/0/0"],
            ["bnb", addresses.bnb, "evm", "m/44'/60'/0'/0/0"],
            ["sepolia", addresses.sepolia, "evm", "m/44'/60'/1'/0/0"],
            ["bitcoin", addresses.bitcoin, "bitcoin", "m/84'/0'/0'/0/0"],
            ["solana_mainnet", addresses.solana_mainnet, "solana", 0],
            ["solana_devnet", addresses.solana_devnet, "solana", 1],
          ];
          for (const [proofNetwork, proofAddress, proofType, derivation] of proofTargets) {
            try {
              const challengeResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(serverWalletId) + "/addresses/challenge", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
                body: JSON.stringify({ network: proofNetwork, address: proofAddress }),
              });
              const challenge = await challengeResponse.json().catch(() => ({}));
              if (!challengeResponse.ok) throw new Error(challenge.detail || "Challenge request failed.");
              let proofSignature;
              if (proofType === "evm") {
                const proofWallet = HDNodeWallet.fromPhrase(mnemonic, "", derivation);
                if (proofWallet.address.toLowerCase() !== proofAddress.toLowerCase()) throw new Error("Derived EVM address did not match the saved address.");
                proofSignature = await proofWallet.signMessage(challenge.message);
              } else if (proofType === "bitcoin") {
                const proofWallet = HDNodeWallet.fromPhrase(mnemonic, "", derivation);
                const digest = keccak256(toUtf8Bytes(challenge.message));
                proofSignature = proofWallet.signingKey.sign(digest).serialized;
              } else {
                proofSignature = await signSolanaMessage(mnemonic, derivation, challenge.message);
              }
              const verifyResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(serverWalletId) + "/addresses/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
                body: JSON.stringify({ challenge_id: challenge.challenge_id, signature: proofSignature }),
              });
              const verified = await verifyResponse.json().catch(() => ({}));
              if (!verifyResponse.ok || verified.ownership_verified !== true) throw new Error(verified.detail || "Ownership proof was not accepted.");
              verifiedNetworks.push(proofNetwork);
            } catch (error) {
              verificationFailures.push(proofNetwork + ": " + (error?.message || "verification failed"));
            }
          }
        }

        const currentAccountEntries = readVaultForAccount(userId, allowedServerWalletIds)
          .filter(item => item.walletId !== localWalletId && item.walletId !== serverWalletId);
        persistVault([linkedEntry, ...currentAccountEntries], [localWalletId]);
        setSelectedId(serverWalletId);
        setGenerated(current => current ? { ...current, walletId: serverWalletId, walletNumber: serverWalletNumber } : current);
        if (attachmentFailures.length) {
          setMessage("Wallet " + serverWalletNumber + " is saved locally. Some public addresses could not sync: " + attachmentFailures.join("; ") + ". No deposit or gas activation was required.");
        } else if (verificationFailures.length) {
          setMessage("Wallet " + serverWalletNumber + " created with all six receive addresses saved. Verified ownership: " + (verifiedNetworks.join(", ") || "none") + ". Proof pending: " + verificationFailures.join("; ") + ". No deposit or gas activation was required.");
        } else {
          setMessage("Wallet " + serverWalletNumber + " created. Ethereum, BNB, Sepolia, Bitcoin Mainnet, Solana Mainnet and Solana Devnet ownership signatures verified. All six receive addresses are saved. No first payment, deposit or gas activation was required.");
        }
        try { await onWalletCreated?.(); } catch {}
      } catch (error) {
        setMessage("Wallet " + walletNumber + " and its encrypted recovery material are saved locally, but account sync failed: " + (error?.message || "server unavailable") + ". Retry sync from Wallets after signing in.");
      }
    } catch (error) {
      setMessage(error?.message || "Wallet generation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function unlockWallet() {
    const entry = entries.find(item => item.walletId === selectedId);
    if (!entry) return setMessage("Choose a locally saved wallet first.");
    if (!password) return setMessage("Enter the vault password used when creating this wallet.");
    setBusy(true);
    setMessage("");
    setSignature("");
    setTxHash("");
    setTokenTxHash("");
    setNativeBalance("");
    setVerifyResult(null);
    setSignMessage("");
    setVerifyAddressInput("");
    setVerifyMessageInput("");
    setVerifySignatureInput("");
    try {
      const signer = await Wallet.fromEncryptedJson(entry.encryptedJson, password);
      const expectedEvmAddress = entry.addresses?.ethereum || entry.address;
      if (signer.address.toLowerCase() !== String(expectedEvmAddress).toLowerCase()) throw new Error("Wallet address integrity check failed.");
      const recoveredPhrase = entry.encryptedMnemonic ? await decryptMnemonic(entry.encryptedMnemonic, password) : (signer.mnemonic?.phrase || "");
      const recoveredAddresses = recoveredPhrase
        ? await deriveWalletAddresses(recoveredPhrase)
        : (entry.addresses || { [entry.network || "ethereum"]: entry.address });
      if (recoveredAddresses.ethereum && recoveredAddresses.ethereum.toLowerCase() !== signer.address.toLowerCase()) throw new Error("Recovery phrase does not match the encrypted EVM key.");
      for (const [addressNetwork, storedAddress] of Object.entries(entry.addresses || {})) {
        const derivedAddress = recoveredAddresses[addressNetwork];
        if (derivedAddress && String(storedAddress).toLowerCase() !== String(derivedAddress).toLowerCase()) {
          throw new Error("Saved " + addressNetwork + " address does not match the locally decrypted recovery phrase. The wallet was not attached.");
        }
      }
      setUnlockedAddresses(recoveredAddresses);
      if (recoveredPhrase && (!entry.encryptedMnemonic || !entry.addresses)) {
        const updatedEntry = { ...entry, encryptedMnemonic: entry.encryptedMnemonic || await encryptMnemonic(recoveredPhrase, password), addresses: recoveredAddresses };
        persistVault(entries.map(item => item.walletId === entry.walletId ? updatedEntry : item));
      }
      setUnlocked(signer);
      setKeyRevealPassword("");
      setRevealedPrivateKey("");
      setGenerated(null);
      setMessage("Wallet unlocked in this browser session. The decrypted key is not sent to the API.");
      if (entry.network === "sepolia") {
        try {
          const provider = new JsonRpcProvider(SEPOLIA_RPC, 11155111);
          const networkInfo = await provider.getNetwork();
          if (networkInfo.chainId !== 11155111n) throw new Error("Configured RPC is not Ethereum Sepolia.");
          const balance = await provider.getBalance(signer.address);
          setNativeBalance(formatEther(balance));
        } catch (rpcError) {
          setNativeBalance("");
          setMessage("Wallet unlocked locally, but the Sepolia balance could not be checked: " + (rpcError?.shortMessage || rpcError?.message || "RPC unavailable") + ". Your key remains local; retry the balance check later.");
        }
      }
    } catch {
      setUnlocked(null);
      setUnlockedAddresses(null);
      setKeyRevealPassword("");
      setRevealedPrivateKey("");
      setMessage("Could not unlock this wallet. Check the password; the vault cannot recover a lost password.");
    } finally {
      setBusy(false);
    }
  }

  async function signLocalMessage() {
    if (!unlocked) return setMessage("Unlock a World Wallet AI local vault wallet first.");
    if (!signMessage.trim()) return setMessage("Enter a message to sign.");
    setBusy(true);
    setMessage("");
    try {
      const signed = await unlocked.signMessage(signMessage);
      const verified = verifyEvmMessageSignature(signMessage, signed, unlocked.address);
      setSignature(signed);
      setVerifyAddressInput(unlocked.address);
      setVerifyMessageInput(signMessage);
      setVerifySignatureInput(signed);
      setVerifyResult({
        ok: verified.valid,
        text: verified.valid ? "Verified inside World Wallet AI: recovered signer matches the unlocked local wallet." : "The signature did not match the unlocked local wallet.",
        recovered: verified.recoveredAddress,
      });
      setMessage("Message signed and cryptographically verified inside World Wallet AI. This is an off-chain signature, not a blockchain transaction.");
    } catch (error) {
      setMessage(error?.message || "Signing or local signature verification failed.");
    } finally {
      setBusy(false);
    }
  }

  function readTypedDataInputs() {
    let domain; let types; let value;
    try { domain = JSON.parse(typedDataDomainJson); } catch { throw new Error("Typed-data domain must be valid JSON."); }
    try { types = JSON.parse(typedDataTypesJson); } catch { throw new Error("Typed-data types must be valid JSON."); }
    try { value = JSON.parse(typedDataValueJson); } catch { throw new Error("Typed-data message must be valid JSON."); }
    return { domain, types, value };
  }

  async function signLocalTypedData() {
    if (!unlocked) return setTypedDataResult({ ok: false, text: "Unlock a World Wallet AI local vault wallet first." });
    setBusy(true);
    setTypedDataResult(null);
    try {
      const { domain, types, value } = readTypedDataInputs();
      const signed = await unlocked.signTypedData(domain, types, value);
      const verified = verifyEvmTypedDataSignature(domain, types, value, signed, unlocked.address);
      setTypedDataSignature(signed);
      setTypedDataResult({
        ok: verified.valid,
        text: verified.valid ? "EIP-712 signature verified inside World Wallet AI. Recovered signer matches the unlocked local wallet." : "EIP-712 signer did not match the unlocked local wallet.",
        recovered: verified.recoveredAddress,
      });
      setMessage("Typed data signed and cryptographically verified inside World Wallet AI. No transaction was sent.");
    } catch (error) {
      setTypedDataResult({ ok: false, text: error?.message || "Typed-data signing failed." });
    } finally {
      setBusy(false);
    }
  }

  function verifySignedMessage() {
    setVerifyResult(null);
    try {
      const result = verifyEvmMessageSignature(
        verifyMessageInput,
        verifySignatureInput.trim(),
        verifyAddressInput.trim(),
      );
      setVerifyResult({
        ok: result.valid,
        text: result.valid
          ? "Signature valid: the recovered EOA signer matches the supplied address."
          : "Signature is cryptographically valid but does not match the expected address.",
        recovered: result.recoveredAddress,
      });
    } catch (error) {
      setVerifyResult({ ok: false, text: error?.message || "Signature verification failed." });
    }
  }

  function verifyTypedDataLocalSignature() {
    setTypedDataResult(null);
    try {
      const { domain, types, value } = readTypedDataInputs();
      const result = verifyEvmTypedDataSignature(domain, types, value, typedDataSignature.trim(), verifyAddressInput.trim() || unlocked?.address || "");
      setTypedDataResult({
        ok: result.valid,
        text: result.valid
          ? "EIP-712 signature valid: recovered EOA signer matches the expected address."
          : "EIP-712 signature is valid but does not match the expected address.",
        recovered: result.recoveredAddress,
      });
    } catch (error) {
      setTypedDataResult({ ok: false, text: error?.message || "EIP-712 verification failed." });
    }
  }

  async function signAndVerifyExternalSmartWalletMessage() {
    setSmartWalletBusy(true);
    setSmartWalletResult(null);
    let provider;
    try {
      if (!unlocked) throw new Error("Unlock the matching World Wallet AI local vault wallet first.");
      if (unlocked.address.toLowerCase() !== smartWalletAddress.trim().toLowerCase()) {
        throw new Error("The unlocked local vault address does not match the external smart-wallet address. No signature was created.");
      }
      if (!smartWalletMessage.trim()) throw new Error("Enter the exact message you want to sign.");
      const configs = {
        ethereum: { chainId: 1, rpc: "https://ethereum-rpc.publicnode.com", label: "Ethereum Mainnet" },
        bnb: { chainId: 56, rpc: "https://bsc-dataseed.binance.org/", label: "BNB Chain Mainnet" },
      };
      const config = configs[smartWalletNetwork];
      if (!config) throw new Error("Select Ethereum Mainnet or BNB Chain Mainnet.");

      // The private key remains in the unlocked encrypted local vault. It is
      // never sent to the backend or to the external OKX wallet application.
      const signature = await unlocked.signMessage(smartWalletMessage);
      provider = new JsonRpcProvider(config.rpc, config.chainId, { staticNetwork: true });
      const verified = await verifyEip1271Signature(
        provider,
        smartWalletAddress.trim(),
        hashMessage(smartWalletMessage),
        signature,
        config.chainId,
      );
      if (!verified.valid) {
        throw new Error("The smart wallet did not accept the locally created signature. No transaction was sent.");
      }
      setSmartWalletSignature(signature);
      setSmartWalletResult({
        ok: true,
        text: "Signed inside World Wallet AI and verified by the smart wallet on " + config.label + ". EIP-1271 returned the valid magic value.",
        walletAddress: verified.walletAddress,
        chainId: verified.chainId,
        magicValue: verified.magicValue,
      });
      setMessage("The matching local vault key signed the message inside World Wallet AI. The smart wallet accepted the signature. No transaction was sent.");
    } catch (error) {
      setSmartWalletResult({ ok: false, text: error?.message || "In-app smart-wallet signing failed." });
    } finally {
      try { await provider?.destroy?.(); } catch {}
      setSmartWalletBusy(false);
    }
  }

  async function signAndSendOkxWalletCoreTransfer() {
    setSmartWalletTxBusy(true);
    setSmartWalletTxResult(null);
    let provider;
    let broadcastHash = "";
    let explorer = smartWalletNetwork === "bnb" ? "https://bscscan.com/tx/" : "https://etherscan.io/tx/";
    try {
      if (!unlocked) throw new Error("Unlock the matching World Wallet AI local vault wallet first.");
      if (unlocked.address.toLowerCase() !== smartWalletAddress.trim().toLowerCase()) {
        throw new Error("The unlocked local vault address does not match the smart wallet. No transaction was signed.");
      }
      if (!isAddress(smartWalletTransferRecipient.trim())) throw new Error("Enter a valid recipient address.");
      if (!smartWalletTransferAmount.trim()) throw new Error("Enter an amount greater than zero.");

      const configs = {
        ethereum: { chainId: 1, rpc: "https://ethereum-rpc.publicnode.com", label: "Ethereum Mainnet", nativeSymbol: "ETH" },
        bnb: { chainId: 56, rpc: "https://bsc-dataseed.binance.org/", label: "BNB Chain Mainnet", nativeSymbol: "BNB" },
      };
      const config = configs[smartWalletNetwork];
      if (!config) throw new Error("Select Ethereum Mainnet or BNB Chain Mainnet.");
      provider = new JsonRpcProvider(config.rpc, config.chainId, { staticNetwork: true });
      const chain = await provider.getNetwork();
      if (chain.chainId !== BigInt(config.chainId)) throw new Error("RPC chain ID does not match the selected network.");

      const walletAddress = smartWalletAddress.trim();
      const delegationCode = await provider.getCode(walletAddress);
      if (!isExpectedOkxWalletCoreDelegation(delegationCode)) {
        throw new Error("This address is not delegated to the expected OKX WalletCore implementation on " + config.label + ". Transaction signing is blocked.");
      }

      let calls;
      let actionLabel;
      let nativeAmount = 0n;
      if (smartWalletTransferType === "native") {
        try { nativeAmount = parseEther(smartWalletTransferAmount.trim()); } catch { throw new Error("Enter a valid " + config.nativeSymbol + " amount."); }
        if (nativeAmount <= 0n) throw new Error("Transfer amount must be greater than zero.");
        calls = [{ target: smartWalletTransferRecipient.trim(), value: nativeAmount, data: "0x" }];
        actionLabel = "Send " + smartWalletTransferAmount.trim() + " " + config.nativeSymbol + " to " + smartWalletTransferRecipient.trim();
      } else {
        if (!isAddress(smartWalletTokenAddress.trim())) throw new Error("Enter a valid ERC-20 token contract address.");
        const token = new Contract(
          smartWalletTokenAddress.trim(),
          [
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function balanceOf(address) view returns (uint256)",
            "function transfer(address,uint256) returns (bool)",
          ],
          provider,
        );
        const tokenCode = await provider.getCode(smartWalletTokenAddress.trim());
        if (!tokenCode || tokenCode === "0x") throw new Error("The token contract has no code on the selected network.");
        const decimals = Number(await token.decimals());
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Token decimals are outside the supported safe range.");
        let tokenAmount;
        try { tokenAmount = parseUnits(smartWalletTransferAmount.trim(), decimals); } catch { throw new Error("Enter a valid token amount using at most " + decimals + " decimal places."); }
        if (tokenAmount <= 0n) throw new Error("Token transfer amount must be greater than zero.");
        const tokenBalance = await token.balanceOf(walletAddress);
        if (tokenBalance < tokenAmount) throw new Error("The verified on-chain token balance is insufficient for this transfer.");
        const symbol = String(await token.symbol()).slice(0, 24);
        const data = token.interface.encodeFunctionData("transfer", [smartWalletTransferRecipient.trim(), tokenAmount]);
        calls = [{ target: smartWalletTokenAddress.trim(), value: 0n, data }];
        actionLabel = "Send " + smartWalletTransferAmount.trim() + " " + symbol + " from " + smartWalletTokenAddress.trim() + " to " + smartWalletTransferRecipient.trim();
      }

      const data = encodeOkxWalletCoreSelfExecution(calls);
      const fee = await provider.getFeeData();
      const feePerGas = fee.maxFeePerGas ?? fee.gasPrice;
      if (!feePerGas || feePerGas <= 0n) throw new Error("The selected RPC did not return usable gas-fee data.");
      const estimate = await provider.estimateGas({ from: walletAddress, to: walletAddress, data });
      const gasLimit = (estimate * 120n) / 100n;
      const maximumGasCost = gasLimit * feePerGas;
      const nativeBalance = await provider.getBalance(walletAddress);
      if (nativeBalance < maximumGasCost + nativeAmount) {
        throw new Error("Insufficient on-chain " + config.nativeSymbol + " for the transfer amount and estimated network fee.");
      }
      const feeText = formatEther(maximumGasCost) + " " + config.nativeSymbol + " maximum estimated network fee";
      const confirmation = [
        "World Wallet AI will sign locally and submit this WalletCore transaction.",
        "Network: " + config.label,
        "Wallet: " + walletAddress,
        "Action: " + actionLabel,
        "Gas limit: " + gasLimit.toString(),
        "Estimated fee ceiling: " + feeText,
        "The transaction is signed by the matching local vault key. No OKX app approval will be requested.",
        "Continue?",
      ].join("\n\n");
      if (!window.confirm(confirmation)) {
        setSmartWalletTxResult({ ok: false, text: "Transaction cancelled. Nothing was signed or submitted." });
        return;
      }

      const signer = unlocked.connect(provider);
      const txRequest = { to: walletAddress, data, gasLimit, chainId: config.chainId };
      if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
        txRequest.maxFeePerGas = fee.maxFeePerGas;
        txRequest.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
      } else {
        txRequest.gasPrice = fee.gasPrice;
      }
      const tx = await signer.sendTransaction(txRequest);
      broadcastHash = tx.hash;
      setSmartWalletTxResult({ ok: false, pending: true, text: "Transaction broadcast. Waiting for the first confirmation…", txHash: tx.hash, explorer });
      const receipt = await tx.wait(1);
      if (!receipt || Number(receipt.status) !== 1) throw new Error("The WalletCore transaction did not confirm successfully.");
      setSmartWalletTxResult({
        ok: true,
        pending: false,
        text: "WalletCore transaction confirmed on " + config.label + ".",
        txHash: tx.hash,
        explorer,
        blockNumber: receipt.blockNumber,
        action: actionLabel,
      });
    } catch (error) {
      setSmartWalletTxResult({
        ok: false,
        pending: false,
        text: broadcastHash
          ? "Transaction was broadcast but confirmation or the post-send check failed: " + (error?.shortMessage || error?.message || "Unknown error")
          : (error?.shortMessage || error?.message || "WalletCore transaction was not submitted."),
        txHash: broadcastHash,
        explorer,
      });
    } finally {
      try { await provider?.destroy?.(); } catch {}
      setSmartWalletTxBusy(false);
    }
  }

  async function verifyExternalSmartWalletMessage() {
    setSmartWalletBusy(true);
    setSmartWalletResult(null);
    let provider;
    try {
      const configs = {
        ethereum: { chainId: 1, rpc: "https://ethereum-rpc.publicnode.com", label: "Ethereum Mainnet" },
        bnb: { chainId: 56, rpc: "https://bsc-dataseed.binance.org/", label: "BNB Chain Mainnet" },
      };
      const config = configs[smartWalletNetwork];
      if (!config) throw new Error("Select Ethereum Mainnet or BNB Chain Mainnet.");
      if (!smartWalletMessage) throw new Error("Enter the exact original message.");
      provider = new JsonRpcProvider(config.rpc, config.chainId, { staticNetwork: true });
      const result = await verifyEip1271Signature(
        provider,
        smartWalletAddress.trim(),
        hashMessage(smartWalletMessage),
        smartWalletSignature.trim(),
        config.chainId,
      );
      setSmartWalletResult({
        ok: result.valid,
        text: result.valid
          ? "Verified by the smart wallet on " + config.label + ": ERC-1271 returned the valid magic value."
          : "The smart wallet rejected this signature on " + config.label + ".",
        walletAddress: result.walletAddress,
        chainId: result.chainId,
        magicValue: result.magicValue,
      });
    } catch (error) {
      setSmartWalletResult({ ok: false, text: error?.message || "Smart-wallet verification failed." });
    } finally {
      try { await provider?.destroy?.(); } catch {}
      setSmartWalletBusy(false);
    }
  }

  async function sendSepoliaEth() {
    if (!unlocked || selected?.network !== "sepolia") {
      setMessage("Unlock a wallet connected to Ethereum Sepolia first.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) {
      setMessage("Enter a valid 0x recipient address.");
      return;
    }
    let value;
    try { value = parseEther(sendAmount); } catch {
      setMessage("Enter a valid positive ETH amount.");
      return;
    }
    if (value <= 0n) {
      setMessage("Enter an amount greater than zero.");
      return;
    }
    if (!window.confirm("Send " + sendAmount + " Sepolia ETH from " + unlocked.address + " to " + recipient.trim() + "? This signs and broadcasts a testnet transaction.")) return;
    setBusy(true);
    setMessage("");
    setTxHash("");
    let broadcastHash = "";
    try {
      const provider = new JsonRpcProvider(SEPOLIA_RPC, 11155111);
      const networkInfo = await provider.getNetwork();
      if (networkInfo.chainId !== 11155111n) throw new Error("The configured RPC did not identify itself as Ethereum Sepolia.");
      const signer = unlocked.connect(provider);
      const tx = await signer.sendTransaction({ to: recipient.trim(), value });
      broadcastHash = tx.hash;
      setTxHash(tx.hash);
      setMessage("Sepolia transaction submitted. Waiting for confirmation…");
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("The transaction did not confirm successfully.");
      setNativeBalance(formatEther(await provider.getBalance(unlocked.address)));
      setMessage("Sepolia transaction confirmed. This testnet transaction is not a production wallet ledger entry.");
      setSendAmount("");
    } catch (error) {
      const detail = error?.shortMessage || error?.message || "Unknown RPC error";
      setMessage(broadcastHash
        ? "Sepolia transaction was broadcast (hash shown below), but confirmation or the balance refresh failed: " + detail + ". Check the transaction on Sepolia Etherscan before retrying."
        : "Sepolia transaction was not confirmed as broadcast: " + detail);
    } finally {
      setBusy(false);
    }
  }

  async function sendSepoliaToken() {
    if (!unlocked || selected?.network !== "sepolia") {
      setMessage("Unlock a wallet connected to Ethereum Sepolia first.");
      return;
    }
    if (!isAddress(tokenContractAddress.trim())) {
      setMessage("Enter a valid deployed ERC-20 contract address.");
      return;
    }
    if (!isAddress(tokenRecipient.trim())) {
      setMessage("Enter a valid recipient address.");
      return;
    }
    if (!tokenAmount.trim()) {
      setMessage("Enter a token amount greater than zero.");
      return;
    }
    setBusy(true);
    setMessage("");
    setTokenTxHash("");
    let tokenBroadcastHash = "";
    try {
      const provider = new JsonRpcProvider(SEPOLIA_RPC, 11155111);
      const networkInfo = await provider.getNetwork();
      if (networkInfo.chainId !== 11155111n) {
        throw new Error("The configured RPC did not identify itself as Ethereum Sepolia.");
      }
      const signer = unlocked.connect(provider);
      const token = new Contract(
        tokenContractAddress.trim(),
        [
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
          "function transfer(address to,uint256 amount) returns (bool)"
        ],
        signer
      );
      const [symbol, decimalsValue] = await Promise.all([token.symbol(), token.decimals()]);
      const decimals = Number(decimalsValue);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error("The token returned invalid decimals.");
      }
      let value;
      try { value = parseUnits(tokenAmount.trim(), decimals); } catch {
        throw new Error("Enter a valid token amount for " + symbol + ".");
      }
      if (value <= 0n) throw new Error("Enter a token amount greater than zero.");
      if (!window.confirm("Send " + tokenAmount.trim() + " " + symbol + " from " + unlocked.address + " to " + tokenRecipient.trim() + "? Verify the contract address before approving.")) return;
      const tx = await token.transfer(tokenRecipient.trim(), value);
      tokenBroadcastHash = tx.hash;
      setTokenTxHash(tx.hash);
      setMessage(symbol + " transfer submitted on Sepolia. Waiting for confirmation…");
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("The token transfer did not confirm successfully.");
      setNativeBalance(formatEther(await provider.getBalance(unlocked.address)));
      setMessage(symbol + " transfer confirmed on Ethereum Sepolia.");
      setTokenAmount("");
    } catch (error) {
      const detail = error?.shortMessage || error?.message || "Unknown RPC error";
      setMessage(tokenBroadcastHash
        ? "Token transfer was broadcast (hash shown below), but confirmation or the balance refresh failed: " + detail + ". Check the transaction on Sepolia Etherscan before retrying."
        : "Token transfer was not confirmed as broadcast: " + detail);
    } finally {
      setBusy(false);
    }
  }

  function forgetLocalEntry(walletId) {
    const next = entries.filter(item => item.walletId !== walletId);
    persistVault(next);
    if (selectedId === walletId) {
      setSelectedId(next[0]?.walletId || "");
      setUnlocked(null);
      setUnlockedAddresses(null);
      setPassword("");
      setRecipient("");
      setSendAmount("");
      setTokenRecipient("");
      setTokenAmount("");
      setKeyRevealPassword("");
      setRevealedPrivateKey("");
      setNativeBalance("");
      setTxHash("");
      setTokenTxHash("");
      setSignature("");
      setVerifyResult(null);
      setSignMessage("");
      setVerifyAddressInput("");
      setVerifyMessageInput("");
      setVerifySignatureInput("");
    }
    setGenerated(null);
    setMessage("Encrypted wallet copy removed from this browser only. This does not delete the server wallet profile or recover a forgotten password.");
  }

  const selected = entries.find(item => item.walletId === selectedId);
  const shown = generated || (unlocked ? {
    walletId: selected?.walletId,
    walletNumber: selected?.walletNumber,
    name: selected?.name,
    address: unlocked.address,
    addresses: unlockedAddresses || selected?.addresses || {},
    publicKey: unlocked.publicKey,
    network: selected?.network,
  } : null);

  return <section className="wallet-vault">
    <article className="panel action-panel">
      <p className="feature-kicker">NON-CUSTODIAL WALLET VAULT</p>
      <h2>Generate a signing wallet</h2>
      <p className="muted">A new independent wallet is generated in this browser. It derives the complete mainnet address set and separate testnet/devnet addresses. Only public addresses and an 11-digit wallet number are sent to your account; encrypted recovery material stays on this device.</p>
      <div className="feature-grid">
        <label>Wallet name<input value={walletName} onChange={event => setWalletName(event.target.value)} maxLength="80" placeholder="Personal Wallet" /></label>
        <label>Initial activity network<select value={network} onChange={event => setNetwork(event.target.value)}><option value="ethereum">Ethereum Mainnet</option><option value="bnb">BNB Chain Mainnet</option><option value="sepolia">Ethereum Sepolia (testnet)</option></select></label>
      </div>
      <label>Local vault password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="At least 10 characters" /></label>
      <button className="primary feature-submit" disabled={busy || !accessToken} onClick={createWallet}>{busy ? "Generating secure wallet…" : "Generate complete wallet →"}</button>
      <div className="security-note">Sepolia RPC endpoint for public testnet access: {SEPOLIA_RPC}. CoinGecko supplies market prices, not blockchain RPC. For production, the server should use its configured WORLD_WALLET_SEPOLIA_RPC_URL.</div>
    </article>

    {message && <div className={/could not|failed|cannot|enter|choose|password|couldn't|error/i.test(message) ? "feature-error" : "feature-success"}>{message}</div>}

    {shown && <article className="panel action-panel">
      <p className="feature-kicker">WALLET DETAILS</p>
      <h2>{shown.name || "Wallet"}</h2>
      <div className="wallet-detail-grid">
        <div><small>Wallet ID</small><code>{shown.walletNumber || "Legacy ID unavailable"}</code></div>
        <div><small>Wallet model</small><b>Self-custody · Mainnet + separate testnets</b></div>
        <div><small>Selected address</small><code>{shown.address}</code></div>
        {Object.entries(shown.addresses || {}).map(([addressNetwork, addressValue]) => <div key={addressNetwork}><small>{({ethereum:"Ethereum Mainnet",bnb:"BNB Chain Mainnet",bitcoin:"Bitcoin Mainnet",solana_mainnet:"Solana Mainnet",sepolia:"Ethereum Sepolia (testnet)",solana_devnet:"Solana Devnet (testnet)"})[addressNetwork] || addressNetwork}</small><code>{addressValue}</code></div>)}
      </div>
      {generated && <div className="wallet-secret-warning">
        {generated.secretsHidden ? <>
          <strong>Recovery material hidden from this page.</strong>
          <small>The private key and recovery phrase were cleared from the page state. The encrypted local wallet remains saved, but this page cannot show the recovery phrase again. Save your recovery material securely before hiding it.</small>
        </> : <>
          <strong>Secret recovery material — save it before leaving.</strong>
          <small>Anyone with the private key or recovery phrase can control this wallet. World Wallet AI never receives these values. Do not share them in chat, screenshots, or support requests.</small>
          <label>Private key (shown once)<textarea readOnly rows="2" value={generated.privateKey} /></label>
          {generated.mnemonic && <label>Recovery phrase (shown once)<textarea readOnly rows="2" value={generated.mnemonic} /></label>}
          <button className="secondary" onClick={() => setGenerated(current => current ? { ...current, privateKey: "", mnemonic: "", secretsHidden: true } : current)}>Hide and clear recovery material</button>
        </>}
      </div>}
      {shown.network === "sepolia" && nativeBalance !== "" && <div className="security-note">Live Sepolia ETH balance: <strong>{Number(nativeBalance).toLocaleString("en-US", { maximumFractionDigits: 8 })} ETH</strong> <span>(public RPC read; testnet funds only)</span></div>}
      <div className="security-note">Smart-contract addresses are managed separately. This panel shows your wallet address, not a token contract address.</div>
      <a className="secondary" href={shown.network === "sepolia" ? "https://sepolia.etherscan.io/address/" + shown.address : shown.network === "bnb" ? "https://bscscan.com/address/" + shown.address : shown.network === "ethereum" ? "https://etherscan.io/address/" + shown.address : "https://etherscan.io/"} target="_blank" rel="noreferrer">View wallet address in Explorer ↗</a>
      <button className="secondary" onClick={async () => { try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(shown.address); setMessage("Wallet address copied."); } catch { setMessage("Could not access clipboard. Select and copy the wallet address above manually."); } }}>Copy wallet address</button>
    </article>}

    <article className="panel action-panel">
      <p className="feature-kicker">GOOGLE DRIVE WALLET BACKUPS</p>
      <h2>Connect and import an existing wallet</h2>
      <p className="muted">Google Drive access is read-only. The app lists likely wallet-backup files; only a file you select is downloaded and inspected locally in this browser. Recovery phrases and private keys are never sent to the World Wallet AI backend.</p>
      {(!GOOGLE_API_KEY || !GOOGLE_CLIENT_ID) ? (
        <div className="security-note">Google Drive setup is required on the World Wallet AI frontend build: add <code>VITE_GOOGLE_API_KEY</code> and <code>VITE_GOOGLE_CLIENT_ID</code>. Enable the Google Drive API, restrict the API key to that API and your frontend origin, and use a Web OAuth client ID with this site's JavaScript origin.</div>
      ) : (
        <div className="feature-grid">
          <button type="button" className="primary" disabled={!googleReady || driveBusy} onClick={connectGoogleDrive}>{driveBusy ? "Connecting / reading Drive…" : driveAccessToken ? "Refresh Google Drive backups" : googleReady ? "Connect Google Drive →" : "Loading Google sign-in…"}</button>
          {driveAccessToken && <button type="button" className="secondary" onClick={() => { setDriveAccessToken(""); setDriveFiles([]); setMessage("Google Drive access token cleared from this page session."); }}>Disconnect Drive</button>}
        </div>
      )}
      {driveFiles.length > 0 && <div className="wallet-detail-grid">
        {driveFiles.map(file => <div key={file.id}>
          <small>{file.name} · {file.mimeType || "file"}{file.modifiedTime ? " · " + new Date(file.modifiedTime).toLocaleDateString() : ""}</small>
          <button type="button" className="secondary" disabled={driveBusy || busy} onClick={() => importGoogleDriveFile(file)}>Inspect and import this backup</button>
        </div>)}
      </div>}
      <label>Import a backup from this device (.json or .txt)<input type="file" accept=".json,.txt,.wallet,.backup,application/json,text/plain,application/octet-stream" onChange={handleLocalBackupFile} disabled={busy || driveBusy} /></label>
      <label>New local vault password for a plain 12/24-word phrase<input type="password" value={importPassword} onChange={event => setImportPassword(event.target.value)} autoComplete="new-password" placeholder="At least 10 characters; used only on this device" /></label>
      <div className="security-note">Supported formats: World Wallet AI encrypted backup JSON, or a TXT/JSON file containing one 12- or 24-word recovery phrase. Image/photo OCR and Google Docs-native files are not enabled. Plain phrases are encrypted immediately in this browser before they are saved.</div>
      {selected && !selected.serverWalletId && <div className="feature-grid">
        <button type="button" className="primary" disabled={busy || !unlocked || !unlockedAddresses} onClick={attachSelectedWalletToAccount}>Attach verified wallet to account (public addresses only)</button>
        <button type="button" className="secondary" disabled={busy} onClick={downloadEncryptedBackup}>Download encrypted backup</button>
        {!unlocked && <small className="muted">Unlock this wallet below first. World Wallet AI checks the decrypted recovery material against the saved public addresses before attachment.</small>}
      </div>}
      {selected?.serverWalletId && <div className="feature-grid">
        <button type="button" className="primary" disabled={busy || !unlocked || !unlockedAddresses} onClick={verifySelectedWalletAddresses}>Verify attached network addresses →</button>
        {!unlocked && <small className="muted">For older wallets, unlock the encrypted local copy first. This re-proves the attached public addresses using local signatures only.</small>}
      </div>}
      <p className="feature-kicker">MULTI-WALLET LOCAL SIGNING</p>
      <h2>Unlock a saved wallet</h2>
      <p className="muted">Choose one of the encrypted wallet copies saved in this browser. Passwords and decrypted keys stay in memory only while this page is open.</p>
      <label>Wallet<select disabled={busy} value={selectedId} onChange={event => { const nextId = event.target.value; const nextEntry = entries.find(item => item.walletId === nextId); setSelectedId(nextId); setPassword(""); setUnlocked(null); setUnlockedAddresses(null); setGenerated(null); if (nextEntry?.serverWalletId) onWalletSelected?.(nextEntry.serverWalletId); else if (nextEntry && activeWalletId) setMessage("This imported wallet is local-only until attached. The active account wallet, balances, and history remain separate."); setNativeBalance(""); setTxHash(""); setTokenTxHash(""); setTokenRecipient(""); setTokenAmount(""); setSendAmount(""); setKeyRevealPassword(""); setRevealedPrivateKey(""); setSignature(""); setVerifyResult(null); setSignMessage(""); setVerifyAddressInput(""); setVerifyMessageInput(""); setVerifySignatureInput(""); if (nextEntry && !nextEntry.serverWalletId && activeWalletId) setMessage("This imported wallet is local-only until attached. The active account wallet, balances, and history remain separate."); else setMessage(""); }}><option value="">Select a wallet</option>{entries.map(item => <option key={item.walletId} value={item.walletId}>{item.name} · ID {item.walletNumber || "legacy"} — {item.address.slice(0, 8)}…</option>)}</select></label>
      {selected && <div className="wallet-detail-grid"><div><small>Wallet ID</small><code>{selected.walletNumber || "Legacy ID unavailable"}</code></div>{Object.entries(selected.addresses || { ethereum: selected.address }).map(([addressNetwork, addressValue]) => <div key={addressNetwork}><small>{({ethereum:"Ethereum Mainnet",bnb:"BNB Chain Mainnet",bitcoin:"Bitcoin Mainnet",solana_mainnet:"Solana Mainnet",sepolia:"Ethereum Sepolia",solana_devnet:"Solana Devnet"})[addressNetwork] || addressNetwork}</small><code>{addressValue}</code></div>)}</div>}
      {selected && <a className="secondary" href={selected.network === "sepolia" ? "https://sepolia.etherscan.io/address/" + selected.address : selected.network === "bnb" ? "https://bscscan.com/address/" + selected.address : selected.network === "ethereum" ? "https://etherscan.io/address/" + selected.address : "https://etherscan.io/"} target="_blank" rel="noreferrer">View selected wallet in Explorer ↗</a>}
      <label>Vault password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="Vault password" /></label>
      <button className="primary feature-submit" disabled={busy || !selected || !password} onClick={unlockWallet}>{busy ? "Unlocking…" : "Unlock selected wallet →"}</button>
      {unlocked && <div className="wallet-message-signing">
        <h3>Private key security</h3>
        <p className="muted">The private key is the wallet's secret signing key. Reveal it only on a trusted device. It stays in this browser and is never sent to World Wallet AI.</p>
        {!revealedPrivateKey ? <>
          <label>Confirm vault password to reveal private key<input type="password" value={keyRevealPassword} onChange={event => setKeyRevealPassword(event.target.value)} autoComplete="current-password" placeholder="Re-enter vault password" /></label>
          <button className="secondary" disabled={busy || !keyRevealPassword} onClick={async () => {
            setBusy(true);
            try {
              const checked = await Wallet.fromEncryptedJson(selected.encryptedJson, keyRevealPassword);
              if (checked.address.toLowerCase() !== unlocked.address.toLowerCase()) throw new Error("Wallet address does not match.");
              setRevealedPrivateKey(checked.privateKey);
              setKeyRevealPassword("");
              setMessage("Private key revealed locally. Hide it when finished.");
            } catch {
              setMessage("Private key not revealed. The vault password was incorrect.");
            } finally { setBusy(false); }
          }}>Reveal private key</button>
        </> : <>
          <label>Private key<textarea readOnly rows="2" value={revealedPrivateKey} /></label>
          <button className="secondary" onClick={async () => { try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(revealedPrivateKey); setMessage("Private key copied. Keep it secret and clear your clipboard when finished."); } catch { setMessage("Clipboard unavailable. Do not paste your private key into chat or support; copy it manually only in a trusted private environment."); } }}>Copy private key</button>
          <button className="secondary" onClick={() => { setRevealedPrivateKey(""); setKeyRevealPassword(""); }}>Hide and clear private key</button>
        </>}
        <div className="security-note">Never share this key. Anyone who obtains it can control the wallet. Recovery phrases are shown only when generated and are not recoverable from this screen.</div>
      </div>}
      {unlocked && <div className="wallet-message-signing">
        <button className="secondary" onClick={() => { setUnlocked(null); setUnlockedAddresses(null); setPassword(""); setNativeBalance(""); setTxHash(""); setTokenTxHash(""); setRecipient(""); setSendAmount(""); setTokenRecipient(""); setTokenAmount(""); setKeyRevealPassword(""); setRevealedPrivateKey(""); setSignature(""); setSignMessage(""); setTypedDataSignature(""); setTypedDataResult(null); setVerifyResult(null); setVerifyAddressInput(""); setVerifyMessageInput(""); setVerifySignatureInput(""); setMessage("Wallet locked in this browser session. Balance, signatures, and transaction details were cleared from this view."); }}>Lock wallet</button>
        <label>Message to sign<textarea rows="3" value={signMessage} onChange={event => { setSignMessage(event.target.value); setSignature(""); }} placeholder="Sign a message to prove control of this address" /></label>
        <button className="secondary" disabled={busy || !signMessage.trim()} onClick={signLocalMessage}>{busy ? "Signing…" : "Sign message inside World Wallet AI"}</button>
        {signature && <label>Signature<textarea readOnly rows="3" value={signature} /></label>}
        <div className="wallet-message-signing">
          <h3>Verify a signed message</h3>
          <p className="muted">World Wallet AI recovers the EOA signer locally and compares it with the expected address. A valid message signature is not a transaction confirmation.</p>
          <label>Expected wallet address<input value={verifyAddressInput} onChange={event => { setVerifyAddressInput(event.target.value); setVerifyResult(null); setTypedDataResult(null); }} placeholder="0x…" autoComplete="off" /></label>
          <label>Exact signed message<textarea rows="3" value={verifyMessageInput} onChange={event => { setVerifyMessageInput(event.target.value); setVerifyResult(null); }} placeholder="Paste the exact original message" /></label>
          <label>Signature<input value={verifySignatureInput} onChange={event => { setVerifySignatureInput(event.target.value); setVerifyResult(null); }} placeholder="0x…" autoComplete="off" /></label>
          <button className="secondary" disabled={busy} onClick={verifySignedMessage}>Verify message signature</button>
          {verifyResult && <div className={verifyResult.ok ? "feature-success" : "feature-error"}>{verifyResult.text}{verifyResult.recovered && <div><small>Recovered signer: <code>{verifyResult.recovered}</code></small></div>}</div>}
        </div>
        <div className="wallet-message-signing">
          <h3>Sign and verify EIP-712 typed data</h3>
          <p className="muted">Structured-data signatures are created only by the unlocked encrypted local vault wallet. The domain should include the intended chain ID and verifying contract where applicable.</p>
          <label>EIP-712 domain JSON<textarea rows="3" value={typedDataDomainJson} onChange={event => { setTypedDataDomainJson(event.target.value); setTypedDataSignature(""); setTypedDataResult(null); }} placeholder='{"name":"My dApp","version":"1","chainId":1}' /></label>
          <label>EIP-712 types JSON<textarea rows="4" value={typedDataTypesJson} onChange={event => { setTypedDataTypesJson(event.target.value); setTypedDataSignature(""); setTypedDataResult(null); }} placeholder='{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"}]}' /></label>
          <label>EIP-712 message JSON<textarea rows="4" value={typedDataValueJson} onChange={event => { setTypedDataValueJson(event.target.value); setTypedDataSignature(""); setTypedDataResult(null); }} placeholder='{"owner":"0x…","spender":"0x…","value":"1000"}' /></label>
          <button className="secondary" disabled={busy || !typedDataDomainJson.trim() || !typedDataTypesJson.trim() || !typedDataValueJson.trim()} onClick={signLocalTypedData}>Sign typed data inside World Wallet AI</button>
          {typedDataSignature && <label>Typed-data signature<textarea rows="3" value={typedDataSignature} onChange={event => { setTypedDataSignature(event.target.value); setTypedDataResult(null); }} placeholder="Paste a 65-byte EIP-712 signature to verify" /></label>}
          <button className="secondary" disabled={busy || !typedDataSignature.trim()} onClick={verifyTypedDataLocalSignature}>Verify EIP-712 signature</button>
          {typedDataResult && <div className={typedDataResult.ok ? "feature-success" : "feature-error"}>{typedDataResult.text}{typedDataResult.recovered && <div><small>Recovered signer: <code>{typedDataResult.recovered}</code></small></div>}</div>}
        </div>
        <p className="security-note">This local signing panel cannot sign for an external OKX-held address such as 0xbb unless that address's authorized signing key is available through a supported wallet session. Never import or reveal a seed phrase or private key to bypass that boundary. External EIP-1271 smart-wallet verification is available separately below; this local signing panel still signs only for the unlocked local EOA.</p>

        {selected?.network === "sepolia" && <div className="wallet-message-signing">
          <h3>Send Sepolia test ETH</h3>
          <label>Recipient address<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="0x…" /></label>
          <label>Amount (Sepolia ETH)<input inputMode="decimal" value={sendAmount} onChange={event => setSendAmount(event.target.value)} placeholder="0.001" /></label>
          <button className="primary feature-submit" disabled={busy || !recipient.trim() || !sendAmount.trim()} onClick={sendSepoliaEth}>{busy ? "Signing / waiting…" : "Sign and send Sepolia ETH →"}</button>
          {txHash && <div className="security-note">Transaction: <a href={"https://sepolia.etherscan.io/tx/" + txHash} target="_blank" rel="noreferrer">{txHash} ↗</a></div>}
          <div className="security-note">Testnet only. Requires Sepolia ETH for gas. The private key signs in this browser and is never uploaded; this direct transfer is not recorded in the app's internal transaction ledger.</div>
          <div className="wallet-message-signing">
            <h3>Send Sepolia ERC-20 token</h3>
            {deployedContracts.some(item => item.network === "sepolia" && /^0x[a-fA-F0-9]{40}$/.test(String(item.address || ""))) && <label>Choose saved deployed token<select value={deployedContracts.some(item => item.network === "sepolia" && item.address === tokenContractAddress) ? tokenContractAddress : ""} onChange={event => setTokenContractAddress(event.target.value)}><option value="">Choose a saved token contract</option>{deployedContracts.filter(item => item.network === "sepolia" && /^0x[a-fA-F0-9]{40}$/.test(String(item.address || ""))).map((item,index) => <option key={item.address + index} value={item.address}>{item.name || item.symbol || "Token"} ({item.symbol || "ERC-20"})</option>)}</select></label>}
            <label>Token contract address<input value={tokenContractAddress} onChange={event => setTokenContractAddress(event.target.value)} placeholder="0x… deployed token contract" autoComplete="off" /></label>
            <label>Recipient address<input value={tokenRecipient} onChange={event => setTokenRecipient(event.target.value)} placeholder="0x…" autoComplete="off" /></label>
            <label>Token amount<input inputMode="decimal" value={tokenAmount} onChange={event => setTokenAmount(event.target.value)} placeholder="1.0" /></label>
            <button className="primary feature-submit" disabled={busy || !tokenContractAddress.trim() || !tokenRecipient.trim() || !tokenAmount.trim()} onClick={sendSepoliaToken}>{busy ? "Signing / waiting…" : "Sign and send ERC-20 →"}</button>
            {tokenTxHash && <div className="security-note">Token transaction: <a href={"https://sepolia.etherscan.io/tx/" + tokenTxHash} target="_blank" rel="noreferrer">{tokenTxHash} ↗</a></div>}
            <div className="security-note">Only use a verified ERC-20 contract on Sepolia. This reads the token's on-chain symbol and decimals; it does not invent a token balance or price. Requires Sepolia ETH for gas.</div>
          </div>
        </div>}
      </div>}
    <div className="wallet-message-signing">
      <h3>Verify external OKX smart-wallet signature</h3>
      <p className="muted">Read-only verification for your existing 0xbb EIP-7702 account. World Wallet AI calls isValidSignature on the selected network and accepts only the EIP-1271 magic value. This check does not unlock or access the wallet's private key.</p>
      <label>Wallet address<input value={smartWalletAddress} onChange={event => { setSmartWalletAddress(event.target.value); setSmartWalletResult(null); }} placeholder="0x smart-wallet address" autoComplete="off" /></label>
      <label>Verification network<select value={smartWalletNetwork} onChange={event => { setSmartWalletNetwork(event.target.value); setSmartWalletResult(null); }}>
        <option value="ethereum">Ethereum Mainnet</option><option value="bnb">BNB Chain Mainnet</option>
      </select></label>
      <label>Exact signed message<textarea rows="3" value={smartWalletMessage} onChange={event => { setSmartWalletMessage(event.target.value); setSmartWalletResult(null); }} placeholder="Paste the exact message that was signed" /></label>
      <div className="security-note">{unlocked
        ? unlocked.address.toLowerCase() === smartWalletAddress.trim().toLowerCase()
          ? "The unlocked World Wallet AI vault address matches this smart wallet. Local in-app signing is available."
          : "The unlocked vault address does not match this smart wallet. Signing is disabled."
        : "Unlock a local vault wallet whose public address exactly matches this smart wallet. Import/recovery material stays on this device; never paste it into chat or send it to the backend."}</div>
      <button className="primary feature-submit" disabled={smartWalletBusy || !unlocked || unlocked.address.toLowerCase() !== smartWalletAddress.trim().toLowerCase() || !smartWalletMessage.trim()} onClick={signAndVerifyExternalSmartWalletMessage}>{smartWalletBusy ? "Signing and verifying…" : "Sign and verify with World Wallet AI"}</button>
      <label>Existing signature<input value={smartWalletSignature} onChange={event => { setSmartWalletSignature(event.target.value); setSmartWalletResult(null); }} placeholder="Paste signature from the authorized wallet session" autoComplete="off" /></label>
      <button className="secondary" disabled={smartWalletBusy || !smartWalletAddress.trim() || !smartWalletMessage || !smartWalletSignature.trim()} onClick={verifyExternalSmartWalletMessage}>{smartWalletBusy ? "Checking smart wallet…" : "Verify signature inside World Wallet AI"}</button>
      {smartWalletResult && <div className={smartWalletResult.ok ? "feature-success" : "feature-error"}>{smartWalletResult.text}{smartWalletResult.walletAddress && <div><small>Wallet: <code>{smartWalletResult.walletAddress}</code> · Chain ID {smartWalletResult.chainId} · Return: <code>{smartWalletResult.magicValue}</code></small></div>}</div>}
      <p className="security-note">This verifies a signature already supplied to World Wallet AI. It creates a signature only when the unlocked encrypted local vault contains the exact owner key for this address. This requires the user to import or recover that key locally; a different wallet key cannot sign as 0xbb. If the deployed implementation rejects or does not support ERC-1271, verification fails closed.</p>
      <div className="wallet-message-signing">
        <h3>Send from this smart wallet inside World Wallet AI</h3>
        <p className="muted">Native ETH/BNB and ERC-20 transfers only. The app checks chain ID, exact EIP-7702 WalletCore delegation, recipient, live token balance and gas estimate. It signs a WalletCore self-call with the matching locally unlocked key.</p>
        <label>Transfer type<select value={smartWalletTransferType} onChange={event => { setSmartWalletTransferType(event.target.value); setSmartWalletTxResult(null); }}>
          <option value="native">Native {smartWalletNetwork === "bnb" ? "BNB" : "ETH"}</option>
          <option value="erc20">ERC-20 token</option>
        </select></label>
        <label>Recipient address<input value={smartWalletTransferRecipient} onChange={event => { setSmartWalletTransferRecipient(event.target.value); setSmartWalletTxResult(null); }} placeholder="0x…" autoComplete="off" /></label>
        {smartWalletTransferType === "erc20" && <label>ERC-20 token contract<input value={smartWalletTokenAddress} onChange={event => { setSmartWalletTokenAddress(event.target.value); setSmartWalletTxResult(null); }} placeholder="0x token contract" autoComplete="off" /></label>}
        <label>Amount<input inputMode="decimal" value={smartWalletTransferAmount} onChange={event => { setSmartWalletTransferAmount(event.target.value); setSmartWalletTxResult(null); }} placeholder="0.01" /></label>
        <button className="primary feature-submit" disabled={smartWalletTxBusy || !unlocked || unlocked.address.toLowerCase() !== smartWalletAddress.trim().toLowerCase() || !smartWalletTransferRecipient.trim() || !smartWalletTransferAmount.trim() || (smartWalletTransferType === "erc20" && !smartWalletTokenAddress.trim())} onClick={signAndSendOkxWalletCoreTransfer}>{smartWalletTxBusy ? "Signing / waiting for confirmation…" : "Sign and send inside World Wallet AI"}</button>
        {smartWalletTxResult && <div className={smartWalletTxResult.ok ? "feature-success" : "feature-error"}>
          {smartWalletTxResult.text}
          {smartWalletTxResult.action && <div><small>{smartWalletTxResult.action}</small></div>}
          {smartWalletTxResult.txHash && <div><small>Transaction: <a href={smartWalletTxResult.explorer + smartWalletTxResult.txHash} target="_blank" rel="noreferrer">{smartWalletTxResult.txHash} ↗</a></small></div>}
          {smartWalletTxResult.blockNumber && <div><small>Confirmed block: {smartWalletTxResult.blockNumber}</small></div>}
        </div>}
        <p className="security-note">This sends a real transaction and spends funds and network gas. The button remains disabled unless the unlocked local vault address exactly matches the smart wallet. Always review the recipient, token contract, amount and fee ceiling in the confirmation prompt. No OKX app approval is requested by this local signing path.</p>
      </div>
    </div>
      {selected && <button className="secondary" onClick={() => forgetLocalEntry(selected.walletId)}>Remove encrypted copy from this browser</button>}
      <div className="security-note">Local signing supports message signatures, typed-data signatures, direct Sepolia test transfers, and WalletCore native/selected ERC-20 transfers for an unlocked matching EIP-7702 owner key. The WalletCore route is guarded by an exact delegation-code check and explicit transaction confirmation.</div>
    </article>
  </section>;
}
