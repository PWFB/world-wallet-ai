import { useEffect, useRef, useState } from "react";

const money = value => `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = value => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

const networksForAsset = symbol => ({
  BTC: [{ value: "bitcoin", label: "Bitcoin" }],
  ETH: [{ value: "ethereum", label: "Ethereum" }],
  BNB: [{ value: "bnb", label: "BNB Chain" }],
  USDT: [{ value: "ethereum", label: "Ethereum" }, { value: "bnb", label: "BNB Chain" }],
  BALMZ: [{ value: "ethereum", label: "Ethereum" }],
}[symbol] || []);

export default function FeaturePage({ selectedAsset, active, wallet, assets, activity, accessToken, apiBaseUrl, setActive, onTransactionsUpdated, onWalletUpdated }) {
  const [asset, setAsset] = useState(selectedAsset || assets[0]?.symbol || "BALMZ");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [network, setNetwork] = useState(() => networksForAsset(assets[0]?.symbol || "BALMZ")[0]?.value || "ethereum");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [addresses, setAddresses] = useState([]);
  const [addressMessage, setAddressMessage] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [copiedAddress, setCopiedAddress] = useState("");
  const [toolItems, setToolItems] = useState([]);
  const [toolBusy, setToolBusy] = useState(false);
  const requestKeyRef = useRef("");

  useEffect(() => {
    if (selectedAsset && selectedAsset !== asset) setAsset(selectedAsset);
  }, [selectedAsset]);

  useEffect(() => {
    const options = networksForAsset(asset);
    if (options.length && !options.some(item => item.value === network)) setNetwork(options[0].value);
  }, [asset]);

  useEffect(() => {
    if (active !== "Receive") return;
    let cancelled = false;
    fetch(apiBaseUrl + "/api/v1/wallet/addresses", { headers: { Authorization: "Bearer " + accessToken } })
      .then(async r => ({ ok: r.ok, data: await r.json() }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        setAddresses(ok ? (data.addresses || []) : []);
        setAddressMessage(ok ? (data.message || "") : (data.detail || "Unable to load wallet addresses."));
      })
      .catch(() => { if (!cancelled) { setAddresses([]); setAddressMessage("Unable to load wallet addresses."); } });
    return () => { cancelled = true; };
  }, [active, apiBaseUrl, accessToken]);
  const selectedWalletAsset = assets.find(item => item.symbol === asset) || null;
  const selectedAssetAvailable = Math.max(0, Number(
    selectedWalletAsset?.available_balance ??
    selectedWalletAsset?.available ??
    selectedWalletAsset?.balance ??
    0
  ));
  const parsedAmountForGuard = Number(amount);
  const amountExceedsAvailable = Number.isFinite(parsedAmountForGuard) && parsedAmountForGuard > selectedAssetAvailable;
  const amountInvalid = amount !== "" && (!Number.isFinite(parsedAmountForGuard) || parsedAmountForGuard <= 0);

  function useMaxAvailable() {
    if (!selectedWalletAsset || selectedAssetAvailable <= 0) {
      setMessage("No available balance is currently available for this asset.");
      return;
    }
    setAmount(String(selectedAssetAvailable));
    setMessage("");
  }

  function decimalToUnits(value, decimals) {
    const raw = String(value).trim();
    if (!/^\\d+(\\.\\d+)?$/.test(raw)) throw new Error("Invalid amount.");
    const [whole, fraction = ""] = raw.split(".");
    if (fraction.length > decimals) throw new Error("Amount has too many decimal places for this asset.");
    return BigInt(whole + fraction.padEnd(decimals, "0"));
  }

  async function broadcastExternalBitcoin({ transactionId, amount, destination }) {
    if (!window.unisat) throw new Error("No compatible Bitcoin external wallet is available. Install or open a wallet that exposes the UniSat provider.");
    const configResponse = await fetch(apiBaseUrl + "/api/v1/wallet/signing-config", { headers: { Authorization: "Bearer " + accessToken } });
    const config = await configResponse.json();
    if (!configResponse.ok || !config.bitcoin?.wallet_address) throw new Error("Production Bitcoin signing is not configured.");
    const accounts = await window.unisat.requestAccounts();
    const signer = accounts?.[0];
    if (!signer || signer.toLowerCase() !== config.bitcoin.wallet_address.toLowerCase()) {
      throw new Error("Connect the configured production Bitcoin wallet address before signing this transaction.");
    }
    if (window.unisat.switchNetwork) await window.unisat.switchNetwork("livenet");
    const satoshis = Number(decimalToUnits(amount, 8));
    if (!Number.isSafeInteger(satoshis) || satoshis <= 0) throw new Error("Bitcoin amount is outside the external wallet's safe signing range.");
    const txHash = await window.unisat.sendBitcoin(destination, satoshis);
    if (!txHash) throw new Error("External Bitcoin wallet did not return a transaction hash.");
    const settleResponse = await fetch(apiBaseUrl + "/api/v1/transactions/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ transaction_id: transactionId, tx_hash: txHash }),
    });
    const settleData = await settleResponse.json();
    if (!settleResponse.ok) throw new Error(settleData.detail || "Bitcoin broadcast verification failed.");
    return settleData;
  }

  async function broadcastExternalEvm({ transactionId, endpoint, asset, amount, network, destination }) {
    if (!window.ethereum) throw new Error("No compatible external EVM wallet is available. Connect a browser wallet that supports EVM signing.");
    const configResponse = await fetch(apiBaseUrl + "/api/v1/wallet/signing-config", { headers: { Authorization: "Bearer " + accessToken } });
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.detail || "External wallet signing is not configured.");
    const networkConfig = config.networks?.[network];
    if (!networkConfig?.wallet_address) throw new Error("Production " + network + " signing address is not configured.");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const signer = accounts?.[0];
    if (!signer || signer.toLowerCase() !== networkConfig.wallet_address.toLowerCase()) {
      throw new Error("Connect the configured production wallet address before signing this transaction.");
    }
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId.toLowerCase() !== networkConfig.chain_id.toLowerCase()) {
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: networkConfig.chain_id }] });
      } catch (error) {
        if (Number(error?.code) === 4001) throw error;
        throw new Error("Switch the external wallet to the " + (network === "ethereum" ? "Ethereum" : "BNB Chain") + " mainnet.");
      }
    }

    const tx = { from: signer, to: destination };
    if (asset === "ETH" || asset === "BNB") {
      tx.value = "0x" + decimalToUnits(amount, 18).toString(16);
    } else if (asset === "USDT") {
      if (!networkConfig.usdt_contract || !networkConfig.usdt_decimals) throw new Error("USDT external signing is not configured for this network.");
      const decimals = Number(networkConfig.usdt_decimals);
      const units = decimalToUnits(amount, decimals);
      const cleanDestination = destination.replace(/^0x/, "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(cleanDestination)) throw new Error("Invalid EVM destination address.");
      tx.to = networkConfig.usdt_contract;
      tx.data = "0xa9059cbb" + cleanDestination.padStart(64, "0") + units.toString(16).padStart(64, "0");
      tx.value = "0x0";
    } else {
      throw new Error("This asset is not available for live external EVM broadcast yet.");
    }

    const txHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [tx] });
    if (!txHash) throw new Error("External wallet did not return a transaction hash.");

    const settleResponse = await fetch(apiBaseUrl + "/api/v1/transactions/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ transaction_id: transactionId, tx_hash: txHash }),
    });
    const settleData = await settleResponse.json();
    if (!settleResponse.ok) throw new Error(settleData.detail || "Broadcast was sent but verification failed.");
    return settleData;
  }

  function isUserRejectedError(error) {
    return Number(error?.code) === 4001 || /user rejected|user denied|rejected the request|denied the request/i.test(String(error?.message || ""));
  }

  async function cancelUnbroadcastTransaction(transactionId) {
    if (!transactionId) return false;
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/transactions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
        body: JSON.stringify({ transaction_id: transactionId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function submit(endpoint) {
    setBusy(true); setMessage("");
    let transactionId = "";
    try {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) throw new Error("Enter an amount greater than zero.");
      if (!destination.trim()) throw new Error("Enter a destination address.");
      const selectedAsset = assets.find(item => item.symbol === asset);
      if (!selectedAsset) throw new Error("Select a supported wallet asset.");
      const availableBalance = Math.max(0, Number(selectedAsset.available_balance ?? selectedAsset.available ?? selectedAsset.balance ?? 0));
      if (parsedAmount > availableBalance) throw new Error(`Amount exceeds the available ${asset} balance of ${number(availableBalance)}.`);

      const isLiveEvm = (network === "ethereum" || network === "bnb") && ["ETH", "BNB", "USDT"].includes(asset);
      const isLiveBitcoin = network === "bitcoin" && asset === "BTC";
      if (isLiveEvm && !window.ethereum) throw new Error("Connect a compatible external EVM wallet to send live funds. No transaction will be recorded without a signer.");
      if (isLiveBitcoin && !window.unisat) throw new Error("Connect a compatible external Bitcoin wallet to send live BTC. No transaction will be recorded without a signer.");

      const requestKey = requestKeyRef.current || crypto.randomUUID();
      requestKeyRef.current = requestKey;
      const body = { idempotency_key: requestKey, asset, amount: parsedAmount, network, note: note || null };
      body[endpoint.includes("transfers") ? "recipient" : "destination"] = destination;
      const r = await fetch(apiBaseUrl + endpoint, { method:"POST", headers:{"Content-Type":"application/json", Authorization:"Bearer "+accessToken}, body:JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok || data.status === "rejected") throw new Error(data.detail || data.reason || "Request failed");

      transactionId = data.transfer?.id || data.withdrawal?.id;
      if (isLiveEvm && transactionId) {
        const settlement = await broadcastExternalEvm({ transactionId, endpoint, asset, amount: parsedAmount, network, destination: destination.trim() });
        setMessage(settlement.status === "broadcast_pending" ? "Live transaction broadcast. Waiting for blockchain confirmation." : "Live transaction verified and wallet accounting reconciled.");
      } else if (isLiveBitcoin && transactionId) {
        const settlement = await broadcastExternalBitcoin({ transactionId, amount: parsedAmount, destination: destination.trim() });
        setMessage(settlement.status === "broadcast_pending" ? "Live Bitcoin transaction broadcast. Waiting for confirmation." : "Live Bitcoin transaction verified and wallet accounting reconciled.");
      } else {
        setMessage("Request accepted: " + data.status.replace("_"," "));
      }
      setAmount(""); setDestination(""); setNote(""); requestKeyRef.current = "";
      if (onTransactionsUpdated) {
        const refresh = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", { method:"POST", headers:{ Authorization:"Bearer "+accessToken } });
        const refreshed = await refresh.json();
        if (refresh.ok) {
          onTransactionsUpdated(refreshed.transactions || []);
          onWalletUpdated?.({ wallet: refreshed.wallet, assets: refreshed.assets || [] });
        } else {
          const transactionResponse = await fetch(apiBaseUrl + "/api/v1/transactions", { headers: { Authorization:"Bearer "+accessToken } });
          if (transactionResponse.ok) {
            const transactionData = await transactionResponse.json();
            onTransactionsUpdated(transactionData.transactions || []);
          }
        }
      }
    } catch (e) {
      const rejected = isUserRejectedError(e);
      if (rejected && transactionId) {
        const cancelled = await cancelUnbroadcastTransaction(transactionId);
        requestKeyRef.current = "";
        setMessage(cancelled
          ? "External wallet signing was cancelled. The pending reservation was released; no blockchain transaction was broadcast."
          : "External wallet signing was cancelled. The request could not be auto-cancelled; verify the pending request before retrying.");
      } else {
        setMessage(e.message || "Transaction request failed.");
      }
    } finally { setBusy(false); }
  }


  if (active === "Wallets") {
    const [wallets, setWallets] = useState([]);
    const [walletName, setWalletName] = useState("");
    const [walletId, setWalletId] = useState("");
    const [walletAddresses, setWalletAddresses] = useState([]);
    const [walletBusy, setWalletBusy] = useState(false);
    const [walletMessage, setWalletMessage] = useState("");

    const loadWallets = async () => {
      setWalletBusy(true);
      setWalletMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets", { headers: { Authorization: "Bearer " + accessToken } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to load wallets.");
        setWallets(data.wallets || []);
        const activeId = data.active_wallet_id || data.wallets?.find(w => w.active)?.id || "";
        setWalletId(activeId);
        if (activeId) {
          const addressResponse = await fetch(apiBaseUrl + "/api/v1/wallets/" + activeId + "/addresses", { headers: { Authorization: "Bearer " + accessToken } });
          const addressData = await addressResponse.json();
          setWalletAddresses(addressResponse.ok ? (addressData.addresses || []) : []);
        }
      } catch (error) {
        setWalletMessage(error.message || "Unable to load wallets.");
      } finally {
        setWalletBusy(false);
      }
    };

    useEffect(() => { loadWallets(); }, [accessToken]);

    const refreshActiveWallet = async () => {
      const response = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", { method: "POST", headers: { Authorization: "Bearer " + accessToken } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Wallet refresh failed.");
      onWalletUpdated?.({ wallet: data.wallet, assets: data.assets || [] });
      onTransactionsUpdated?.(data.transactions || []);
    };

    const createWallet = async () => {
      const name = walletName.trim();
      if (!name) { setWalletMessage("Enter a wallet name."); return; }
      setWalletBusy(true);
      setWalletMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ name }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to create wallet.");
        setWalletName("");
        setWalletMessage("Wallet profile created. Add its public blockchain addresses below.");
        await loadWallets();
        await refreshActiveWallet();
      } catch (error) {
        setWalletMessage(error.message || "Unable to create wallet.");
      } finally {
        setWalletBusy(false);
      }
    };

    const switchWallet = async id => {
      setWalletBusy(true);
      setWalletMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets/active", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ wallet_id: id }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to switch wallet.");
        setWalletId(id);
        await refreshActiveWallet();
        await loadWallets();
        setWalletMessage("Wallet switched. Live balances now belong to the selected wallet.");
      } catch (error) {
        setWalletMessage(error.message || "Unable to switch wallet.");
      } finally {
        setWalletBusy(false);
      }
    };

    const loadAddresses = async id => {
      if (!id) return;
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + id + "/addresses", { headers: { Authorization: "Bearer " + accessToken } });
        const data = await response.json();
        setWalletAddresses(response.ok ? (data.addresses || []) : []);
      } catch { setWalletAddresses([]); }
    };

    const addAddress = async () => {
      const networkValue = network;
      const addressValue = destination.trim();
      if (!addressValue) { setWalletMessage("Enter a public wallet address."); return; }
      if (!walletId) { setWalletMessage("Select a wallet first."); return; }
      setWalletBusy(true);
      setWalletMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + walletId + "/addresses", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ network: networkValue, address: addressValue, label: note.trim() || "primary" }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Unable to connect address.");
        setDestination("");
        setNote("");
        await loadAddresses(walletId);
        await refreshActiveWallet();
        setWalletMessage("Address connected. Compatible wallet coins will use this network automatically.");
      } catch (error) {
        setWalletMessage(error.message || "Unable to connect address.");
      } finally {
        setWalletBusy(false);
      }
    };

    const selectedWallet = wallets.find(w => w.id === walletId);

    return <section className="content feature-content">
      <div className="page-heading">
        <div><p className="eyebrow">WALLET MANAGEMENT</p><h1>Wallets</h1><p className="muted">Create wallet profiles, connect public addresses, and switch the active wallet.</p></div>
        <button className="secondary" onClick={loadWallets} disabled={walletBusy}>{walletBusy ? "Working…" : "↻ Refresh"}</button>
      </div>
      {walletMessage && <div className={/unable|invalid|failed|enter|select/i.test(walletMessage) ? "feature-error" : "feature-success"}>{walletMessage}</div>}
      <div className="feature-grid">
        <article className="panel action-panel">
          <p className="feature-kicker">CREATE WALLET PROFILE</p>
          <h2>New wallet</h2>
          <p className="muted">This creates a wallet record only. World Wallet AI does not generate or store a private key on the server.</p>
          <label>Wallet name<input value={walletName} onChange={e => setWalletName(e.target.value)} placeholder="Personal Wallet" maxLength="80"/></label>
          <button className="primary feature-submit" disabled={walletBusy || !walletName.trim()} onClick={createWallet}>{walletBusy ? "Creating…" : "Create wallet →"}</button>
          <div className="security-note">For a non-custodial wallet, create/import the signing account in a compatible wallet app and connect only its public address here.</div>
        </article>
        <article className="panel action-panel">
          <p className="feature-kicker">ACTIVE WALLET</p>
          <h2>{selectedWallet?.name || "No wallet selected"}</h2>
          <select value={walletId} onChange={e => switchWallet(e.target.value)} disabled={walletBusy || !wallets.length}>
            {wallets.length ? wallets.map(w => <option key={w.id} value={w.id}>{w.name}{w.active ? " • Active" : ""}</option>) : <option value="">No wallets</option>}
          </select>
          <div className="tool-list">
            {walletAddresses.length ? walletAddresses.map(a => <div className="tool-row" key={a.network + a.address}><div><b>{a.network.toUpperCase()}</b><small>{a.label}</small></div><code>{a.address}</code><button className="secondary" onClick={() => navigator.clipboard?.writeText(a.address)}>Copy</button></div>) : <div className="live-chart-empty">No public network addresses connected to this wallet.</div>}
          </div>
        </article>
      </div>
      <article className="panel action-panel">
        <p className="feature-kicker">CONNECT PUBLIC ADDRESS</p>
        <h2>Attach a blockchain address</h2>
        <div className="feature-grid">
          <label>Network<select value={network} onChange={e => setNetwork(e.target.value)}><option value="ethereum">Ethereum</option><option value="bnb">BNB Chain</option><option value="bitcoin">Bitcoin</option></select></label>
          <label>Public address<input value={destination} onChange={e => setDestination(e.target.value)} placeholder={network === "bitcoin" ? "bc1… or 1… / 3…" : "0x…"}/></label>
        </div>
        <label>Label<input value={note} onChange={e => setNote(e.target.value)} placeholder="primary"/></label>
        <button className="primary feature-submit" disabled={walletBusy || !walletId || !destination.trim()} onClick={addAddress}>{walletBusy ? "Connecting…" : "Connect address →"}</button>
        <div className="security-note">One Ethereum address can hold ETH plus many ERC-20 tokens. The token contract, when deployed, identifies the token; the wallet address does not need a separate address for every ERC-20 token.</div>
        <div className="security-note">BALMZ is currently shown as contract-pending. Do not enter a made-up BALMZ contract address. Once the real contract is deployed, it can be registered and its on-chain metadata and balance can be read.</div>
      </article>
    </section>;
  }

  if (active === "Send" || active === "Withdraw") {
    const send = active === "Send";
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">WALLET ACTION</p><h1>{active}</h1><p className="muted">{send ? "Send assets to an external wallet." : "Request a secure withdrawal."}</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid"><article className="panel action-panel">
        <div className="feature-icon">{send ? "↗" : "⇥"}</div><h2>{send ? "Send funds" : "Direct withdrawal"}</h2>
        <label>Asset<select value={asset} onChange={e=>{setAsset(e.target.value);setAmount("");setMessage("");}}>{assets.map(a=>{const available=Math.max(0,Number(a.available_balance ?? a.available ?? a.balance ?? 0));return <option key={a.symbol} value={a.symbol}>{a.symbol} • {number(available)} available</option>;})}</select></label>
        <div className="amount-field">
          <div className="amount-label-row"><span>Amount</span><button type="button" className="amount-max" onClick={useMaxAvailable} disabled={selectedAssetAvailable <= 0 || busy}>MAX</button></div>
          <input type="number" min="0" max={selectedAssetAvailable > 0 ? selectedAssetAvailable : undefined} step="any" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00" aria-invalid={amountExceedsAvailable || amountInvalid}/>
          <div className={amountExceedsAvailable || amountInvalid ? "amount-availability amount-error" : "amount-availability"}>
            <span>Available: {number(selectedAssetAvailable)} {asset}</span>
            {amountExceedsAvailable ? <b>Amount exceeds available balance.</b> : amountInvalid ? <b>Enter a valid amount greater than zero.</b> : null}
          </div>
        </div>
        <label>{send ? "Recipient" : "Destination"}<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="Wallet address"/></label>
        <label>Network<select value={network} onChange={e=>setNetwork(e.target.value)} disabled={!networksForAsset(asset).length}>{networksForAsset(asset).length ? networksForAsset(asset).map(item=><option key={item.value} value={item.value}>{item.label}</option>) : <option value="">No supported network</option>}</select></label>
        <div className="network-safety"><b>{asset}</b><span>{networksForAsset(asset).length ? `Compatible: ${networksForAsset(asset).map(n => n.label).join(" / ")}` : "This asset is catalog-only and cannot be sent on-chain yet."}</span></div>
        <label>Note<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength="200" placeholder="Optional note"/></label>
        {message && <div className={message.startsWith("Request accepted") ? "feature-success":"feature-error"}>{message}</div>}
        <button className="primary feature-submit" disabled={busy || !amount || amountInvalid || amountExceedsAvailable || selectedAssetAvailable <= 0 || !destination || !assets.some(item => item.symbol === asset) || !networksForAsset(asset).length || !network} onClick={()=>submit(send?"/api/v1/transfers":"/api/v1/withdrawals")}>{busy ? "Submitting…" : send ? "Review & send →" : "Request withdrawal →"}</button>
      </article><aside className="panel feature-summary"><span className="feature-kicker">AVAILABLE BALANCE</span><strong>{money(wallet.available_balance_usd)}</strong><small>Wallet funds available</small><div className="summary-divider"/><span>Selected asset</span><b>{asset}</b><div className="security-note">✓ Live EVM mode: your connected external wallet signs and broadcasts the transaction. World Wallet AI never receives or stores your private key.</div>
          <div className="security-note">✓ Bitcoin live mode uses a connected external Bitcoin signer when available; no private key is stored by World Wallet AI.</div></aside></div>
    </section>;
  }

  if (active === "Receive") {
    return <section className="content feature-content">
      <div className="page-heading"><div><p className="eyebrow">WALLET ACTION</p><h1>Receive</h1><p className="muted">Use a configured production blockchain address to receive assets.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid">
        <article className="panel receive-panel">
          <p className="feature-kicker">PRODUCTION DEPOSIT ADDRESSES</p>
          <div className="receive-selected">
            <span>Receiving asset</span><strong>{asset}</strong><small>Choose the network below only when it matches the sender's network.</small>
          </div>
          {addresses.length ? addresses.filter(item => !networksForAsset(asset).length || networksForAsset(asset).some(n => n.value === item.network)).map(item => <div className="receive-address" key={item.network}>
            <div><b>{item.network.toUpperCase()}</b><small>{item.label} • {asset}</small></div><code>{item.address}</code><button className="secondary" onClick={async ()=>{try{await navigator.clipboard?.writeText(item.address);setCopiedAddress(item.address);setTimeout(()=>setCopiedAddress(""),1800)}catch{setAddressMessage("Copy is unavailable on this device.")}}}>{copiedAddress===item.address?"Copied":"Copy"}</button>
          </div>) : <div className="live-chart-empty">{addressMessage || `No production ${asset} address configured for a compatible network.`}</div>}
        </article>
        <article className="panel feature-summary">
          <span className="feature-kicker">RECEIVE SAFETY</span>
          <div className="receive-asset"><span className="asset-icon">{asset === "BTC" ? "₿" : asset === "ETH" ? "Ξ" : asset === "BNB" ? "◆" : asset === "USDT" ? "$" : "B"}</span><div><b>{asset}</b><small>{networksForAsset(asset).map(n => n.label).join(" / ") || "Network integration not configured"}</small></div></div>
          <div className="security-note">✓ Only use an address on the selected asset's compatible network. Sending an asset on the wrong network can permanently lose funds.</div>
          <div className="security-note">✓ Addresses are read-only for receiving. No private key is stored by this API.</div>
        </article>
      </div>
    </section>;
  }

  if (active === "Transactions") {
    async function settleTransaction(transaction) {
      const txHash = window.prompt("Enter the real blockchain transaction hash for this request:");
      if (!txHash) return;
      setSyncBusy(true);
      setSyncMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/transactions/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
          body: JSON.stringify({ transaction_id: transaction.id, tx_hash: txHash.trim() }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Settlement verification failed.");
        const refreshed = await fetch(apiBaseUrl + "/api/v1/wallet/refresh", {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
        });
        const refreshedData = await refreshed.json();
        if (refreshed.ok) {
          onTransactionsUpdated?.(refreshedData.transactions || []);
          onWalletUpdated?.({ wallet: refreshedData.wallet, assets: refreshedData.assets || [] });
        }
        setSyncMessage(data.status === "broadcast_pending"
          ? "Broadcast recorded. Waiting for blockchain confirmation."
          : "Blockchain settlement verified and wallet accounting reconciled.");
      } catch (error) {
        setSyncMessage(error.message || "Settlement verification failed.");
      } finally {
        setSyncBusy(false);
      }
    }

    async function syncTransactions() {
      setSyncBusy(true);
      setSyncMessage("");
      try {
        const response = await fetch(apiBaseUrl + "/api/v1/transactions/sync", {
          method: "POST",
          headers: { Authorization: "Bearer " + accessToken },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "live transaction sync failed.");
        onTransactionsUpdated?.(data.transactions || []);
        onWalletUpdated?.({ wallet: data.wallet, assets: data.assets || [] });
        setSyncMessage(data.warnings?.length ? data.warnings.join(" • ") : (data.imported?.length ? `Synced ${data.imported.length} live transaction(s).` : "No new live wallet transactions found."));
      } catch (error) {
        setSyncMessage(error.message || "live transaction sync failed.");
      } finally {
        setSyncBusy(false);
      }
    }

    return <section className="content feature-content">
      <div className="page-heading">
        <div><p className="eyebrow">WALLET HISTORY</p><h1>Transactions</h1><p className="muted">Track wallet activity with blockchain transaction details when available.</p></div>
        <div className="page-actions"><button className="secondary" onClick={syncTransactions} disabled={syncBusy}>{syncBusy ? "Syncing live wallet…" : "↻ Sync live wallet"}</button><button className="primary" onClick={()=>setActive("Send")}>+ Send funds</button></div>
      </div>
      {syncMessage && <div className={syncMessage.includes("failed") ? "feature-error" : "feature-success"}>{syncMessage}</div>}
      <article className="panel transaction-panel">
        <div className="transaction-filter-bar"><span>Recorded wallet activity</span><small>{activity.length} transaction{activity.length===1?"":"s"}</small></div>
        {activity.length ? activity.map((a,i) => <div className="transaction-row transaction-chain-row" key={a.tx_hash || a.id || i}>
          <span className="activity-icon">{a.type[0].toUpperCase()}</span>
          <div className="transaction-main"><b>{a.type}</b><small>{a.description}</small>{a.tx_hash && <code title={a.tx_hash}>{a.tx_hash}</code>}</div>
          <strong className={Number(a.raw_amount) >= 0 ? "positive" : "negative"}>{a.amount}</strong>
          <div className="transaction-meta">
            <span className={a.status === "confirmed" ? "positive" : a.status === "failed" || a.status === "reorged" ? "negative" : "neutral"}>{a.status || "recorded"}{a.confirmations ? ` • ${a.confirmations} confirmations` : ""}</span>
            {a.block_height ? <small>Block {a.block_height}</small> : null}
            {a.tx_hash && a.network === "bitcoin" ? <a href={`https://blockstream.info/tx/${a.tx_hash}`} target="_blank" rel="noreferrer">View on Blockstream ↗</a> : null}
            {a.status === "reorged" ? <small className="negative">Chain reorganization detected — waiting for a replacement confirmation.</small> : null}
            {a.status === "failed" ? <small className="negative">On-chain execution failed. This record is not a confirmed transfer.</small> : null}
            {["pending","pending_review","broadcast_pending"].includes(a.status) && a.id ? <button className="secondary" onClick={()=>settleTransaction(a)} disabled={syncBusy}>{a.status === "broadcast_pending" ? "Verify confirmation" : "Verify settlement"}</button> : null}
            <small>{a.time}</small>
          </div>
        </div>) : <div className="live-chart-empty">No real wallet transactions recorded yet.</div>}
      </article>
    </section>;
  }

  if (active === "Portfolio" || active === "Staking" || active === "NFTs") return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">ASSET MANAGEMENT</p><h1>{active}</h1><p className="muted">Manage your digital assets.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><div className="balance-grid feature-balance"><article className="hero-card"><div className="card-top"><span>AVAILABLE BALANCE</span></div><div className="hero-balance">{money(wallet.available_balance_usd)} <small>USD</small></div></article><article className="stat-card"><span>Portfolio profit</span><strong>{money(wallet.profit_usd)}</strong><b className="positive">{Number(wallet.change_24h || 0).toFixed(2)}%</b></article></div><article className="panel assets-panel"><div className="panel-head"><div><h2>{active} assets</h2><span>Current wallet holdings</span></div></div><div className="asset-list">{assets.map(a=><div className="asset-row" key={a.symbol}><span className="asset-icon">{a.icon}</span><div className="asset-name"><b>{a.symbol}</b><small>{a.name}</small></div><div className="asset-balance"><b>{number(a.balance)}</b><small>{money(a.value_usd)}</small></div><b className={Number(a.change_24h)>=0?"positive":"negative"}>{Number(a.change_24h)>=0?"+":""}{Number(a.change_24h||0).toFixed(2)}%</b></div>)}</div></article></section>;

  if (active === "Verify Contract") {
    const verify=async()=>{setToolBusy(true);setMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/contracts/verify",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({address:destination,network})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Contract check failed.");setMessage(d.contract?"Contract bytecode detected.":"No contract bytecode detected.");}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Verify Contract</h1><p className="muted">Check deployed bytecode on Ethereum or BNB Chain.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><article className="panel action-panel"><label>Network<select value={network} onChange={e=>setNetwork(e.target.value)}><option value="ethereum">Ethereum</option><option value="bnb">BNB Chain</option></select></label><label>Contract address<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="0x…"/></label>{message&&<div className={message.includes("detected")?"feature-success":"feature-error"}>{message}</div>}<button className="primary feature-submit" disabled={toolBusy||destination.length!==42} onClick={verify}>{toolBusy?"Checking…":"Check contract →"}</button><div className="security-note">This checks deployed bytecode only. It does not certify source code, ownership, or contract safety.</div></article></section>;
  }

  if (active === "Address Book") {
    const loadBook=async()=>{setToolBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/address-book",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to load address book.");setToolItems(d.entries||[]);}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    const addBook=async()=>{setToolBusy(true);setMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/address-book",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({label:note,address:destination,network,notes:""})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to save address.");setDestination("");setNote("");setMessage("Address saved.");await loadBook();}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    const removeBook=async id=>{setToolBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/address-book/delete",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({id})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to remove address.");setMessage("Address removed.");await loadBook();}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Address Book</h1><p className="muted">Save trusted destination addresses for this wallet.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid"><article className="panel action-panel"><h2>Add address</h2><label>Network<select value={network} onChange={e=>setNetwork(e.target.value)}><option value="ethereum">Ethereum</option><option value="bnb">BNB Chain</option><option value="bitcoin">Bitcoin</option></select></label><label>Address<input value={destination} onChange={e=>setDestination(e.target.value)} placeholder="Wallet address"/></label><label>Label<input value={note} onChange={e=>setNote(e.target.value)} placeholder="My exchange"/></label>{message&&<div className="feature-success">{message}</div>}<button className="primary feature-submit" disabled={toolBusy||!destination.trim()||!note.trim()} onClick={addBook}>{toolBusy?"Saving…":"Save address →"}</button></article>
      <article className="panel tool-panel"><div className="panel-head"><div><h2>Saved addresses</h2><span>Private to this wallet</span></div><button className="secondary" onClick={loadBook}>↻ Refresh</button></div>{toolItems.length?toolItems.map(a=><div className="tool-row" key={a.id}><div><b>{a.label}</b><small>{a.network}</small></div><code>{a.address}</code><button className="secondary" onClick={()=>removeBook(a.id)}>Remove</button></div>):<div className="live-chart-empty">No saved addresses loaded.</div>}</article></div></section>;
  }

  if (active === "Request Center") {
    const loadRequests=async()=>{setToolBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/request-center",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to load requests.");setToolItems(d.requests||[]);}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    const createRequest=async()=>{setToolBusy(true);setMessage("");try{const r=await fetch(apiBaseUrl+"/api/v1/request-center",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+accessToken},body:JSON.stringify({kind:"support",title:destination,details:note})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Unable to create request.");setDestination("");setNote("");setMessage("Request created.");await loadRequests();}catch(e){setMessage(e.message);}finally{setToolBusy(false);}};
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Request Center</h1><p className="muted">Create and track database-backed support requests.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <div className="feature-grid"><article className="panel action-panel"><h2>New request</h2><label>Title<input value={destination} onChange={e=>setDestination(e.target.value)} maxLength="120" placeholder="Request title"/></label><label>Details<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength="1000" placeholder="Describe what you need"/></label>{message&&<div className="feature-success">{message}</div>}<button className="primary feature-submit" disabled={toolBusy||!destination.trim()} onClick={createRequest}>{toolBusy?"Saving…":"Create request →"}</button></article>
      <article className="panel tool-panel"><div className="panel-head"><div><h2>My requests</h2><span>Real records for this wallet</span></div><button className="secondary" onClick={loadRequests}>{toolBusy?"Loading…":"↻ Refresh"}</button></div>{toolItems.length?toolItems.map(r=><div className="tool-row" key={r.id}><div><b>{r.title}</b><small>{r.kind} • {r.status}</small></div><code>{r.id}</code></div>):<div className="live-chart-empty">No requests loaded. Tap Refresh.</div>}</article></div></section>;
  }

  if (active === "Wallet Connect") {
    return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">TOOLS</p><h1>Wallet Connect</h1><p className="muted">Inspect configured production wallet addresses.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div>
      <article className="panel tool-panel"><div className="tool-status"><span className="status-dot"></span><b>Read-only connection</b></div>
      <p className="muted">This view never creates a signing session or stores private keys.</p>
      <button className="secondary" onClick={async()=>{setSyncBusy(true);try{const r=await fetch(apiBaseUrl+"/api/v1/wallet/connect",{headers:{Authorization:"Bearer "+accessToken}});const d=await r.json();setAddresses(d.addresses||[]);setAddressMessage(d.message||"");}catch{setAddressMessage("Unable to load connection status.");}finally{setSyncBusy(false)}}}>{syncBusy?"Checking…":"Check connection"}</button>
      {addresses.length?addresses.map(a=><div className="tool-row" key={a.network+a.address}><div><b>{a.network.toUpperCase()}</b><small>{a.label}</small></div><code>{a.address}</code><button className="secondary" onClick={()=>navigator.clipboard?.writeText(a.address)}>Copy</button></div>):<div className="live-chart-empty">{addressMessage||"No configured production address."}</div>}</article>
    </section>;
  }

  return <section className="content feature-content"><div className="page-heading"><div><p className="eyebrow">WORLD WALLET AI</p><h1>{active}</h1><p className="muted">Production tool workflows are being connected to live wallet data.</p></div><button className="secondary" onClick={()=>setActive("Dashboard")}>← Dashboard</button></div><article className="panel placeholder-panel"><div className="feature-icon">✦</div><h2>{active}</h2><p>This module is connected to the main navigation and ready for its dedicated backend workflow.</p></article></section>;
}
