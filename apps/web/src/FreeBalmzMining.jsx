import { useCallback, useEffect, useState } from "react";
import { getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? hours + "h" : "", minutes ? minutes + "m" : "", remainder + "s"].filter(Boolean).join(" ");
}

export default function FreeBalmzMining({ accessToken, apiBaseUrl }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const request = useCallback(async (path, method = "GET") => {
    const fresh = await getNeonAccessToken({ forceRefresh: true });
    const token = fresh || (isUsableNeonAccessToken(accessToken) ? accessToken : "");
    if (!token) throw new Error("Your signed-in session is unavailable. Sign in again.");
    const response = await fetch(apiBaseUrl + path, {
      method,
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || "BALMZ mining service is unavailable.");
    return result;
  }, [accessToken, apiBaseUrl]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try { setData(await request("/api/v1/mining/balmz")); }
    catch (err) { setError(err?.message || "Could not load mining status."); }
    finally { setBusy(false); }
  }, [request]);

  useEffect(() => { refresh(); }, [refresh]);

  async function act(action) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/v1/mining/balmz/" + action, "POST");
      setMessage(result.notice || (action === "start" ? "Free session started." : "Session completed."));
      setData(await request("/api/v1/mining/balmz"));
    } catch (err) { setError(err?.message || "Mining session action failed."); }
    finally { setBusy(false); }
  }

  const active = Boolean(data?.active_session);
  return <section className="content feature-content mining-page">
    <div className="page-heading">
      <div>
        <p className="eyebrow">WORLD WALLET AI / BALMZ ECOSYSTEM</p>
        <h1>Free BALMZ Mining</h1>
        <p className="muted">Free participation with no USDT deposit, purchase or activation fee.</p>
      </div>
      <button className="secondary" type="button" disabled={busy} onClick={refresh}>↻ Refresh</button>
    </div>

    <article className="panel action-panel mining-hero">
      <div className="mining-hero-copy">
        <span className="feature-kicker">FREE COMMUNITY PARTICIPATION</span>
        <h2>Start or stop your free mining participation session.</h2>
        <p>Sessions are securely recorded against your signed-in World Wallet account. This release tracks participation only; it does not run proof-of-work, mint tokens, or create spendable BALMZ.</p>
        <div className="mining-status-line"><span className="mining-status-dot" aria-hidden="true"></span><b>{active ? "Session active" : "Ready to start"}</b><span>No deposit required</span></div>
      </div>
      <div className="mining-hero-mark" aria-hidden="true"><span>⛏</span><b>BALMZ</b><small>FREE MINING</small></div>
    </article>

    {error && <div className="feature-error" role="alert">{error}</div>}
    {message && <div className="feature-success" role="status">{message}</div>}

    <div className="feature-grid mining-status-grid">
      <article className="panel action-panel mining-status-card"><small>SESSION STATUS</small><strong>{busy ? "Updating…" : active ? "Active" : "Inactive"}</strong><span>{active ? "Started " + new Date(data.active_session.started_at).toLocaleString() : "No active session"}</span></article>
      <article className="panel action-panel mining-status-card"><small>COMPLETED SESSIONS</small><strong>{Number(data?.completed_sessions || 0).toLocaleString()}</strong><span>Recorded for this wallet</span></article>
      <article className="panel action-panel mining-status-card"><small>TOTAL PARTICIPATION</small><strong>{formatDuration(data?.total_session_seconds)}</strong><span>Session time, not token earnings</span></article>
    </div>

    <article className="panel action-panel mining-interest-panel">
      <div className="panel-head"><div><h2>Your free session</h2><span>One active session per wallet.</span></div><span className="mining-interest-badge">0 USDT</span></div>
      <div className="inline-form">
        {!active
          ? <button className="primary feature-submit" type="button" disabled={busy || !data} onClick={() => act("start")}>Start free session</button>
          : <button className="primary feature-submit" type="button" disabled={busy} onClick={() => act("stop")}>Stop session</button>}
      </div>
      <p className="security-note">BALMZ rewards and withdrawals are not enabled in this release. They can only be activated after the authorized Mainnet reward allocation, available treasury balance, distribution rules and replay-protected claim mechanism are independently verified. Devnet tokens are never counted as Mainnet rewards.</p>
    </article>

    <article className="panel action-panel">
      <h2>Recent sessions</h2>
      {!data?.recent_sessions?.length ? <p className="muted">No sessions recorded yet.</p> :
        <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 560 }}>
          <thead><tr><th>Status</th><th>Started</th><th>Ended</th><th>Duration</th></tr></thead>
          <tbody>{data.recent_sessions.map(session => <tr key={session.id}>
            <td>{session.status === "active" ? "Active" : "Completed"}</td>
            <td>{new Date(session.started_at).toLocaleString()}</td>
            <td>{session.ended_at ? new Date(session.ended_at).toLocaleString() : "—"}</td>
            <td>{session.duration_seconds == null ? "In progress" : formatDuration(session.duration_seconds)}</td>
          </tr>)}</tbody>
        </table></div>}
    </article>
  </section>;
}
