import { useState } from "react";
import { getNeonAccessToken } from "./auth-client.js";
import { isUsableNeonAccessToken } from "./neon-token.js";

const NETWORK_OPTIONS = [
  { value: "ethereum,bnb,sepolia", label: "Ethereum + BNB + Sepolia" },
  { value: "ethereum,bnb", label: "Ethereum + BNB Mainnets" },
  { value: "ethereum", label: "Ethereum Mainnet" },
  { value: "bnb", label: "BNB Chain Mainnet" },
  { value: "sepolia", label: "Ethereum Sepolia (testnet)" },
];

function explorerBase(network) {
  if (network === "bnb") return "https://bscscan.com";
  if (network === "sepolia") return "https://sepolia.etherscan.io";
  return "https://etherscan.io";
}

function ExplorerLink({ network, hash, children }) {
  const safeHash = String(hash || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(safeHash)) return <span>{children || "Unavailable"}</span>;
  return <a href={explorerBase(network) + "/tx/" + safeHash} target="_blank" rel="noreferrer">{children || safeHash.slice(0, 12) + "…"}</a>;
}

function Panel({ title, children, note }) {
  return <article className="panel action-panel" style={{ marginBottom: 16 }}>
    <h2 style={{ marginTop: 0 }}>{title}</h2>
    {note && <p className="muted">{note}</p>}
    {children}
  </article>;
}

