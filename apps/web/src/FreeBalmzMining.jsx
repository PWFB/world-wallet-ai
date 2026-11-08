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
  const [selectedReceipt, setSelectedReceipt] = useState(null);

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

  async function recordRewards() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request("/api/v1/mining/balmz/record", "POST");
      setMessage(result.notice || "Pending allocation ledger updated.");
      setData(await request("/api/v1/mining/balmz"));
    } catch (err) { setError(err?.message || "Could not record eligible cycles."); }
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

    <article className="panel action-panel mining-code-panel">
      <div className="panel-head"><div><h2>Your account codes</h2><span>Two separate, permanent codes for this wallet.</span></div></div>
      <div className="feature-grid mining-status-grid">
        <div className="panel action-panel mining-status-card"><small>MINING REFERRAL CODE</small><strong>{data?.mining_referral_code || "Loading…"}</strong><span>Share this code for mining referrals.</span></div>
        <div className="panel action-panel mining-status-card"><small>WORLD WALLET AI CODE</small><strong>{data?.world_wallet_code || "Loading…"}</strong><span>Separate World Wallet AI account identifier.</span></div>
      </div>
      <p className="security-note">These codes are different and permanently assigned to this wallet. Referral attribution records the inviting wallet; no referral reward or payout is enabled.</p>
      <div className="tool-row"><span>Accounts referred</span><strong>{data?.mining_referral_count ?? 0}</strong></div>
    </article>

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
      <div className="panel-head"><div><h2>Pending BALMZ allocation</h2><span>Server-recorded completed cycles; not an on-chain balance.</span></div><span className="mining-interest-badge">0.5 / 3 hours</span></div>
      <div className="feature-grid mining-status-grid">
        <article className="panel action-panel mining-status-card"><small>PENDING ALLOCATION</small><strong>{data?.pending_reward_amount ?? "0"} BALMZ</strong><span>Internal ledger only · not spendable</span></article>
        <article className="panel action-panel mining-status-card"><small>RECORDED CYCLES</small><strong>{Number(data?.pending_cycle_count || 0).toLocaleString()}</strong><span>Maximum 8 cycles / 4 BALMZ per UTC day</span></article>
      </div>
      <div className="mining-status-line"><span className="mining-status-dot" aria-hidden="true"></span><b>{active && cycle.completedCycles > 0 ? "Completed checkpoints may be recorded" : active ? "Mining cycle in progress" : "Start mining to begin your first cycle"}</b></div>
      <p className="security-note">Record completed three-hour cycles to your wallet's pending allocation ledger. The server enforces 0.5 BALMZ per completed cycle and a 4 BALMZ daily cap. Repeated requests do not create duplicate entries.</p>
      <button className="primary feature-submit" type="button" disabled={busy || !data} onClick={recordRewards}>Record eligible cycles</button>
      <p className="security-note">Withdrawals remain locked until the official BALMZ launch, verified Mainnet contract and funded allocation. This action does not mint, transfer, or credit an on-chain token. Mainnet, Sepolia and Solana Devnet balances remain separate.</p>
    </article>

    <article className="panel action-panel">
      <div className="panel-head"><div><h2>Mining receipt history</h2><span>Every recorded cycle has a permanent, view-only receipt.</span></div><span className="mining-interest-badge">{data?.recent_rewards?.length || 0} receipts</span></div>
      {!data?.recent_rewards?.length ? <p className="muted">No receipts yet. A receipt is created when eligible three-hour cycles are recorded.</p> :
        <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 520 }}>
          <thead><tr><th>Receipt timestamp</th><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead>
          <tbody>{data.recent_rewards.map(reward => <tr key={reward.id}>
            <td>{new Date(reward.recorded_at || reward.earned_at).toLocaleString()}</td><td>{reward.amount} BALMZ</td><td>Pending launch</td>
            <td><button className="secondary" type="button" onClick={() => setSelectedReceipt(reward)}>View receipt</button></td>
          </tr>)}</tbody>
        </table></div>}
    </article>

    {selectedReceipt && <div role="presentation" onClick={() => setSelectedReceipt(null)} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,.68)", display: "grid", placeItems: "center", padding: 16 }}>
      <section role="dialog" aria-modal="true" aria-labelledby="balmz-receipt-title" onClick={event => event.stopPropagation()} className="panel action-panel" style={{ width: "min(100%, 520px)", maxHeight: "85vh", overflowY: "auto" }}>
        <div className="panel-head"><div><span className="feature-kicker">WORLD WALLET AI · BALMZ</span><h2 id="balmz-receipt-title">Mining receipt</h2></div><button className="secondary" type="button" onClick={() => setSelectedReceipt(null)}>Close</button></div>
        <p className="security-note">Permanent view-only record. Receipt details cannot be edited or deleted from this page.</p>
        <div className="tool-list">
          <div className="tool-row"><span>Receipt ID</span><strong style={{ overflowWrap: "anywhere" }}>{selectedReceipt.id}</strong></div>
          <div className="tool-row"><span>Mining referral code</span><strong>{data?.mining_referral_code || "—"}</strong></div>
          <div className="tool-row"><span>World Wallet AI code</span><strong>{data?.world_wallet_code || "—"}</strong></div>
          <div className="tool-row"><span>Recorded timestamp</span><strong>{new Date(selectedReceipt.recorded_at || selectedReceipt.earned_at).toLocaleString()}</strong></div>
          <div className="tool-row"><span>Cycle earned timestamp</span><strong>{new Date(selectedReceipt.earned_at).toLocaleString()}</strong></div>
          <div className="tool-row"><span>Cycle number</span><strong>{selectedReceipt.cycle_number ?? "—"}</strong></div>
          <div className="tool-row"><span>Mining session</span><strong style={{ overflowWrap: "anywhere" }}>{selectedReceipt.session_id || "—"}</strong></div>
          <div className="tool-row"><span>Allocation</span><strong>{selectedReceipt.amount} BALMZ</strong></div>
          <div className="tool-row"><span>Status</span><strong>Pending official launch · not spendable</strong></div>
        </div>
        <p className="security-note">This receipt confirms an internal pending allocation only. It is not an on-chain transaction or proof of a token transfer.</p>
      </section>
    </div>}

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
