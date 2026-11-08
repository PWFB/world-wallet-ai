import { useCallback, useEffect, useMemo, useState } from "react";
import { getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";

const CLAIM_INTERVAL_SECONDS = 3 * 60 * 60;

function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? hours + "h" : "", minutes ? minutes + "m" : "", remainder + "s"].filter(Boolean).join(" ");
}

function cycleState(startedAt, nowMs) {
  if (!startedAt) return { elapsed: 0, completedCycles: 0, remaining: CLAIM_INTERVAL_SECONDS, nextAt: null };
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return { elapsed: 0, completedCycles: 0, remaining: CLAIM_INTERVAL_SECONDS, nextAt: null };
  const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const completedCycles = Math.floor(elapsed / CLAIM_INTERVAL_SECONDS);
  const remaining = CLAIM_INTERVAL_SECONDS - (elapsed % CLAIM_INTERVAL_SECONDS);
  return {
    elapsed,
    completedCycles,
    remaining,
    nextAt: new Date(startMs + (completedCycles + 1) * CLAIM_INTERVAL_SECONDS * 1000),
  };
}

export default function FreeBalmzMining({ accessToken, apiBaseUrl }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());

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
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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
  const cycle = useMemo(
    () => cycleState(data?.active_session?.started_at, nowMs),
    [data?.active_session?.started_at, nowMs]
  );
  const nextClaimTime = cycle.nextAt
    ? cycle.nextAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "Starts when mining starts";

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
        <h2>One wallet, one saved mining clock.</h2>
        <p>Your mining start time is saved on the server against this wallet. The 3-hour schedule continues from that exact timestamp after refresh or sign-in.</p>
        <div className="mining-status-line"><span className="mining-status-dot" aria-hidden="true"></span><b>{active ? "Mining clock active" : "Ready to start"}</b><span>No deposit required</span></div>
      </div>
      <div className="mining-hero-mark" aria-hidden="true"><span>⛏</span><b>BALMZ</b><small>FREE MINING</small></div>
    </article>

    {error && <div className="feature-error" role="alert">{error}</div>}
    {message && <div className="feature-success" role="status">{message}</div>}

    <div className="feature-grid mining-status-grid">
      <article className="panel action-panel mining-status-card"><small>WALLET MINING START</small><strong>{active ? new Date(data.active_session.started_at).toLocaleString() : "Not started"}</strong><span>Persisted wallet-specific timestamp</span></article>
      <article className="panel action-panel mining-status-card"><small>NEXT 3-HOUR CHECKPOINT</small><strong>{active ? formatDuration(cycle.remaining) : "—"}</strong><span>{active ? "Scheduled for " + nextClaimTime : "Start mining to begin the clock"}</span></article>
      <article className="panel action-panel mining-status-card"><small>COMPLETED 3-HOUR CYCLES</small><strong>{active ? cycle.completedCycles.toLocaleString() : "0"}</strong><span>Elapsed checkpoints only; not token earnings</span></article>
    </div>

    <article className="panel action-panel mining-interest-panel">
      <div className="panel-head"><div><h2>Your free mining schedule</h2><span>One active mining clock per wallet.</span></div><span className="mining-interest-badge">0 USDT</span></div>
      <div className="inline-form">
        {!active
          ? <button className="primary feature-submit" type="button" disabled={busy || !data} onClick={() => act("start")}>Start free mining</button>
          : <button className="secondary feature-submit" type="button" disabled={busy} onClick={() => act("stop")}>Stop mining clock</button>}
      </div>
    </article>

    <article className="panel action-panel mining-claim-panel">
      <div className="panel-head"><div><h2>BALMZ claim</h2><span>Claim area is visible to every miner.</span></div><span className="mining-interest-badge">Every 3 hours</span></div>
      <div className="mining-status-line"><span className="mining-status-dot" aria-hidden="true"></span><b>{active && cycle.completedCycles > 0 ? "Checkpoint reached — reward verification pending" : active ? "Mining cycle in progress" : "Start mining to begin your first cycle"}</b></div>
      <p className="security-note">The Claim control is shown to all miners, but is not active yet. A checkpoint alone does not create a reward. Claims will only be enabled when a funded Mainnet reward pool and a verified reward ledger are live.</p>
      <button className="primary feature-submit" type="button" disabled aria-disabled="true">Claim BALMZ — not yet enabled</button>
      <p className="security-note">After Mainnet activation, the claim will send the verified net reward to this wallet only after wallet authorization and on-chain confirmation. Any network gas fee and any protocol fee will be disclosed separately before signing; fees must not be silently deducted from the reward. A successful deposit will be shown only after the transaction is confirmed.</p>
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
