import React from "react";

const NETWORKS = [
  { key: "ethereum", symbol: "BALMZ", name: "Ethereum Mainnet", allocation: "10B distribution + 1B reserve", balanceKey: "BALMZ" },
  { key: "bnb", symbol: "BALMZ-BNB", name: "BNB Chain Mainnet", allocation: "10B allocation", balanceKey: "BALMZ-BNB" },
  { key: "solana_mainnet", symbol: "BALMZ-SOL", name: "Solana Mainnet", allocation: "10B allocation", balanceKey: "BALMZ-SOL" },
];

const logoUrl = "https://raw.githubusercontent.com/PWFB/world-wallet-ai/assets/balmz-solana-devnet-logo/tools/balmz-solana-devnet/balmz-logo.png";

function formatAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Unavailable";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(amount);
}

function networkRecord(records, network, symbol) {
  return records.find(item => item.network === network && (item.symbol === symbol || (network === "bnb" && item.symbol === "BALMZ")));
}

export default function BalmzDashboardPanel({ tokenRegistry = [], verifiedBalancesByAsset = new Map() }) {
  const records = Array.isArray(tokenRegistry) ? tokenRegistry : [];
  return (
    <article className="panel balmz-dashboard-panel" aria-labelledby="balmz-dashboard-title" style={{ gridColumn: "1 / -1", padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
        <img src={logoUrl} alt="BALMZ token logo" width="48" height="48" style={{ objectFit: "contain", borderRadius: "50%" }} onError={event => { event.currentTarget.style.display = "none"; }} />
        <div style={{ flex: "1 1 220px" }}>
          <span className="feature-kicker">WORLD WALLET TOKEN</span>
          <h2 id="balmz-dashboard-title" style={{ margin: "3px 0" }}>BALMZ</h2>
          <p style={{ margin: 0, color: "var(--muted,#8192a9)", fontSize: 12 }}>Multi-chain token · Ethereum · BNB Chain · Solana</p>
        </div>
        <span className="badge badge-warning" style={{ padding: "6px 10px", borderRadius: 20 }}>PRE-LAUNCH</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12, marginBottom: 16 }}>
        <div className="stat-card">
          <span>Global maximum allocation</span>
          <strong>31,000,000,000</strong>
          <b className="neutral">BALMZ · approved plan</b>
          <div className="stat-source">Allocation target, not a claim of minted or circulating supply.</div>
        </div>
        {NETWORKS.map(network => {
          const registry = networkRecord(records, network.key, network.symbol);
          const configured = Boolean(registry?.contract_address && registry?.status === "active");
          const balance = verifiedBalancesByAsset?.get?.(network.balanceKey);
          return (
            <div className="stat-card" key={network.key}>
              <span>{network.name}</span>
              <strong>{balance ? formatAmount(balance.available_balance) : "Unavailable"} <small>{network.symbol}</small></strong>
              <b className="neutral">{balance?.status || (configured ? "Contract configured · balance not verified" : "Mainnet contract or mint not configured")}</b>
              <div className="stat-source">{network.allocation}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ margin: 0, color: "var(--muted,#8192a9)", fontSize: 12, lineHeight: 1.5 }}>
          Sepolia and Solana Devnet are test networks and are excluded from the 31B Mainnet allocation and verified Mainnet balances. No BALMZ market price is shown until a verified market quote exists.
        </p>
      </div>
    </article>
  );
}
