import { useCallback, useEffect, useRef, useState } from "react";
import { TonConnectButton, useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";
import { tonFriendlyAddress, tonNetworkFromChainId, tonToNano } from "./ton-address.js";
import { buildJettonTransferPayload } from "./ton-jetton.js";

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
  const [jettons, setJettons] = useState([]);
  const [jettonsAvailable, setJettonsAvailable] = useState(false);
  const [jettonsLoading, setJettonsLoading] = useState(false);
  const [jettonsMessage, setJettonsMessage] = useState("");
  const [selectedJettonAddress, setSelectedJettonAddress] = useState("");
  const [jettonRecipient, setJettonRecipient] = useState("");
  const [jettonAmount, setJettonAmount] = useState("");
  const [jettonSending, setJettonSending] = useState(false);
  const [jettonSendMessage, setJettonSendMessage] = useState("");
  const lastAttached = useRef("");

  const network = tonNetworkFromChainId(wallet?.account?.chain);
  const address = wallet?.account?.address || "";
  const walletName = wallet?.device?.appName || "TON Connect wallet";
  const isTestnet = network === "ton_testnet";

  const refreshJettons = useCallback(async () => {
    if (!walletId || !address || !network) return;
    setJettonsLoading(true);
    setJettonsMessage("");
    try {
      const query = new URLSearchParams({ network, address });
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(walletId) + "/addresses/balance?" + query.toString(), {
        headers: await authHeaders(accessToken),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Could not refresh this TON account's Jetton balances.");
      const next = Array.isArray(data.jettons) ? data.jettons : [];
      setJettons(next);
      setJettonsAvailable(data.jettons_available === true);
      setSelectedJettonAddress(current => next.some(item => item.master_address === current) ? current : (next[0]?.master_address || ""));
      if (data.jettons_warning) setJettonsMessage(data.jettons_warning);
      else if (!next.length) setJettonsMessage("No Jetton balances were returned for this address.");
    } catch (error) {
      setJettonsAvailable(false);
      setJettonsMessage(error?.message || "Jetton index is unavailable.");
    } finally {
      setJettonsLoading(false);
    }
  }, [walletId, address, network, apiBaseUrl, accessToken]);

  useEffect(() => {
    if (!wallet || !walletId || !address || !network) return undefined;
    const key = [walletId, network, address].join(":");
    if (lastAttached.current === key) {
      void refreshJettons();
      return undefined;
    }
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
        await refreshJettons();
      } catch (error) {
        if (!cancelled) setMessage(error.message || "TON wallet connection could not be saved.");
      } finally {
        if (!cancelled) setSaving(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletId, address, network, walletName, accessToken, apiBaseUrl, onAddressSaved, refreshJettons]);

  const sendTon = async () => {
    setSending(true);
    setSendMessage("");
    try {
      if (!wallet || !network) throw new Error("Connect a TON wallet on Mainnet or Testnet first.");
      const destination = tonFriendlyAddress(recipient, isTestnet);
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

  const selectedJetton = jettons.find(item => item.master_address === selectedJettonAddress) || null;
  const sendJetton = async () => {
    setJettonSending(true);
    setJettonSendMessage("");
    try {
      if (!wallet || !network || !address) throw new Error("Connect a TON wallet on Mainnet or Testnet first.");
      if (!selectedJetton) throw new Error("Select a Jetton balance to transfer.");
      if (selectedJetton.decimals === null || selectedJetton.decimals === undefined) {
        throw new Error("This Jetton has no valid decimal metadata. Transfer is disabled rather than guessing its precision.");
      }
      if (!selectedJetton.wallet_address) {
        throw new Error("The indexer did not return the sender Jetton wallet address. Refresh balances before trying again.");
      }
      const destination = tonFriendlyAddress(jettonRecipient, isTestnet);
      const sourceJettonWallet = tonFriendlyAddress(selectedJetton.wallet_address, isTestnet);
      const responseDestination = tonFriendlyAddress(address, isTestnet);
      const payload = buildJettonTransferPayload({
        amount: jettonAmount,
        decimals: selectedJetton.decimals,
        destination,
        responseDestination,
        queryId: String(Date.now()),
        forwardTonAmount: "1",
      });
      // 0.05 TON is attached to the Jetton-wallet message for execution fees.
      // The connected wallet shows the complete outgoing request for approval.
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        network: wallet.account.chain,
        messages: [{
          address: sourceJettonWallet,
          amount: "50000000",
          payload,
        }],
      });
      setJettonSendMessage("The connected wallet returned a signed Jetton transfer response. The 0.05 TON fee attachment was included; verify final settlement on the correct TON explorer.");
      setJettonRecipient("");
      setJettonAmount("");
    } catch (error) {
      setJettonSendMessage(error?.message || "Jetton transaction request failed or was cancelled.");
    } finally {
      setJettonSending(false);
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
      {!wallet && <p className="muted">Connect a wallet to save its address to the selected World Wallet AI wallet. Each connected address stays saved when you later connect another compatible TON wallet.</p>}
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
        <>
          <div className="ton-send-area">
            <h3>Send native TON</h3>
            <p className="muted">The connected wallet displays and approves the transaction. World Wallet AI never receives your recovery phrase or private key.</p>
            <label>Recipient TON address<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="EQ… / UQ… / raw TON address" autoComplete="off" /></label>
            <label>Amount (TON)<input value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.1" inputMode="decimal" /></label>
            <button className="primary" type="button" onClick={sendTon} disabled={!supportedChain || sending || !recipient.trim() || !amount.trim()}>{sending ? "Waiting for wallet…" : "Review and send TON →"}</button>
            {sendMessage && <div className={/failed|cancelled|invalid|connect/i.test(sendMessage) ? "feature-error" : "security-note"} role="status">{sendMessage}</div>}
          </div>
          <div className="ton-send-area">
            <div className="panel-head">
              <div><h3>Send Jetton</h3><p className="muted">Use indexed Jetton wallet information and review the transfer in your connected wallet.</p></div>
              <button className="secondary" type="button" onClick={() => void refreshJettons()} disabled={jettonsLoading}>{jettonsLoading ? "Refreshing…" : "Refresh Jettons"}</button>
            </div>
            {jettonsMessage && <div className={jettonsAvailable ? "security-note" : "feature-error"} role="status">{jettonsMessage}</div>}
            {jettons.length > 0 && (
              <>
                <label>Jetton balance<select value={selectedJettonAddress} onChange={event => setSelectedJettonAddress(event.target.value)}>
                  {jettons.map((item, index) => <option key={item.master_address || index} value={item.master_address || ""}>{item.name || item.symbol || "Jetton"}{item.symbol ? " · " + item.symbol : ""} · {item.balance ?? (item.amount_raw + " raw")}</option>)}
                </select></label>
                {selectedJetton && <div className={selectedJetton.is_scam ? "feature-error" : "security-note"}>
                  <b>{selectedJetton.is_scam ? "Potential scam / blacklisted Jetton" : "Jetton master address"}</b>
                  <br /><code>{selectedJetton.master_address}</code>
                  <div>Decimals: {selectedJetton.decimals ?? "Not supplied — sending disabled"}</div>
                  <div>Verification: {selectedJetton.verification || "Unverified"}</div>
                </div>}
                <label>Recipient TON address<input value={jettonRecipient} onChange={event => setJettonRecipient(event.target.value)} placeholder="EQ… / UQ… / raw TON address" autoComplete="off" /></label>
                <label>Amount ({selectedJetton?.symbol || "Jetton"})<input value={jettonAmount} onChange={event => setJettonAmount(event.target.value)} placeholder="0.0" inputMode="decimal" /></label>
                <button className="primary" type="button" onClick={sendJetton} disabled={!supportedChain || jettonSending || !selectedJetton || selectedJetton.decimals == null || !selectedJetton.wallet_address || !jettonRecipient.trim() || !jettonAmount.trim()}>{jettonSending ? "Waiting for wallet…" : "Review and send Jetton →"}</button>
                {selectedJetton?.is_scam && <p className="feature-error">This Jetton is flagged as potentially unsafe. Verify its master contract independently before proceeding.</p>}
                {jettonSendMessage && <div className={/failed|cancelled|invalid|disabled|unavailable/i.test(jettonSendMessage) ? "feature-error" : "security-note"} role="status">{jettonSendMessage}</div>}
              </>
            )}
            {!jettons.length && !jettonsLoading && <p className="muted">No indexed Jetton balances are available for this address. Refresh to check again.</p>}
            <p className="muted">A 0.05 TON fee attachment is sent to the sender Jetton wallet. The final amount and fee must be reviewed in your connected wallet. Missing decimals or a missing sender Jetton wallet address disables this transfer.</p>
          </div>
        </>
      )}
      <div className="security-note">TON Mainnet and TON Testnet use separate saved addresses and separate RPC/indexer endpoints. A connected public address is not marked ownership-verified by this read-only balance feature. Transaction signing remains inside your selected wallet.</div>
    </article>
  );
}
