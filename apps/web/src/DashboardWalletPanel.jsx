import { useCallback, useEffect, useMemo, useState } from "react";
import "./DashboardWalletPanel.css";

export default function DashboardWalletPanel({ accessToken, apiBaseUrl, onWalletSwitched }) {
  const [wallets, setWallets] = useState([]);
  const [activeWalletId, setActiveWalletId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const authHeaders = useMemo(() => ({ Authorization: "Bearer " + accessToken }), [accessToken]);

  const loadWallets = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets", { headers: authHeaders });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to load wallet profiles.");
      const nextWallets = data.wallets || [];
      setWallets(nextWallets);
      setActiveWalletId(data.active_wallet_id || nextWallets.find(item => item.active)?.id || "");
    } catch (err) {
      setError(err.message || "Wallet data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [accessToken, apiBaseUrl, authHeaders]);

  useEffect(() => { loadWallets(); }, [loadWallets]);

  async function switchWallet(nextId) {
    if (!nextId || nextId === activeWalletId) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets/active", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ wallet_id: nextId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Wallet switch failed.");
      setActiveWalletId(data.active_wallet_id || nextId);
      await loadWallets();
      if (onWalletSwitched) await onWalletSwitched();
    } catch (err) {
      setError(err.message || "Wallet switch failed.");
    } finally {
      setSaving(false);
    }
  }

  const activeWallet = wallets.find(item => String(item.id) === String(activeWalletId)) || wallets.find(item => item.active) || null;

  return <section className="panel dashboard-active-wallet" aria-label="Active wallet selector">
    <label className="dashboard-active-wallet-label" htmlFor="dashboard-active-wallet-select">Active wallet</label>
    <div className="dashboard-active-wallet-row">
      <select id="dashboard-active-wallet-select" value={activeWalletId} disabled={loading || saving || !wallets.length}
        onChange={event => switchWallet(event.target.value)} aria-label="Choose active wallet">
        {!wallets.length && <option value="">No wallet available</option>}
        {wallets.map(item => <option value={item.id} key={item.id}>{item.name || "Production Wallet"}{String(item.id) === String(activeWalletId) ? " · Active" : ""}</option>)}
      </select>
      <span className="dashboard-active-wallet-status">{saving ? "Switching…" : activeWallet ? (activeWallet.name || "Production Wallet") + " · Active" : loading ? "Loading wallet…" : "No active wallet"}</span>
    </div>
    {error && <p className="dashboard-active-wallet-error" role="alert">{error}</p>}
  </section>;
}
