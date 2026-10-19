import { useCallback, useEffect, useMemo, useState } from "react";
import "./DashboardWalletPanel.css";

export default function DashboardWalletPanel({ accessToken, apiBaseUrl, onWalletSwitched }) {
  const [wallets, setWallets] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("world_wallet_last_confirmed_wallet_list_v1") || "null");
      return Array.isArray(cached?.wallets) ? cached.wallets : [];
    } catch { return []; }
  });
  const [activeWalletId, setActiveWalletId] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("world_wallet_last_confirmed_wallet_list_v1") || "null");
      return String(cached?.activeWalletId || "");
    } catch { return ""; }
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const authHeaders = useMemo(() => ({ Authorization: "Bearer " + accessToken }), [accessToken]);

  useEffect(() => {
    if (!wallets.length || !activeWalletId) return;
    try {
      localStorage.setItem("world_wallet_last_confirmed_wallet_list_v1", JSON.stringify({
        wallets,
        activeWalletId: String(activeWalletId),
        savedAt: new Date().toISOString(),
      }));
    } catch {}
  }, [wallets, activeWalletId]);

  const loadWallets = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallets", { headers: authHeaders });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Unable to load wallet profiles.");
      const nextWallets = Array.isArray(data.wallets) ? data.wallets : [];
      // A successful but temporarily empty response must not erase a wallet list
      // the user already had on screen (especially immediately after switching).
      if (nextWallets.length) {
        setWallets(nextWallets);
        const serverActiveId = data.active_wallet_id || nextWallets.find(item => item.active)?.id || "";
        if (serverActiveId) setActiveWalletId(serverActiveId);
      } else {
        setWallets(current => current);
        setActiveWalletId(current => current);
      }
    } catch (err) {
      // Keep the last known wallet selection visible if a transient request fails.
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
      const confirmedActiveId = data.active_wallet_id || nextId;
      // Switch the visible selection immediately; do not wait for a second list
      // request that can briefly return an empty/stale result.
      setActiveWalletId(confirmedActiveId);
      setWallets(current => current.map(item => ({ ...item, active: String(item.id) === String(confirmedActiveId) })));
      await loadWallets();
      if (onWalletSwitched) await onWalletSwitched();
    } catch (err) {
      setError(err.message || "Wallet switch failed.");
    } finally {
      setSaving(false);
    }
  }

  const activeWallet = wallets.find(item => String(item.id) === String(activeWalletId)) || wallets.find(item => item.active) || null;

  return <div className="dashboard-active-wallet" aria-label="Active wallet selector">
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
  </div>;
}
