import { useCallback, useEffect, useMemo, useState } from "react";
import "./DashboardWalletPanel.css";

const money = value => "$" + Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = value => Number.isFinite(Number(value)) ? Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 8 }) : "0";
const txAmount = item => {
  const raw = item?.raw_amount;
  if (raw !== undefined && raw !== null && Number.isFinite(Number(raw))) return Number(raw);
  const parsed = String(item?.amount ?? "0").replace(/[^0-9.+-]/g, "");
  return Number(parsed) || 0;
};

export default function DashboardWalletPanel({ accessToken, apiBaseUrl, assets = [], activity = [], marketPrices = {}, tokenRegistry = [], onWalletSwitched, setActive }) {
  const [wallets, setWallets] = useState([]);
  const [activeWalletId, setActiveWalletId] = useState("");
  const [addresses, setAddresses] = useState([]);
  const [selectedAddressKey, setSelectedAddressKey] = useState("");
  const [network, setNetwork] = useState("ethereum");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("Receive address");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const authHeaders = useMemo(() => ({ Authorization: "Bearer " + accessToken }), [accessToken]);

  const loadWalletsAndAddresses = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      const [walletResponse, addressResponse] = await Promise.all([
        fetch(apiBaseUrl + "/api/v1/wallets", { headers: authHeaders }),
        fetch(apiBaseUrl + "/api/v1/wallet/connect", { headers: authHeaders }),
      ]);
      const walletData = await walletResponse.json().catch(() => ({}));
      const addressData = await addressResponse.json().catch(() => ({}));
      if (!walletResponse.ok) throw new Error(walletData.detail || "Unable to load wallet profiles.");
      if (!addressResponse.ok) throw new Error(addressData.detail || "Unable to load receive addresses.");
      const nextWallets = walletData.wallets || [];
      const nextAddresses = addressData.addresses || [];
      setWallets(nextWallets);
      setActiveWalletId(walletData.active_wallet_id || nextWallets.find(item => item.active)?.id || "");
      setAddresses(nextAddresses);
      setSelectedAddressKey(current => {
        const existing = nextAddresses.find(item => (item.network + ":" + item.address) === current);
        const chosen = existing || nextAddresses[0];
        return chosen ? chosen.network + ":" + chosen.address : "";
      });
    } catch (err) {
      setError(err.message || "Wallet data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [accessToken, apiBaseUrl, authHeaders]);

  useEffect(() => { loadWalletsAndAddresses(); }, [loadWalletsAndAddresses]);

  const selectedAddress = addresses.find(item => item.network + ":" + item.address === selectedAddressKey) || addresses[0] || null;
  const balmzAsset = assets.find(item => String(item.symbol).toUpperCase() === "BALMZ");
  const balmzBalance = Number(balmzAsset?.available_balance ?? balmzAsset?.balance ?? 0);
  const balmzActual = Number(balmzAsset?.actual_balance ?? balmzBalance);
  const balmzReserved = Number(balmzAsset?.reserved_balance ?? Math.max(0, balmzActual - balmzBalance));
  const balmzPrice = Number(balmzAsset?.price_usd || marketPrices.BALMZ?.usd || 0);
  const balmzPending = activity.filter(item => String(item.symbol || item.asset || "").toUpperCase() === "BALMZ" && ["pending", "pending_review", "broadcast_pending"].includes(String(item.status || "").toLowerCase()));
  const pendingAmount = balmzPending.reduce((total, item) => total + Math.abs(txAmount(item)), 0);
  const totalReceived = activity.filter(item => String(item.symbol || item.asset || "").toUpperCase() === "BALMZ" && (String(item.type).toLowerCase() === "received" || txAmount(item) > 0) && !["pending", "pending_review", "broadcast_pending", "failed", "reorged"].includes(String(item.status || "").toLowerCase())).reduce((total, item) => total + Math.abs(txAmount(item)), 0);
  const totalSent = activity.filter(item => String(item.symbol || item.asset || "").toUpperCase() === "BALMZ" && (["sent", "withdrawal"].includes(String(item.type).toLowerCase()) || txAmount(item) < 0) && !["pending", "pending_review", "broadcast_pending", "failed", "reorged"].includes(String(item.status || "").toLowerCase())).reduce((total, item) => total + Math.abs(Number(item.raw_amount ?? item.amount ?? 0)), 0);
  const balmzRegistry = tokenRegistry.find(item => String(item.symbol).toUpperCase() === "BALMZ" && String(item.network).toLowerCase() === "ethereum");
  const contractPending = !balmzRegistry?.contract_address || balmzRegistry?.status === "pending_contract";

  async function switchWallet(nextId) {
    if (!nextId || nextId === activeWalletId) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/active", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ wallet_id: nextId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Wallet switch failed.");
      setActiveWalletId(nextId);
      setNotice("Active wallet switched. Refreshing balances and transaction history…");
      await loadWalletsAndAddresses();
      if (onWalletSwitched) await onWalletSwitched();
    } catch (err) {
      setError(err.message || "Wallet switch failed.");
    } finally {
      setSaving(false);
    }
  }

  async function attachAddress(event) {
    event.preventDefault();
    if (!activeWalletId) { setError("No active wallet profile was found. Open Wallets to create one first."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/" + encodeURIComponent(activeWalletId) + "/addresses", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ network, address: address.trim(), label: label.trim() || "Receive address" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to attach this address.");
      setAddress("");
      setNotice("Receive address saved to the active wallet. Refreshing wallet data…");
      await loadWalletsAndAddresses();
      if (onWalletSwitched) await onWalletSwitched();
    } catch (err) {
      setError(err.message || "Unable to attach this address.");
    } finally {
      setSaving(false);
    }
  }

  async function copyAddress() {
    if (!selectedAddress?.address) return;
    try {
      await navigator.clipboard.writeText(selectedAddress.address);
      setNotice("Receive address copied.");
    } catch {
      setError("Clipboard access was blocked. Select and copy the address manually.");
    }
  }

  return <section className="panel dashboard-wallet-overview">
    <div className="panel-head dashboard-wallet-overview-head">
      <div><p className="feature-kicker">WALLET CONTROL CENTER</p><h2>Receive address & wallet switch</h2><span>Choose a saved wallet, select its receive address, or attach another public address.</span></div>
      <button type="button" className="secondary" disabled={loading || saving} onClick={loadWalletsAndAddresses}>{loading ? "Refreshing…" : "↻ Refresh"}</button>
    </div>

    <div className="dashboard-wallet-switch-grid">
      <label className="dashboard-wallet-field"><span>Active wallet</span>
        <select value={activeWalletId} disabled={loading || saving || !wallets.length} onChange={event => switchWallet(event.target.value)}>
          {!wallets.length && <option value="">No wallet profiles</option>}
          {wallets.map(item => <option value={item.id} key={item.id}>{item.name}{item.active ? " · Active" : ""}</option>)}
        </select>
      </label>
      <label className="dashboard-wallet-field"><span>Receive address</span>
        <select value={selectedAddressKey} disabled={loading || !addresses.length} onChange={event => setSelectedAddressKey(event.target.value)}>
          {!addresses.length && <option value="">No address attached yet</option>}
          {addresses.map(item => <option key={item.network + ":" + item.address} value={item.network + ":" + item.address}>{item.label || item.network} · {item.network}</option>)}
        </select>
      </label>
    </div>

    <div className="dashboard-receive-address">
      <div><span>PUBLIC RECEIVE ADDRESS</span><code>{selectedAddress?.address || "Attach a public address below to show it here."}</code><small>{selectedAddress ? (selectedAddress.network || "Network") + " · " + (selectedAddress.label || "Saved address") : "Read-only connection · no private key required"}</small></div>
      <div className="dashboard-receive-actions">
        <button type="button" className="secondary" disabled={!selectedAddress?.address} onClick={copyAddress}>Copy address</button>
        <button type="button" className="secondary" disabled={!selectedAddress?.address} onClick={() => {
          const addressValue = selectedAddress.address;
          const url = selectedAddress.network === "bitcoin" ? "https://blockstream.info/address/" + addressValue
            : selectedAddress.network === "bnb" ? "https://bscscan.com/address/" + addressValue
            : selectedAddress.network === "sepolia" ? "https://sepolia.etherscan.io/address/" + addressValue
            : "https://etherscan.io/address/" + addressValue;
          window.open(url, "_blank", "noopener,noreferrer");
        }}>Explorer ↗</button>
        <button type="button" className="primary" onClick={() => setActive?.("Receive")}>Receive funds →</button>
      </div>
    </div>

    <form className="dashboard-attach-address" onSubmit={attachAddress}>
      <label className="dashboard-wallet-field"><span>Network</span><select value={network} onChange={event => setNetwork(event.target.value)}><option value="ethereum">Ethereum Mainnet</option><option value="bnb">BNB Chain</option><option value="sepolia">Sepolia testnet</option><option value="bitcoin">Bitcoin</option></select></label>
      <label className="dashboard-wallet-field"><span>Address label</span><input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} placeholder="e.g. Main receive wallet" /></label>
      <label className="dashboard-wallet-field dashboard-address-input"><span>Public address</span><input value={address} onChange={event => setAddress(event.target.value)} maxLength={128} required placeholder="Paste public receive address" autoComplete="off" /></label>
      <button type="submit" className="primary" disabled={saving || loading || !activeWalletId || !address.trim()}>{saving ? "Saving…" : "Attach address"}</button>
    </form>

    {(error || notice) && <div className={error ? "dashboard-wallet-feedback error" : "dashboard-wallet-feedback"} role={error ? "alert" : "status"}>{error || notice}</div>}

    <div className="dashboard-balmz-section">
      <div className="dashboard-balmz-title"><div><p className="feature-kicker">BALMZ TOKEN</p><h2>BALMZ wallet summary</h2><span>On-chain values only appear when the token contract and wallet balance are available.</span></div><span className={"dashboard-balmz-status" + (contractPending ? " pending" : "")}>{contractPending ? "Contract pending" : "Contract configured"}</span></div>
      <div className="dashboard-balmz-metrics">
        <article><span>Available / remaining</span><strong>{amount(balmzBalance)} BALMZ</strong><small>Spendable balance reported by the wallet API</small></article>
        <article><span>Total pending</span><strong>{amount(pendingAmount)} BALMZ</strong><small>{balmzPending.length} pending transaction{balmzPending.length === 1 ? "" : "s"}</small></article>
        <article><span>Total received</span><strong>{amount(totalReceived)} BALMZ</strong><small>Non-pending wallet history</small></article>
        <article><span>Total sent</span><strong>{amount(totalSent)} BALMZ</strong><small>Completed outgoing history</small></article>
        <article><span>Reserved balance</span><strong>{amount(balmzReserved)} BALMZ</strong><small>Excluded from available balance</small></article>
        <article><span>Coin price</span><strong>{balmzPrice > 0 ? money(balmzPrice) : "Not listed"}</strong><small>{balmzPrice > 0 ? "Current quote source" : contractPending ? "Waiting for deployed contract / verified market quote" : "No verified market quote available"}</small></article>
      </div>
      <div className="dashboard-balmz-footer"><span>Wallet value</span><strong>{balmzPrice > 0 ? money(balmzBalance * balmzPrice) : "—"}</strong><span className="dashboard-balmz-note">No price or balance is invented. BALMZ testnet and Ethereum Mainnet are kept separate.</span></div>
    </div>
  </section>;
}
