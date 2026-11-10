import { useCallback, useState } from "react";

export default function WalletWizard({ accessToken = "", apiBaseUrl = "", wallet = null, assets = [], setActive }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState(null);

  const runChecks = useCallback(async () => {
    if (!accessToken || !apiBaseUrl) {
      setError("Sign in and complete the wallet PIN check before running wallet checks.");
      return;
    }
    setLoading(true);
    setError("");
    const headers = { Authorization: "Bearer " + accessToken, Accept: "application/json" };
    const endpoints = [
      ["balances", "/api/v1/wallet/balance-verification"],
      ["reserves", "/api/v1/wallet/proof-of-reserves"],
      ["reconciliation", "/api/v1/wallet/reconciliation"],
      ["activity", "/api/v1/wallet/activity-trace?limit=1&offset=0"],
    ];
    try {
      const entries = await Promise.all(endpoints.map(async ([key,path]) => {
        const response = await fetch(apiBaseUrl + path, { headers, cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || key + " check failed");
        return [key,data];
      }));
      setReport(Object.fromEntries(entries));
    } catch (cause) {
      setError(cause?.message || "Wallet checks could not be completed.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [accessToken, apiBaseUrl]);

  const verifiedBalances = (report?.balances?.assets || []).filter(item => item.verified === true);
  const mismatches = verifiedBalances.filter(item => item.matches_ledger === false);
  const unverifiedBalances = (report?.balances?.assets || []).filter(item => item.verified !== true);
  const catalogAssets = report?.reserves?.catalog_assets || [];
  const verifiedReserveAssets = catalogAssets.filter(item => item.verified === true);
  const unverifiedReserveAssets = catalogAssets.filter(item => item.verified !== true);
  const activityTotal = Number(report?.activity?.pagination?.total || 0);
  const addressCount = Object.values(report?.balances?.addresses || {}).reduce((sum,item) => sum + Number(item.verified_address_count || 0),0);

  let nextStep = "Run the checks to generate a wallet-specific guided plan.";
  let nextPage = "Dashboard";
  if (report) {
    if (!addressCount) { nextStep = "Attach and prove ownership of a Mainnet wallet address before treating balances as owned."; nextPage = "Wallets"; }
    else if (mismatches.length) { nextStep = "Chain balances differ from the saved ledger. Review reconciliation and transaction evidence before transferring."; nextPage = "Activity Trace"; }
    else if (unverifiedBalances.length || unverifiedReserveAssets.length) { nextStep = "Some assets do not yet have a verified chain reader or contract. Review the reserve inventory and contract records."; nextPage = "Proof of Reserves"; }
    else if (report.reconciliation?.status === "REVIEW_REQUIRED") { nextStep = "A reservation or transaction receipt needs reconciliation."; nextPage = "Activity Trace"; }
    else { nextStep = "Balance checks completed without a reported ledger mismatch. Review recent activity before a send or return."; nextPage = "Activity Trace"; }
  }

  const tasks = [
    { label: "Verified wallet addresses", value: report ? addressCount + " across Mainnet networks" : "Not checked", status: report ? addressCount ? "Address checks passed" : "No verified address" : "Waiting" },
    { label: "On-chain balances", value: report ? verifiedBalances.length + " verified · " + unverifiedBalances.length + " unavailable/unverified" : "Not checked", status: report ? mismatches.length ? mismatches.length + " ledger mismatch(es)" : "Chain reads compared with ledger" : "Waiting" },
    { label: "Proof-of-reserves catalogue", value: report ? verifiedReserveAssets.length + "/" + catalogAssets.length + " assets verified" : "Not checked", status: report?.reserves?.status || "Waiting" },
    { label: "Transaction and activity trace", value: report ? activityTotal.toLocaleString() + " saved records" : "Not checked", status: report ? report.activity?.sources?.join(" + ") : "Waiting" },
    { label: "Internal reconciliation", value: report ? report.reconciliation?.exceptions?.length + " exception(s)" : "Not checked", status: report?.reconciliation?.status || "Waiting" },
  ];

  return <section className="content feature-content wallet-wizard-page">
    <div className="page-heading"><div><p className="eyebrow">BALMZ AI · GUIDED WALLET HELPER</p><h1>WizzU Helper</h1><p className="muted">A guided checklist from your authenticated wallet, live balance verification and saved audit records.</p></div><button className="secondary" onClick={() => setActive?.("BALMZ AI")}>BALMZ AI</button></div>
    <article className="panel action-panel">
      <div className="panel-head"><div><h2>Run wallet checks</h2><span>Read-only. No funds move and no settings are changed.</span></div><button type="button" className="primary" disabled={loading} onClick={runChecks}>{loading ? "Checking wallet…" : "Run guided checks"}</button></div>
      <p className="security-note">Active wallet: {wallet?.wallet_number || wallet?.wallet_id || wallet?.id || "Loading"} · Asset rows in current dashboard: {assets.length}. The helper does not invent missing balances or contract verifications.</p>
      {error && <div role="alert" className="feature-error">{error}</div>}
      {report && <div className="tool-list">{tasks.map((task,index)=><div className="tool-row" key={task.label}><div><b>{index+1}. {task.label}</b><small>{task.value}</small><small>{task.status}</small></div></div>)}</div>}
    </article>
    <article className="panel action-panel">
      <p className="feature-kicker">NEXT RECOMMENDED STEP</p>
      <h2>{report ? nextStep : "Your guided plan is ready to run."}</h2>
      <div className="page-actions">
        <button type="button" className="primary" disabled={!report} onClick={() => setActive?.(nextPage)}>Open recommended page</button>
        <button type="button" className="secondary" onClick={() => setActive?.("Wallets")}>Wallets</button>
        <button type="button" className="secondary" onClick={() => setActive?.("Return to OKX")}>Return to OKX</button>
        <button type="button" className="secondary" onClick={() => setActive?.("Proof of Reserves")}>Proof of Reserves</button>
        <button type="button" className="secondary" onClick={() => setActive?.("Activity Trace")}>Activity Trace</button>
      </div>
    </article>
    <p className="muted">Guidance is rule-based and tied to returned API evidence. It is not an external generative AI response or investment recommendation.</p>
  </section>;
}
