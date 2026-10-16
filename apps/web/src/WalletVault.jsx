import { useEffect, useState } from "react";
import { Contract, JsonRpcProvider, Wallet, formatEther, isAddress, parseEther, parseUnits, verifyMessage } from "ethers";
import { getNeonAccessToken } from "./auth-client.js";

const VAULT_KEY = "world_wallet_encrypted_vault_v1";
const SEPOLIA_RPC = (import.meta.env.VITE_WORLD_WALLET_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com").trim();

function readVault() {
  try {
    const value = JSON.parse(localStorage.getItem(VAULT_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export default function WalletVault({ accessToken, apiBaseUrl, onWalletCreated }) {
  const [entries, setEntries] = useState([]);
  const [walletName, setWalletName] = useState("Personal Wallet");
  const [password, setPassword] = useState("");
  const [network, setNetwork] = useState("sepolia");
  const [generated, setGenerated] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [unlocked, setUnlocked] = useState(null);
  const [keyRevealPassword, setKeyRevealPassword] = useState("");
  const [revealedPrivateKey, setRevealedPrivateKey] = useState("");
  const [signMessage, setSignMessage] = useState("");
  const [signature, setSignature] = useState("");
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

  useEffect(() => {
    const saved = readVault();
    setEntries(saved);
    try { const deployed = JSON.parse(localStorage.getItem("world_wallet_deployed_contracts_v1") || "[]"); setDeployedContracts(Array.isArray(deployed) ? deployed : []); } catch { setDeployedContracts([]); }
    window.addEventListener("world-wallet-contracts-updated", () => { try { const deployed = JSON.parse(localStorage.getItem("world_wallet_deployed_contracts_v1") || "[]"); setDeployedContracts(Array.isArray(deployed) ? deployed : []); } catch { setDeployedContracts([]); } });
    if (saved.length) setSelectedId(saved[0].walletId);
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
  }, []);

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

  function persistVault(next) {
    localStorage.setItem(VAULT_KEY, JSON.stringify(next));
    setEntries(next);
    try { window.dispatchEvent(new Event("world-wallet-local-vault-updated")); } catch {}
  }

  async function createWallet() {
    if (password.length < 10) {
      setMessage("Use a vault password of at least 10 characters. It is not sent to World Wallet AI.");
      return;
    }
    setBusy(true);
    setMessage("");
    setSignature("");
    try {
      // Generate and securely encrypt locally first. A temporary API/auth outage must
      // never prevent the user from seeing or saving the key material they just created.
      const signer = Wallet.createRandom();
      const encryptedJson = await signer.encrypt(password);
      const localWalletId = "local-" + (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
      const createdAt = new Date().toISOString();
      let walletId = localWalletId;
      let profileWarning = "";
      let addressWarning = "";

      // Persist a recoverable encrypted local entry and show the generated keys before
      // making optional backend calls. Neither password nor plaintext private key is sent.
      const localEntry = {
        walletId,
        name: walletName.trim() || "New Wallet",
        address: signer.address,
        publicKey: signer.publicKey,
        network,
        encryptedJson,
        createdAt,
      };
      persistVault([localEntry, ...readVault()]);
      setSelectedId(walletId);
      setUnlocked(null);
      setGenerated({
        walletId,
        name: localEntry.name,
        address: signer.address,
        publicKey: signer.publicKey,
        privateKey: signer.privateKey,
        mnemonic: signer.mnemonic?.phrase || "",
        network,
      });
      setPassword("");
      setMessage("Wallet keys generated locally. Save the private key and recovery phrase securely now.");

      // Backend profile and address linking are best-effort follow-up operations.
      try {
        const freshToken = await getNeonAccessToken();
        const sessionToken = freshToken || accessToken;
        if (!sessionToken) throw new Error("No valid sign-in session.");
        const profileResponse = await fetch(apiBaseUrl + "/api/v1/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
          body: JSON.stringify({ name: localEntry.name }),
        });
        const profile = await profileResponse.json();
        if (!profileResponse.ok) throw new Error(profile.detail || "Wallet profile request failed.");
        const serverWalletId = profile.wallet?.id;
        if (!serverWalletId) throw new Error("The API did not return a wallet ID.");

        const addressResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(serverWalletId) + "/addresses", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
          body: JSON.stringify({ network, address: signer.address, label: "generated" }),
        });
        const addressData = await addressResponse.json();
        if (!addressResponse.ok) {
          walletId = serverWalletId;
          addressWarning = addressData.detail || "Public address linking failed.";
        } else {
          walletId = serverWalletId;
        }
        const linkedEntry = { ...localEntry, walletId };
        persistVault([linkedEntry, ...readVault().filter(item => item.address.toLowerCase() !== signer.address.toLowerCase())]);
        setSelectedId(walletId);
        setGenerated(current => current ? { ...current, walletId } : current);
        if (!addressResponse.ok) {
          setMessage("Wallet keys generated and saved locally, but the server could not link the public address: " + addressWarning + " You can connect it again later.");
        } else {
          setMessage("Wallet generated. Your public wallet address is saved; private key and recovery phrase are shown only in this session. Save them securely before leaving.");
        }
        try { await onWalletCreated?.(); } catch {}
      } catch (error) {
        profileWarning = error?.message || "The server profile could not be created.";
        setMessage("Wallet keys generated and encrypted locally, but server sync failed: " + profileWarning + " Your local wallet is saved in this browser. Keep the recovery material safe; use the same browser and vault password to unlock it.");
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
    setNativeBalance("");
    try {
      const signer = await Wallet.fromEncryptedJson(entry.encryptedJson, password);
      if (signer.address.toLowerCase() !== entry.address.toLowerCase()) throw new Error("Wallet address integrity check failed.");
      setUnlocked(signer);
      setKeyRevealPassword("");
      setRevealedPrivateKey("");
      setGenerated(null);
      if (entry.network === "sepolia") {
        const provider = new JsonRpcProvider(SEPOLIA_RPC, 11155111);
        const networkInfo = await provider.getNetwork();
        if (networkInfo.chainId !== 11155111n) throw new Error("Configured RPC is not Ethereum Sepolia.");
        const balance = await provider.getBalance(signer.address);
        setNativeBalance(formatEther(balance));
      }
      setMessage("Wallet unlocked in this browser session. The decrypted key is not sent to the API.");
    } catch {
      setUnlocked(null);
      setKeyRevealPassword("");
      setRevealedPrivateKey("");
      setMessage("Could not unlock this wallet. Check the password; the vault cannot recover a lost password.");
    } finally {
      setBusy(false);
    }
  }

  async function signLocalMessage() {
    if (!unlocked) return setMessage("Unlock a local wallet first.");
    if (!signMessage.trim()) return setMessage("Enter a message to sign.");
    setBusy(true);
    setMessage("");
    try {
      const signed = await unlocked.signMessage(signMessage);
      setSignature(signed);
      setMessage("Message signed locally. This is an off-chain signature, not a blockchain transaction.");
    } catch (error) {
      setMessage(error.message || "Signing failed.");
    } finally {
      setBusy(false);
    }
  }

  function verifySignedMessage() {
    setVerifyResult(null);
    const addressToCheck = verifyAddressInput.trim();
    const messageToCheck = verifyMessageInput;
    const signatureToCheck = verifySignatureInput.trim();
    if (!isAddress(addressToCheck)) {
      setVerifyResult({ ok: false, text: "Enter a valid EVM wallet address." });
      return;
    }
    if (!messageToCheck) {
      setVerifyResult({ ok: false, text: "Enter the exact original message that was signed." });
      return;
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(signatureToCheck)) {
      setVerifyResult({ ok: false, text: "Enter a 65-byte EVM message signature (0x followed by 130 hexadecimal characters)." });
      return;
    }
    try {
      const recovered = verifyMessage(messageToCheck, signatureToCheck);
      const matches = recovered.toLowerCase() === addressToCheck.toLowerCase();
      setVerifyResult({
        ok: matches,
        text: matches
          ? "Signature valid: the recovered signer matches the supplied address."
          : "Signature does not match this address. Check the exact message, signature, and network wallet address.",
        recovered,
      });
    } catch {
      setVerifyResult({ ok: false, text: "Signature could not be decoded as a standard EVM personal-message signature." });
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
    try {
      const provider = new JsonRpcProvider(SEPOLIA_RPC, 11155111);
      const networkInfo = await provider.getNetwork();
      if (networkInfo.chainId !== 11155111n) throw new Error("The configured RPC did not identify itself as Ethereum Sepolia.");
      const signer = unlocked.connect(provider);
      const tx = await signer.sendTransaction({ to: recipient.trim(), value });
      setTxHash(tx.hash);
      setMessage("Sepolia transaction submitted. Waiting for confirmation…");
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("The transaction did not confirm successfully.");
      setNativeBalance(formatEther(await provider.getBalance(unlocked.address)));
      setMessage("Sepolia transaction confirmed. This testnet transaction is not a production wallet ledger entry.");
      setSendAmount("");
    } catch (error) {
      setMessage(error?.shortMessage || error?.message || "Sepolia transaction failed.");
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
      setTokenTxHash(tx.hash);
      setMessage(symbol + " transfer submitted on Sepolia. Waiting for confirmation…");
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("The token transfer did not confirm successfully.");
      setNativeBalance(formatEther(await provider.getBalance(unlocked.address)));
      setMessage(symbol + " transfer confirmed on Ethereum Sepolia.");
      setTokenAmount("");
    } catch (error) {
      setMessage(error?.shortMessage || error?.message || "Sepolia token transfer failed.");
    } finally {
      setBusy(false);
    }
  }

  function forgetLocalEntry(walletId) {
    const next = readVault().filter(item => item.walletId !== walletId);
    persistVault(next);
    if (selectedId === walletId) {
      setSelectedId(next[0]?.walletId || "");
      setUnlocked(null);
      setKeyRevealPassword("");
      setRevealedPrivateKey("");
    }
    setGenerated(null);
    setMessage("Encrypted wallet copy removed from this browser only. This does not delete the server wallet profile or recover a forgotten password.");
  }

  const selected = entries.find(item => item.walletId === selectedId);
  const shown = generated || (unlocked ? {
    walletId: selected?.walletId,
    name: selected?.name,
    address: unlocked.address,
    publicKey: unlocked.publicKey,
    network: selected?.network,
  } : null);

  return <section className="wallet-vault">
    <article className="panel action-panel">
      <p className="feature-kicker">NON-CUSTODIAL WALLET VAULT</p>
      <h2>Generate a signing wallet</h2>
      <p className="muted">Wallet keys are generated in this browser. Only the wallet ID and public address are sent to the API. An encrypted keystore is stored locally; the vault password is never stored or transmitted.</p>
      <div className="feature-grid">
        <label>Wallet name<input value={walletName} onChange={event => setWalletName(event.target.value)} maxLength="80" placeholder="Personal Wallet" /></label>
        <label>Default network<select value={network} onChange={event => setNetwork(event.target.value)}><option value="sepolia">Ethereum Sepolia (testnet)</option><option value="ethereum">Ethereum mainnet</option><option value="bnb">BNB Chain</option></select></label>
      </div>
      <label>Local vault password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="At least 10 characters" /></label>
      <button className="primary feature-submit" disabled={busy || !accessToken} onClick={createWallet}>{busy ? "Working…" : "Generate wallet + address →"}</button>
      <div className="security-note">Sepolia RPC endpoint for public testnet access: {SEPOLIA_RPC}. CoinGecko supplies market prices, not blockchain RPC. For production, the server should use its configured WORLD_WALLET_SEPOLIA_RPC_URL.</div>
    </article>

    {message && <div className={/could not|failed|cannot|enter|choose|password|couldn't|error/i.test(message) ? "feature-error" : "feature-success"}>{message}</div>}

    {shown && <article className="panel action-panel">
      <p className="feature-kicker">WALLET DETAILS</p>
      <h2>{shown.name || "Wallet"}</h2>
      <div className="wallet-detail-grid">
        <div><small>Wallet ID</small><code>{shown.walletId}</code></div>
        <div><small>Network</small><b>{shown.network === "sepolia" ? "Ethereum Sepolia" : shown.network === "bnb" ? "BNB Chain" : "Ethereum"}</b></div>
        <div><small>Wallet address</small><code>{shown.address}</code></div>
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
      <p className="feature-kicker">MULTI-WALLET LOCAL SIGNING</p>
      <h2>Unlock a saved wallet</h2>
      <p className="muted">Choose one of the encrypted wallet copies saved in this browser. Passwords and decrypted keys stay in memory only while this page is open.</p>
      <label>Wallet<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setUnlocked(null); setGenerated(null); setNativeBalance(""); setTxHash(""); setTokenTxHash(""); setKeyRevealPassword(""); setRevealedPrivateKey(""); setSignature(""); setMessage(""); }}><option value="">Select a wallet</option>{entries.map(item => <option key={item.walletId} value={item.walletId}>{item.name} — {item.address.slice(0, 8)}… ({item.network})</option>)}</select></label>
      {selected && <div className="wallet-detail-grid"><div><small>Wallet ID</small><code>{selected.walletId}</code></div><div><small>Address</small><code>{selected.address}</code></div></div>}
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
        <button className="secondary" onClick={() => { setUnlocked(null); setNativeBalance(""); setTxHash(""); setTokenTxHash(""); setKeyRevealPassword(""); setRevealedPrivateKey(""); setSignature(""); setMessage("Wallet locked in this browser session. Balance and transaction details were cleared from this view."); }}>Lock wallet</button>
        <label>Message to sign<textarea rows="3" value={signMessage} onChange={event => setSignMessage(event.target.value)} placeholder="Sign a message to prove control of this address" /></label>
        <button className="secondary" disabled={busy || !signMessage.trim()} onClick={signLocalMessage}>{busy ? "Signing…" : "Sign message locally"}</button>
        {signature && <label>Signature<textarea readOnly rows="3" value={signature} /></label>}
        <div className="wallet-message-signing">
          <h3>Verify a signed message</h3>
          <p className="muted">Recover the signer from an EVM personal-message signature. This verifies a message signature only; it does not authorize or verify a blockchain transaction.</p>
          <label>Expected wallet address<input value={verifyAddressInput} onChange={event => setVerifyAddressInput(event.target.value)} placeholder="0x…" autoComplete="off" /></label>
          <label>Exact signed message<textarea rows="3" value={verifyMessageInput} onChange={event => setVerifyMessageInput(event.target.value)} placeholder="Paste the exact original message" /></label>
          <label>Signature<input value={verifySignatureInput} onChange={event => setVerifySignatureInput(event.target.value)} placeholder="0x…" autoComplete="off" /></label>
          <button className="secondary" onClick={verifySignedMessage}>Verify message signature</button>
          {verifyResult && <div className={verifyResult.ok ? "feature-success" : "feature-error"}>{verifyResult.text}{verifyResult.recovered && <div><small>Recovered signer: <code>{verifyResult.recovered}</code></small></div>}</div>}
        </div>
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
      {selected && <button className="secondary" onClick={() => forgetLocalEntry(selected.walletId)}>Remove encrypted copy from this browser</button>}
      <div className="security-note">Local signing supports message signatures and direct Sepolia test ETH transfers. Mainnet, BNB Chain, and ERC-20 transaction signing continue to use the existing external-wallet flow and configured contract support.</div>
    </article>
  </section>;
}