export default function TokenInteractionAudit({ accessToken, apiBaseUrl }) {
  const [networkSelection, setNetworkSelection] = useState(NETWORK_OPTIONS[0].value);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function scan(nextPage = 1) {
    setBusy(true);
    setError("");
    try {
      const freshToken = await getNeonAccessToken({ forceRefresh: true });
      const token = freshToken || (isUsableNeonAccessToken(accessToken) ? accessToken : "");
      if (!token) throw new Error("Your authenticated wallet session is unavailable. Sign in again and retry.");
      const query = new URLSearchParams({
        networks: networkSelection,
        page: String(nextPage),
        offset: "100",
      });
      const response = await fetch(apiBaseUrl + "/api/v1/wallet/token-interactions?" + query.toString(), {
        method: "GET",
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Token interaction discovery failed.");
      setData(result);
      setPage(nextPage);
    } catch (err) {
      setError(err?.message || "Token interaction discovery failed.");
      if (nextPage === 1) setData(null);
    } finally {
      setBusy(false);
    }
  }

  const networks = data?.networks || [];
  const transfers = networks.reduce((total, network) =>
    total + (network.addresses || []).reduce((count, address) => count + (address.token_transfers || []).length, 0), 0);
  const approvals = networks.reduce((total, network) =>
    total + (network.addresses || []).reduce((count, address) => count + (address.approvals || []).length, 0), 0);
  const hasMore = networks.some(network => (network.addresses || []).some(address => address.pagination?.has_more));

  return <section className="content feature-content">
    <div className="page-heading">
      <div>
        <p className="eyebrow">WORLD WALLET AI · READ-ONLY SECURITY</p>
        <h1>Token Interaction Audit</h1>
        <p className="muted">Discover ERC-20 transfers, historic approvals, current allowances and EIP-7702 delegation for the signature-verified addresses attached to your active wallet.</p>
      </div>
      <button type="button" className="primary" disabled={busy || !accessToken} onClick={() => scan(1)}>{busy ? "Scanning…" : "Scan token history"}</button>
    </div>

    <Panel title="Scan scope" note="The backend reads only addresses already attached to your active World Wallet and marked ownership-verified. Unverified addresses are skipped rather than scanned as if they were confirmed yours.">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label htmlFor="token-audit-networks">Networks</label>
        <select id="token-audit-networks" value={networkSelection} onChange={event => { setNetworkSelection(event.target.value); setData(null); setPage(1); }} disabled={busy}>
          {NETWORK_OPTIONS.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
        <button type="button" className="secondary" disabled={busy || !data || !hasMore} onClick={() => scan(page + 1)}>{busy ? "Loading…" : "Load next page"}</button>
      </div>
      {error && <p role="alert" style={{ color: "#ff8f8f", marginBottom: 0 }}>{error}</p>}
    </Panel>

    {data && <>
      <div className="market-price-grid" style={{ marginBottom: 16 }}>
        <article className="panel action-panel"><small>ERC-20 TRANSFERS · PAGE {data.page}</small><strong>{transfers.toLocaleString()}</strong></article>
        <article className="panel action-panel"><small>APPROVAL EVENTS · PAGE {data.page}</small><strong>{approvals.toLocaleString()}</strong></article>
        <article className="panel action-panel"><small>ACTIVE WALLET SCOPE</small><strong>{networks.reduce((n, item) => n + (item.address_count || 0), 0)} verified addresses</strong></article>
      </div>

      {networks.map(network => <Panel key={network.network} title={network.network.toUpperCase() + " · Chain " + network.chain_id} note={network.status === "scanned" ? "Read-only history returned by Etherscan V2." : network.status.replaceAll("_", " ")}>
        {!!network.skipped_addresses?.length && <div className="security-note">Skipped addresses: {network.skipped_addresses.map(item => item.address + " — " + item.reason).join("; ")}</div>}
        {(network.addresses || []).map(address => <div key={address.address} style={{ borderTop: "1px solid var(--border, #26334d)", paddingTop: 14, marginTop: 14 }}>
          <strong style={{ overflowWrap: "anywhere" }}>{address.label || "Verified wallet"} · {address.address}</strong>
          <div className="security-note" style={{ marginTop: 8 }}>
            EIP-7702: {address.delegation?.delegated === true ? "Delegated" : address.delegation?.delegated === false ? "Not delegated" : "Not verified"}
            {address.delegation?.delegation_target ? " · Target " + address.delegation.delegation_target : ""}
            {address.delegation?.known_okx_walletcore ? " · Known OKX WalletCore target" : ""}
            {" · "}This is not an ERC-20 allowance.
          </div>

          <h3>Token transfers ({(address.token_transfers || []).length})</h3>
          {!address.token_transfers?.length ? <p className="muted">No transfer records on this page.</p> :
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 640 }}>
              <thead><tr><th>Token</th><th>Amount</th><th>Direction</th><th>Transaction</th><th>BALMZ match</th></tr></thead>
              <tbody>{address.token_transfers.map((tx, index) => <tr key={tx.tx_hash || index}>
                <td>{tx.token_symbol || "Unknown"}<small style={{ display: "block" }}>{tx.token_contract_address || "Contract unavailable"}</small></td>
                <td>{tx.amount ?? tx.amount_raw} {tx.amount === null ? "raw units" : ""}</td>
                <td>{String(tx.from_address || "").toLowerCase() === address.address.toLowerCase() ? "Sent" : String(tx.to_address || "").toLowerCase() === address.address.toLowerCase() ? "Received" : "Related"}</td>
                <td><ExplorerLink network={network.network} hash={tx.tx_hash} /></td>
                <td>{tx.balmz_contract_match ? "Configured BALMZ contract" : "No configured match"}</td>
              </tr>)}</tbody>
            </table></div>}

          <h3>Historical approvals ({(address.approvals || []).length})</h3>
          {!address.approvals?.length ? <p className="muted">No approval records on this page.</p> :
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 700 }}>
              <thead><tr><th>Token contract</th><th>Spender</th><th>Historical approved amount</th><th>Current allowance</th><th>Transaction</th></tr></thead>
              <tbody>{address.approvals.map((approval, index) => <tr key={(approval.tx_hash || "approval") + ":" + (approval.log_index || index)}>
                <td>{approval.token_contract_address}</td>
                <td>{approval.spender_address}</td>
                <td>{approval.amount_raw} raw units</td>
                <td>{approval.current_allowance_raw === null ? "Not verified" : approval.current_allowance_raw + " raw units (" + approval.current_allowance_status.replaceAll("_", " ") + ")"}</td>
                <td><ExplorerLink network={network.network} hash={approval.tx_hash} /></td>
              </tr>)}</tbody>
            </table></div>}
          {address.allowance_checks_truncated && <p className="muted">Current allowance checks were capped at 50 unique token/spender pairs for this address. History remains paginated.</p>}
          {address.warnings?.map((warning, index) => <p className="security-note" key={index}>{warning}</p>)}
          {address.pagination?.has_more && <p className="muted">More records are available. Select “Load next page”.</p>}
        </div>)}
      </Panel>)}

      <Panel title="BALMZ claim readiness">
        <strong>Not established · Claim execution disabled</strong>
        <p className="muted">{data.claim_readiness?.reason}</p>
        <p className="security-note">Transfers and approval permissions are not proof of an unclaimed allocation. One-signature batch claims remain unavailable until each network's verified claim contract, allocation source, replay protection and wallet execution path are reviewed.</p>
      </Panel>
      <p className="muted">{data.warning}</p>
    </>}

    {!data && !error && <Panel title="No scan has been run" note="This tool does not request a seed phrase or private key, change allowances, sign messages, or submit blockchain transactions. Select a network scope and run the read-only scan." />}
  </section>;
}
