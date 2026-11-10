import { useCallback, useEffect, useMemo, useState } from "react";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", webp: "image/webp",
};

const ISSUE_OPTIONS = [
  ["deposit_missing", "Deposit not received"],
  ["deposit_delayed", "Deposit delayed"],
  ["withdrawal_delayed", "Withdrawal delayed"],
  ["transfer_not_received", "Transfer not received"],
  ["wrong_network", "Wrong network"],
  ["amount_mismatch", "Amount mismatch"],
  ["fee_issue", "Fee / network charge issue"],
  ["duplicate_charge", "Duplicate charge"],
  ["other", "Other issue"],
];

function transactionKind(type) {
  const normalized = String(type || "").toLowerCase();
  if (["received", "deposit", "deposited"].includes(normalized)) return "deposit";
  if (["withdrawal", "withdraw", "withdrawn"].includes(normalized)) return "withdrawal";
  if (["sent", "transfer", "send"].includes(normalized)) return "transfer";
  return "";
}

function readableSize(value) {
  return value >= 1024 * 1024 ? (value / (1024 * 1024)).toFixed(2) + " MB" : Math.max(1, Math.round(value / 1024)) + " KB";
}

function statusLabel(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

export default function ReceiptCenter({ accessToken = "", apiBaseUrl = "", wallet = null, setActive }) {
  const [receipts, setReceipts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [pagination, setPagination] = useState({ total: 0, has_more: false });
  const [kind, setKind] = useState("deposit");
  const [issue, setIssue] = useState("other");
  const [transactionId, setTransactionId] = useState("");
  const [reference, setReference] = useState("");
  const [network, setNetwork] = useState("");
  const [asset, setAsset] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState(null);
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [networkFilter, setNetworkFilter] = useState("all");
  const [issueFilter, setIssueFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("created_at");
  const [order, setOrder] = useState("desc");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const authHeaders = useMemo(() => ({
    Authorization: "Bearer " + accessToken,
    Accept: "application/json",
  }), [accessToken]);

  const loadReceipts = useCallback(async () => {
    if (!accessToken || !apiBaseUrl) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        limit: "100",
        offset: "0",
        kind: kindFilter,
        status: statusFilter,
        network: networkFilter,
        issue: issueFilter,
        sort,
        order,
        search: search.trim(),
      });
      const response = await fetch(apiBaseUrl + "/api/v1/wallet/receipts?" + params.toString(), {
        headers: authHeaders, cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Receipt records could not be loaded.");
      setReceipts(Array.isArray(data.receipts) ? data.receipts : []);
      setPagination(data.pagination || { total: 0, has_more: false });
    } catch (cause) {
      setError(cause?.message || "Receipt records could not be loaded.");
      setReceipts([]);
    } finally {
      setLoading(false);
    }
  }, [accessToken, apiBaseUrl, authHeaders, kindFilter, statusFilter, networkFilter, issueFilter, sort, order, search]);

  const loadTransactions = useCallback(async () => {
    if (!accessToken || !apiBaseUrl) return;
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/transactions?limit=100&offset=0", {
        headers: authHeaders, cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) setTransactions(Array.isArray(data.transactions) ? data.transactions : []);
    } catch {
      setTransactions([]);
    }
  }, [accessToken, apiBaseUrl, authHeaders]);

  useEffect(() => {
    loadReceipts();
  }, [loadReceipts]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  function chooseTransaction(id) {
    setTransactionId(id);
    const selected = transactions.find(item => String(item.id) === id);
    if (!selected) return;
    const detectedKind = transactionKind(selected.type);
    if (detectedKind) setKind(detectedKind);
    setReference(selected.reference || "");
    setNetwork(selected.network || "");
    setAsset(selected.asset || "");
  }

  function chooseFile(nextFile) {
    setError("");
    setMessage("");
    if (!nextFile) {
      setFile(null);
      return;
    }
    const extension = nextFile.name.split(".").pop().toLowerCase();
    const expectedMime = MIME_BY_EXTENSION[extension];
    const actualMime = nextFile.type || expectedMime;
    if (!expectedMime || actualMime !== expectedMime) {
      setFile(null);
      setError("Choose a PDF, PNG, JPG or WebP receipt.");
      return;
    }
    if (nextFile.size < 1 || nextFile.size > MAX_FILE_BYTES) {
      setFile(null);
      setError("Receipt file must be 1 byte to 5 MB.");
      return;
    }
    setFile(nextFile);
  }

  async function uploadReceipt(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!file) {
      setError("Choose the receipt file to upload.");
      return;
    }
    setBusy(true);
    try {
      const contentBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Receipt file could not be read."));
        reader.onload = () => {
          const result = String(reader.result || "");
          const comma = result.indexOf(",");
          if (comma < 0) return reject(new Error("Receipt file data is invalid."));
          resolve(result.slice(comma + 1));
        };
        reader.readAsDataURL(file);
      });
      const payload = {
        kind,
        issue_category: issue,
        file_name: file.name,
        content_type: file.type || MIME_BY_EXTENSION[file.name.split(".").pop().toLowerCase()],
        content_base64: contentBase64,
        transaction_id: transactionId || null,
        reference: reference.trim() || null,
        network: network || null,
        asset: asset.trim().toUpperCase() || null,
        notes: notes.trim(),
      };
      const response = await fetch(apiBaseUrl + "/api/v1/wallet/receipts", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Receipt upload failed.");
      const saved = data.receipt || {};
      setMessage("Receipt saved as " + statusLabel(saved.review_status) + ". It is evidence only; it does not confirm or settle the transaction.");
      setFile(null);
      setNotes("");
      setTransactionId("");
      setReference("");
      setAsset("");
      setNetwork("");
      const input = document.getElementById("wallet-receipt-file");
      if (input) input.value = "";
      await loadReceipts();
    } catch (cause) {
      setError(cause?.message || "Receipt upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadReceipt(receipt) {
    setDownloading(receipt.id);
    setError("");
    try {
      const response = await fetch(apiBaseUrl + "/api/v1/wallet/receipts/" + encodeURIComponent(receipt.id) + "/file", {
        headers: authHeaders, cache: "no-store",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || "Receipt file could not be downloaded.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = receipt.file_name || "wallet-receipt";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause?.message || "Receipt download failed.");
    } finally {
      setDownloading("");
    }
  }

  return <section className="content feature-content receipt-center-page">
    <div className="page-heading">
      <div><p className="eyebrow">WORLD WALLET AI · EVIDENCE DESK</p><h1>Receipts &amp; Issues</h1><p className="muted">Upload and organize deposit, withdrawal and transfer receipts for the active wallet.</p></div>
      <div className="page-actions">
        <button type="button" className="secondary" onClick={() => setActive?.("Activity Trace")}>Activity trace</button>
        <button type="button" className="secondary" onClick={loadReceipts} disabled={loading}>↻ Refresh</button>
      </div>
    </div>
    <div className="feature-grid">
      <article className="panel action-panel"><small>Total saved receipts</small><strong>{Number(pagination.total || 0).toLocaleString()}</strong><small>Current filters</small></article>
      <article className="panel action-panel"><small>Needs matching / review</small><strong>{receipts.filter(item => ["needs_matching", "reference_unmatched", "submitted", "under_review"].includes(item.review_status)).length}</strong><small>Evidence not yet resolved</small></article>
      <article className="panel action-panel"><small>Resolved</small><strong>{receipts.filter(item => item.review_status === "resolved").length}</strong><small>Review status only</small></article>
    </div>

    <article className="panel action-panel">
      <div className="panel-head"><div><h2>Upload transaction receipt</h2><span>Active wallet: {wallet?.wallet_number || wallet?.wallet_id || wallet?.id || "Loading"}</span></div><span className="presale-status-pill">Max 5 MB</span></div>
      <form onSubmit={uploadReceipt}>
        <div className="feature-grid">
          <label>Receipt type<select value={kind} onChange={event => setKind(event.target.value)}><option value="deposit">Deposit receipt</option><option value="withdrawal">Withdrawal receipt</option><option value="transfer">Transfer receipt</option></select></label>
          <label>Issue / reason<select value={issue} onChange={event => setIssue(event.target.value)}>{ISSUE_OPTIONS.map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>Link to saved transaction (optional)<select value={transactionId} onChange={event => chooseTransaction(event.target.value)}><option value="">Not linked yet</option>{transactions.map(item=><option key={item.id} value={item.id}>{item.reference || item.id} · {item.type} · {item.asset} · {item.network}</option>)}</select></label>
          <label>Transaction reference<input value={reference} onChange={event => setReference(event.target.value)} maxLength={100} placeholder="WWTX-… or external reference" /></label>
          <label>Network<input value={network} onChange={event => setNetwork(event.target.value)} maxLength={32} placeholder="ethereum, bnb, bitcoin, solana…" /></label>
          <label>Asset<input value={asset} onChange={event => setAsset(event.target.value)} maxLength={24} placeholder="ETH, BNB, BTC, BALMZ…" /></label>
        </div>
        <label>Receipt file<input id="wallet-receipt-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" onChange={event => chooseFile(event.target.files?.[0] || null)} /></label>
        {file && <p className="muted">Selected: {file.name} · {readableSize(file.size)} · {file.type}</p>}
        <label>Notes<textarea rows={3} maxLength={1200} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Describe the issue, sender, expected amount or relevant details. Do not include passwords, PINs, private keys or recovery phrases." /></label>
        {error && <div role="alert" className="feature-error">{error}</div>}
        {message && <div role="status" className="feature-success">{message}</div>}
        <button className="primary feature-submit" type="submit" disabled={busy || !file}>{busy ? "Saving receipt…" : "Upload receipt →"}</button>
      </form>
      <div className="security-note">Allowed formats: PDF, PNG, JPG and WebP. Files are stored with the active wallet record. Uploading a receipt never confirms a deposit, proves a blockchain transfer or releases a withdrawal.</div>
    </article>

    <article className="panel action-panel">
      <div className="panel-head"><div><h2>Sort and find receipts</h2><span>{pagination.total.toLocaleString()} records found under the selected filters.</span></div></div>
      <div className="feature-grid">
        <label>Search<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Reference, asset, filename or issue…" /></label>
        <label>Type<select value={kindFilter} onChange={event => setKindFilter(event.target.value)}><option value="all">All types</option><option value="deposit">Deposits</option><option value="withdrawal">Withdrawals</option><option value="transfer">Transfers</option></select></label>
        <label>Issue<select value={issueFilter} onChange={event => setIssueFilter(event.target.value)}><option value="all">All issues</option>{ISSUE_OPTIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Review status<select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="submitted">Submitted</option><option value="needs_matching">Needs matching</option><option value="reference_unmatched">Reference unmatched</option><option value="under_review">Under review</option><option value="resolved">Resolved</option><option value="rejected">Rejected</option></select></label>
        <label>Network<select value={networkFilter} onChange={event => setNetworkFilter(event.target.value)}><option value="all">All networks</option>{["ethereum","bnb","bitcoin","solana_mainnet","solana_devnet","sepolia"].map(value=><option value={value} key={value}>{value}</option>)}</select></label>
        <label>Sort by<select value={sort} onChange={event => setSort(event.target.value)}><option value="created_at">Date</option><option value="kind">Receipt type</option><option value="status">Status</option><option value="network">Network</option><option value="asset">Asset</option><option value="reference">Reference</option></select></label>
        <label>Order<select value={order} onChange={event => setOrder(event.target.value)}><option value="desc">Newest / Z–A</option><option value="asc">Oldest / A–Z</option></select></label>
      </div>
      <div className="page-actions"><button type="button" className="secondary" onClick={() => { setSearch(""); setKindFilter("all"); setStatusFilter("all"); setNetworkFilter("all"); setIssueFilter("all"); setSort("created_at"); setOrder("desc"); }}>Clear filters</button></div>
    </article>

    <article className="panel action-panel">
      <div className="panel-head"><div><h2>Saved receipt evidence</h2><span>Sorted by the server using the selected columns and order.</span></div><span className="presale-status-pill">{receipts.length} shown</span></div>
      {loading ? <div className="feature-loading">Loading wallet receipts…</div> : receipts.length ? <div className="tool-list">
        {receipts.map(item=><div className="tool-row" key={item.id}>
          <div style={{minWidth:0}}>
            <b>{item.kind.toUpperCase()} · {item.asset || "Asset not supplied"}</b>
            <small>{item.created_at ? new Date(item.created_at).toLocaleString() : "Date unavailable"} · {item.network || "Network not supplied"}</small>
            <small>Issue: {ISSUE_OPTIONS.find(option=>option[0]===item.issue_category)?.[1] || item.issue_category} · {statusLabel(item.review_status)}</small>
            <small>{item.reference || "No transaction reference"} · {item.file_name} · {readableSize(item.size_bytes)}</small>
            <small>SHA-256: <code>{item.sha256}</code></small>
            <small>Not a transaction confirmation.</small>
          </div>
          <button type="button" className="secondary" disabled={downloading===item.id} onClick={() => downloadReceipt(item)}>{downloading===item.id ? "Downloading…" : "Download receipt"}</button>
        </div>)}
      </div> : <div className="feature-empty">No receipt records match this view. Upload a receipt or change the filters.</div>}
    </article>
  </section>;
}
