import { useEffect, useState } from "react";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";

const VAULT_KEY = "world_wallet_encrypted_vault_v1";
const SEPOLIA_RPC = "https://rpc.sepolia.dev";

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
  const [signMessage, setSignMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [recipient, setRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [txHash, setTxHash] = useState("");
  const [contracts, setContracts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const saved = readVault();
    setEntries(saved);
    if (saved.length) setSelectedId(saved[0].walletId);
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    fetch(apiBaseUrl + "/api/v1/tokens", { headers: { Authorization: "Bearer " + accessToken } })
      .then(async response => {
        const data = await response.json();
        if (response.ok) setContracts(data.tokens || []);
      })
      .catch(() => {});
  }, [accessToken, apiBaseUrl]);

  function persistVault(next) {
    localStorage.setItem(VAULT_KEY, JSON.stringify(next));
    setEntries(next);
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
      const signer = Wallet.createRandom();
      const encryptedJson = await signer.encrypt(password);
      const profileResponse = await fetch(apiBaseUrl + "/api/v1/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ name: walletName.trim() || "New Wallet" }),
      });
      const profile = await profileResponse.json();
      if (!profileResponse.ok) throw new Error(profile.detail || "Could not create wallet profile.");

      const walletId = profile.wallet?.id;
      if (!walletId) throw new Error("Wallet profile was created but the API did not return its wallet ID.");
      const addressResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ network, address: signer.address, label: "generated" }),
      });
      const addressData = await addressResponse.json();
      if (!addressResponse.ok) throw new Error(addressData.detail || "Wallet profile created, but the public address could not be connected.");

      const entry = {
        walletId,
        name: walletName.trim() || "New Wallet",
        address: signer.address,
        publicKey: signer.publicKey,
        network,
        encryptedJson,
        createdAt: new Date().toISOString(),
      };
      const next = [entry, ...readVault().filter(item => item.walletId !== walletId)];
      persistVault(next);
      setSelectedId(walletId);
      setUnlocked(null);
      setGenerated({
        walletId,
        name: entry.name,
        address: signer.address,
        publicKey: signer.publicKey,
        privateKey: signer.privateKey,
        mnemonic: signer.mnemonic?.phrase || "",
        network,
      });
      setPassword("");
      onWalletCreated?.();
      setMessage("Wallet created. The private key and recovery phrase are shown only in this session; save them securely before leaving this page.");
    } catch (error) {
      setMessage(error.message || "Wallet generation failed.");
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
    try {
      const signer = await Wallet.fromEncryptedJson(entry.encryptedJson, password);
      if (signer.address.toLowerCase() !== entry.address.toLowerCase()) throw new Error("Wallet address integrity check failed.");
      setUnlocked(signer);
      setGenerated(null);
      setMessage("Wallet unlocked in this browser session. The decrypted key is not sent to the API.");
    } catch {
      setUnlocked(null);
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
      setMessage("Sepolia transaction confirmed. This testnet transaction is not a production wallet ledger entry.");
      setSendAmount("");
    } catch (error) {
      setMessage(error?.shortMessage || error?.message || "Sepolia transaction failed.");
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
    }
    setGenerated(null);
    setMessage("Encrypted wallet copy removed from this browser only. This does not delete the server wallet profile or recover a forgotten password.");
  }

  const selected = entries.find(item => item.walletId === selectedId);
  const balmzContract = contracts.find(item => item.symbol === "BALMZ" && item.network === "ethereum")?.contract_address;
  const sepoliaContract = contracts.find(item => item.symbol === "BALMZ-SEP" && item.network === "sepolia")?.contract_address;
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
        <div><small>Public key</small><code>{shown.publicKey}</code></div>
      </div>
      {generated && <div className="wallet-secret-warning">
        <strong>Secret recovery material — save it before leaving.</strong>
        <small>Anyone with the private key or recovery phrase can control this wallet. World Wallet AI never receives these values. Do not share them in chat, screenshots, or support requests.</small>
        <label>Private key (shown once)<textarea readOnly rows="2" value={generated.privateKey} /></label>
        {generated.mnemonic && <label>Recovery phrase (shown once)<textarea readOnly rows="2" value={generated.mnemonic} /></label>}
      </div>}
      <div className="security-note">BALMZ Ethereum contract: <code>{balmzContract || "Not configured / not deployed"}</code></div>
      <div className="security-note">BALMZ Sepolia contract: <code>{sepoliaContract || "Not configured / not deployed"}</code></div>
      <div className="security-note">A wallet address is not a token contract address. Do not substitute one for the other.</div>
      <button className="secondary" onClick={() => navigator.clipboard?.writeText(shown.address)}>Copy wallet address</button>
      <button className="secondary" onClick={() => navigator.clipboard?.writeText(shown.publicKey)}>Copy public key</button>
      {generated && <button className="secondary" onClick={() => navigator.clipboard?.writeText(generated.privateKey)}>Copy private key</button>}
    </article>}

    <article className="panel action-panel">
      <p className="feature-kicker">MULTI-WALLET LOCAL SIGNING</p>
      <h2>Unlock a saved wallet</h2>
      <p className="muted">Choose one of the encrypted wallet copies saved in this browser. Passwords and decrypted keys stay in memory only while this page is open.</p>
      <label>Wallet<select value={selectedId} onChange={event => { setSelectedId(event.target.value); setUnlocked(null); setGenerated(null); setSignature(""); }}><option value="">Select a wallet</option>{entries.map(item => <option key={item.walletId} value={item.walletId}>{item.name} — {item.address.slice(0, 8)}… ({item.network})</option>)}</select></label>
      {selected && <div className="wallet-detail-grid"><div><small>Wallet ID</small><code>{selected.walletId}</code></div><div><small>Address</small><code>{selected.address}</code></div><div><small>Public key</small><code>{selected.publicKey}</code></div></div>}
      <label>Vault password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="Vault password" /></label>
      <button className="primary feature-submit" disabled={busy || !selected || !password} onClick={unlockWallet}>{busy ? "Unlocking…" : "Unlock selected wallet →"}</button>
      {unlocked && <div className="wallet-message-signing">
        <label>Message to sign<textarea rows="3" value={signMessage} onChange={event => setSignMessage(event.target.value)} placeholder="Sign a message to prove control of this address" /></label>
        <button className="secondary" disabled={busy || !signMessage.trim()} onClick={signLocalMessage}>{busy ? "Signing…" : "Sign message locally"}</button>
        {signature && <label>Signature<textarea readOnly rows="3" value={signature} /></label>}
        {selected?.network === "sepolia" && <div className="wallet-message-signing">
          <h3>Send Sepolia test ETH</h3>
          <label>Recipient address<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="0x…" /></label>
          <label>Amount (Sepolia ETH)<input inputMode="decimal" value={sendAmount} onChange={event => setSendAmount(event.target.value)} placeholder="0.001" /></label>
          <button className="primary feature-submit" disabled={busy || !recipient.trim() || !sendAmount.trim()} onClick={sendSepoliaEth}>{busy ? "Signing / waiting…" : "Sign and send Sepolia ETH →"}</button>
          {txHash && <div className="security-note">Transaction: <a href={"https://sepolia.etherscan.io/tx/" + txHash} target="_blank" rel="noreferrer">{txHash} ↗</a></div>}
          <div className="security-note">Testnet only. Requires Sepolia ETH for gas. The private key signs in this browser and is never uploaded; this direct transfer is not recorded in the app's internal transaction ledger.</div>
        </div>}
      </div>}
      {selected && <button className="secondary" onClick={() => forgetLocalEntry(selected.walletId)}>Remove encrypted copy from this browser</button>}
      <div className="security-note">This currently signs messages locally. On-chain transaction signing remains subject to the existing external-wallet flow and configured network/contract support.</div>
    </article>
  </section>;
}
