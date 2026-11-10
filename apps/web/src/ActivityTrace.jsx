import { useCallback, useEffect, useMemo, useState } from "react";

function short(value) {
  const text = String(value || "");
  return text.length > 28 ? text.slice(0, 12) + "…" + text.slice(-10) : text || "—";
}

function explorerUrl(event) {
  const hash = String(event?.tx_hash || "").trim();
  if (!hash || !/^[A-Za-z0-9]+$/.test(hash)) return "";
  const network = String(event?.network || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (network === "bitcoin") return "https://blockstream.info/tx/" + encodeURIComponent(hash);
  if (network === "bnb") return "https://bscscan.com/tx/" + encodeURIComponent(hash);
  if (network === "sepolia") return "https://sepolia.etherscan.io/tx/" + encodeURIComponent(hash);
  if (network === "ethereum") return "https://etherscan.io/tx/" + encodeURIComponent(hash);
  if (network === "solana_mainnet" || network === "solana") return "https://solscan.io/tx/" + encodeURIComponent(hash);
  if (network === "solana_devnet") return "https://explorer.solana.com/tx/" + encodeURIComponent(hash) + "?cluster=devnet";
  return "";
}

function friendlyStatus(event) {
  const state = String(event?.receipt_state || event?.status || "").toLowerCase();
  if (["confirmed", "settled", "success"].includes(state)) return "Confirmed";
  if (["failed", "rejected", "reorged"].includes(state)) return state === "reorged" ? "Reorged" : "Failed";
  if (state === "pending" || state === "broadcast_pending" || state === "pending_review") return "Pending";
  if (state === "audit_record") return "Wallet activity";
  return "Not broadcast / unknown";
}

export default function ActivityTrace({ accessToken = "", apiBaseUrl = "", setActive }) {
  const [events, setEvents] = useState([]);
  const [pagination, setPagination] = useState({ limit: 100, offset: 0, total: 0, has_more: false, next_offset: null });
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [lastLoaded, setLastLoaded] = useState(null);

  const loadPage = useCallback(async (offset = 0, append = false) => {
    if (!accessToken || !apiBaseUrl) {
      setError("Sign in and complete the wallet PIN check to load activity.");
      return null;
    }
    setLoading(true);
    setError("");
    try {
      const url = apiBaseUrl + "/api/v1/wallet/activity-trace?limit=100&offset=" + offset;
      const response = await fetch(url, {
        headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Wallet activity trace could not be loaded.");
      const page = Array.isArray(data.events) ? data.events : [];
      setEvents(current => append ? [...current, ...page.filter(item => !current.some(old => old.event_type === item.event_type && old.id === item.id))] : page);
      setPagination(data.pagination || { limit: 100, offset, total: page.length, has_more: false, next_offset: null });
      setLastLoaded(new Date().toISOString());
      return data;
    } catch (cause) {
      setError(cause?.message || "Wallet activity trace failed.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [accessToken, apiBaseUrl]);

  useEffect(() => {
    setEvents([]);
    setPagination({ limit: 100, offset: 0, total: 0, has_more: false, next_offset: null });
    loadPage(0, false);
  }, [loadPage]);

  async function loadAllPages() {
    if (loadingAll || loading) return;
    setLoadingAll(true);
    try {
      let next = pagination.next_offset;
      let hasMore = pagination.has_more;
      while (hasMore && next != null) {
        const data = await loadPage(next, true);
        if (!data) break;
        hasMore = Boolean(data.pagination?.has_more);
        next = data.pagination?.next_offset ?? null;
      }
    } finally {
      setLoadingAll(false);
    }
  }

  const visible = useMemo(() => events.filter(event => {
    const text = [
      event.action, event.resource, event.asset, event.network, event.status,
      event.receipt_state, event.reference, event.tx_hash, event.from_address,
      event.to_address, event.token_contract_address, event.details,
    ].join(" ").toLowerCase();
    const sourceOk = sourceFilter === "all" || event.event_type === sourceFilter;
    const state = String(event.receipt_state || event.status || "").toLowerCase();
    const statusOk = statusFilter === "all"
      || (statusFilter === "confirmed" && ["confirmed", "settled", "success"].includes(state))
      || (statusFilter === "pending" && ["pending", "broadcast_pending", "pending_review"].includes(state))
      || (statusFilter === "failed" && ["failed", "rejected", "reorged"].includes(state))
      || (statusFilter === "wallet" && event.event_type === "wallet_action");
    return sourceOk && statusOk && (!search.trim() || text.includes(search.trim().toLowerCase()));
  }), [events, sourceFilter, statusFilter, search]);

  const confirmedCount = events.filter(item => ["confirmed", "settled", "success"].includes(String(item.receipt_state || item.status).toLowerCase())).length;
  const pendingCount = events.filter(item => ["pending", "broadcast_pending", "pending_review"].includes(String(item.receipt_state || item.status).toLowerCase())).length;
  const failedCount = events.filter(item => ["failed", "rejected", "reorged"].includes(String(item.receipt_state || item.status).toLowerCase())).length;

  return <section className="content feature-content activity-trace-page">
    <div className="page-heading">
      <div><p className="eyebrow">BALMZ AI · EVIDENCE & ACTIVITY</p><h1>Transaction & Activity Trace</h1><p className="muted">One chronological record of saved blockchain transactions and World Wallet AI wallet actions.</p></div>
      <div className="page-actions">
        {setActive && <button type="button" className="secondary" onClick={() => setActive("BALMZ AI")}>BALMZ AI</button>}
        <button type="button" className="secondary" disabled={loading || loadingAll} onClick={() => loadPage(0, false)}>↻ Refresh</button>
      </div>
    </div>

    <div className="feature-grid">
      <article className="panel action-panel"><small>Loaded records</small><strong>{events.length.toLocaleString()} / {Number(pagination.total || 0).toLocaleString()}</strong><small>Paginated from the active wallet</small></article>
      <article className="panel action-panel"><small>Confirmed / settled</small><strong>{confirmedCount.toLocaleString()}</strong><small>Receipt status in saved records</small></article>
      <article className="panel action-panel"><small>Pending</small><strong>{pendingCount.toLocaleString()}</strong><small>Not yet final</small></article>
      <article className="panel action-panel"><small>Failed / reorged</small><strong>{failedCount.toLocaleString()}</strong><small>Needs review</small></article>
    </div>

    {error && <div role="alert" className="feature-error">{error}</div>}
    <article className="panel action-panel">
      <div className="panel-head"><div><h2>Trace filters</h2><span>Filters apply to records currently loaded. Use Load all records to search the complete wallet history.</span></div><small>{lastLoaded ? "Loaded " + new Date(lastLoaded).toLocaleString() : "Not refreshed"}</small></div>
      <div className="feature-grid">
        <label>Search<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Asset, hash, reference, network…" /></label>
        <label>Record source<select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}><option value="all">All activity</option><option value="transaction">Blockchain transactions</option><option value="wallet_action">Wallet actions</option></select></label>
        <label>Status<select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All states</option><option value="confirmed">Confirmed</option><option value="pending">Pending</option><option value="failed">Failed / reorged</option><option value="wallet">Wallet actions</option></select></label>
      </div>
    </article>

    <article className="panel action-panel">
      <div className="panel-head"><div><h2>Complete wallet activity</h2><span>{pagination.total.toLocaleString()} saved records from transactions and wallet audit events.</span></div><span className="presale-status-pill">{pagination.has_more ? "More records available" : "End of history loaded"}</span></div>
      {loading && events.length === 0 ? <div className="feature-loading">Loading transaction and audit evidence…</div>
        : visible.length ? <div className="tool-list">
          {visible.map((event,index) => {
            const link = explorerUrl(event);
            const isTx = event.event_type === "transaction";
            const state = friendlyStatus(event);
            return <div className="tool-row" key={event.event_type + ":" + event.id + ":" + index}>
              <div style={{ minWidth: 0 }}>
                <b>{isTx ? (event.asset || "Asset") + " · " + (event.action || "transaction") : (event.action || "Wallet activity") + " · " + (event.resource || "wallet")}</b>
                <small>{event.created_at ? new Date(event.created_at).toLocaleString() : "Timestamp unavailable"} · {event.network || "Network not recorded"} · {state}</small>
                {isTx && <small>{event.amount == null ? "Amount unavailable" : event.amount + " " + (event.asset || "")} · {Number(event.confirmations || 0)} confirmations reported</small>}
                {event.reference && <small>Reference: {event.reference}</small>}
                {event.tx_hash && <small>Transaction: <code>{short(event.tx_hash)}</code></small>}
                {event.token_contract_address && <small>Token contract: <code>{short(event.token_contract_address)}</code></small>}
                {event.from_address && <small>From: <code>{short(event.from_address)}</code></small>}
                {event.to_address && <small>To: <code>{short(event.to_address)}</code></small>}
                {event.details && <small>{String(event.details).slice(0, 260)}</small>}
              </div>
              {link ? <a href={link} target="_blank" rel="noreferrer">Open explorer ↗</a> : <span className="neutral">{isTx ? "No supported explorer hash" : "Audit event"}</span>}
            </div>;
          })}
        </div> : <div className="feature-empty">{events.length ? "No loaded records match these filters." : "No transaction or wallet audit records were returned for this wallet."}</div>}
      {pagination.has_more && <div className="page-actions">
        <button type="button" className="secondary" disabled={loading || loadingAll} onClick={() => loadPage(pagination.next_offset, true)}>{loading ? "Loading…" : "Load next 100"}</button>
        <button type="button" className="primary" disabled={loading || loadingAll} onClick={loadAllPages}>{loadingAll ? "Loading all records…" : "Load all records"}</button>
      </div>}
      <p className="security-note">This view traces records currently saved by World Wallet AI. It cannot prove that every external chain transaction has been imported. Use the network explorer for each hash and inspect sync warnings for missing sources.</p>
    </article>
  </section>;
}
