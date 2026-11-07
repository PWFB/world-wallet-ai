import { useState } from "react";

function DataRow({ label, value, mono = false }) {
  return <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, 0.8fr) minmax(0, 1.2fr)", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--border, #26334d)" }}>
    <span style={{ color: "var(--muted, #9aa8c2)", fontSize: 13 }}>{label}</span>
    <strong style={{ fontSize: 13, overflowWrap: "anywhere", fontFamily: mono ? "monospace" : "inherit" }}>{value ?? "Unavailable"}</strong>
  </div>;
}

function Status({ value }) {
  return <span style={{ display: "inline-block", borderRadius: 20, padding: "4px 9px", background: value ? "#123b2b" : "#3b2b16", color: value ? "#8de0b3" : "#ffd08a", fontSize: 11, fontWeight: 700 }}>{value ? "MATCH" : "NOT VERIFIED"}</span>;
}

export default function OKXWalletInspector({ accessToken, apiBaseUrl }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function inspect() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallet/erc7702-inspection", {
        method: "GET",
        headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || "Unable to inspect the active wallet.");
      setData(result);
    } catch (err) {
      setError(err.message || "Read-only inspection failed.");
      setData(null);
    } finally {
      setBusy(false);
    }
  }

  const card = { background: "var(--panel, #111a2d)", border: "1px solid var(--border, #26334d)", borderRadius: 14, padding: 18 };
  const storage = data?.storage || {};

  return <section className="content feature-content">
    <div className="page-heading">
      <div><p className="eyebrow">WORLD WALLET AI · READ-ONLY SECURITY</p><h1>OKX Wallet Inspector</h1>
        <p className="muted">Inspect Ethereum Mainnet EIP-7702 delegation and wallet storage without connecting or signing.</p>
      </div>
      <button type="button" className="primary" disabled={busy || !accessToken} onClick={inspect}>{busy ? "Inspecting…" : "Inspect active wallet"}</button>
    </div>
    <div style={{ ...card, marginBottom: 16 }}>
      <strong>Read-only boundary</strong>
      <p className="muted" style={{ marginBottom: 0 }}>This page calls the authenticated backend, which reads public Ethereum RPC data only. It does not request wallet connection, signatures, approvals, delegation changes, or transfers.</p>
    </div>
    {error && <div role="alert" style={{ ...card, borderColor: "#a44", color: "#ff9b9b", marginBottom: 16 }}>{error}</div>}
    {data && <>
      <div style={{ ...card, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Delegation</h2>
        <DataRow label="Network" value={"Ethereum Mainnet · Chain ID " + data.chain_id} />
        <DataRow label="Owner / wallet address" value={data.owner_address} mono />
        <DataRow label="EIP-7702 delegated" value={data.delegated ? "Yes" : "No"} />
        <DataRow label="Delegation target" value={data.delegation_target} mono />
        <DataRow label="Target runtime code" value={data.delegation_target_code_bytes === null ? "Unavailable" : data.delegation_target_code_bytes + " bytes"} />
        <DataRow label="Known legacy OKX WalletCore target" value={<Status value={data.known_okx_walletcore} />} />
      </div>
      <div style={{ ...card, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Wallet storage</h2>
        <DataRow label="getMainStorage() result" value={String(storage.status || "unknown").replaceAll("_", " ")} />
        <DataRow label="Storage contract" value={storage.address} mono />
        <DataRow label="Storage runtime code" value={storage.code_bytes === undefined ? "Unavailable" : storage.code_bytes + " bytes"} />
        <DataRow label="Proxy implementation" value={storage.proxy?.implementation} mono />
        <DataRow label="Known OKX storage implementation" value={storage.implementation_known_okx === undefined ? "Not verified" : <Status value={storage.implementation_known_okx} />} />
        <DataRow label="Embedded owner matches wallet" value={storage.embedded_owner_matches === undefined ? "Not verified" : <Status value={storage.embedded_owner_matches} />} />
        {storage.reason && <DataRow label="Call limitation" value={storage.reason} />}
      </div>
      <div style={card}><h2 style={{ marginTop: 0 }}>Inspection note</h2><p className="muted" style={{ marginBottom: 0 }}>{data.inspection}</p></div>
    </>}
    {!data && !error && <div style={card}><p className="muted" style={{ margin: 0 }}>Select “Inspect active wallet” to read the active wallet's Ethereum delegation and storage state. No balances are changed or fabricated.</p></div>}
  </section>;
}
