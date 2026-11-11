import { useEffect, useRef, useState } from "react";
import { TonConnectButton, useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";
import { tonFriendlyAddress, tonNetworkFromChainId, tonToNano } from "./ton-address.js";

async function authHeaders(accessToken, extra = {}) {
  if (String(accessToken || "").startsWith("wwpin_")) {
    return { ...extra, Authorization: "Bearer " + accessToken };
  }
  const freshToken = await getNeonAccessToken({ forceRefresh: true });
  const token = freshToken || (isUsableNeonAccessToken(accessToken) ? accessToken : "");
  return { ...extra, ...(token ? { Authorization: "Bearer " + token } : {}) };
}

export default function TonWalletConnect({ walletId, accessToken, apiBaseUrl, onAddressSaved }) {
  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState("");
  const lastAttached = useRef("");

  const network = tonNetworkFromChainId(wallet?.account?.chain);
  const address = wallet?.account?.address || "";
  const walletName = wallet?.device?.appName || "TON Connect wallet";

  useEffect(() => {
    if (!wallet || !walletId || !address || !network) return undefined;
    const key = [walletId, network, address].join(":");
    if (lastAttached.current === key) return undefined;
    let cancelled = false;
    setSaving(true);
    setMessage("");
    (async () => {
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses", {
          method: "POST",
          headers: await authHeaders(accessToken, { "Content-Type": "application/json" }),
          body: JSON.stringify({ network, address, label: walletName }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "TON wallet address could not be saved.");
        if (cancelled) return;
        lastAttached.current = key;
        setMessage(network === "ton_mainnet"
          ? "TON Mainnet address saved to this wallet. Public balance lookup is enabled."
          : "TON Testnet address saved separately from Mainnet. Public balance lookup is enabled.");
        onAddressSaved?.();
      } catch (error) {
        if (!cancelled) setMessage(error.message || "TON wallet connection could not be saved.");
      } finally {
        if (!cancelled) setSaving(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletId, address, network, walletName, accessToken, apiBaseUrl, onAddressSaved]);

  const sendTon = async () => {
    setSending(true);
    setSendMessage("");
    try {
      if (!wallet || !network) throw new Error("Connect a TON wallet on Mainnet or Testnet first.");
      const destination = tonFriendlyAddress(recipient, network === "ton_testnet");
      const nanoAmount = tonToNano(amount);
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        network: wallet.account.chain,
        messages: [{ address: destination, amount: nanoAmount }],
      });
      setSendMessage("The connected wallet returned a signed transaction response. Check the TON explorer for on-chain confirmation.");
      setRecipient("");
      setAmount("");
    } catch (error) {
      setSendMessage(error?.message || "TON transaction request failed or was cancelled.");
    } finally {
      setSending(false);
    }
  };

  const supportedChain = Boolean(wallet && network);
  return (
    <article className="panel action-panel ton-connect-panel">
      <div className="panel-head">
        <div>
          <p className="feature-kicker">TON CONNECT</p>
          <h2>Connect a TON wallet</h2>
          <span>Tonkeeper, Wallet in Telegram and other compatible TON Connect wallets</span>
        </div>
        <TonConnectButton />
      </div>
      {!wallet && <p className="muted">Connect a wallet to save its address to the selected World Wallet AI wallet. Each connected address stays saved when you later switch to another compatible TON wallet.</p>}
      {wallet && (
        <div className="security-note">
          <b>{walletName}</b> · {network === "ton_mainnet" ? "TON Mainnet" : network === "ton_testnet" ? "TON Testnet" : "Unsupported TON network"}
          <br />
          <code>{address}</code>
          {walletId ? <div>Wallet ID: {walletId}</div> : <div>Select or create a World Wallet AI wallet before attaching this address.</div>}
        </div>
      )}
      {saving && <div className="feature-loading" role="status">Saving TON address…</div>}
      {message && <div className="feature-success" role="status">{message}</div>}
      {wallet && (
        <div className="ton-send-area">
          <h3>Send native TON</h3>
          <p className="muted">The connected wallet displays and approves the transaction. World Wallet AI never receives your recovery phrase or private key.</p>
          <label>Recipient TON address<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="EQ… / UQ… / raw TON address" autoComplete="off" /></label>
          <label>Amount (TON)<input value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.1" inputMode="decimal" /></label>
          <button className="primary" type="button" onClick={sendTon} disabled={!supportedChain || sending || !recipient.trim() || !amount.trim()}>{sending ? "Waiting for wallet…" : "Review and send TON →"}</button>
          {sendMessage && <div className={/failed|cancelled|invalid|connect/i.test(sendMessage) ? "feature-error" : "security-note"} role="status">{sendMessage}</div>}
        </div>
      )}
      <div className="security-note">TON Mainnet and TON Testnet use separate saved addresses and separate RPC/indexer endpoints. A connected public address is not marked ownership-verified by this read-only balance feature. Transaction signing remains inside your selected wallet.</div>
    </article>
  );
}
