import { useMemo, useState } from "react";
import { signPreparedSolanaDelivery } from "./solana-delivery-wallet.js";
import "./BalmzDeliveryConsole.css";

async function readResponse(response, fallback) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || fallback);
  return data;
}

export default function BalmzDeliveryConsole({
  accessToken,
  apiBaseUrl,
  allocations = [],
  recipientAddresses = [],
  authHeaders,
}) {
  const [allocationId, setAllocationId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [preview, setPreview] = useState(null);
  const [queue, setQueue] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const safeAllocations = useMemo(() => Array.isArray(allocations) ? allocations : [], [allocations]);
  const safeRecipients = useMemo(() => Array.isArray(recipientAddresses) ? recipientAddresses : [], [recipientAddresses]);

  async function request(path, options = {}) {
    const headers = await authHeaders(accessToken, options.body ? { "Content-Type": "application/json" } : {});
    const response = await fetch(apiBaseUrl + path, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      cache: "no-store",
    });
    return readResponse(response, "The BALMZ delivery request could not be completed.");
  }

  async function prepare() {
    if (!allocationId) return setError("Select a settled allocation first.");
    if (!recipient || !safeRecipients.includes(recipient)) return setError("Select an explicitly verified Solana Mainnet recipient address.");
    setBusy("prepare"); setError(""); setNotice(""); setPreview(null);
    try {
      const result = await request("/api/v1/balmz/presale/delivery/prepare", {
        method: "POST",
        body: JSON.stringify({ allocation_id: allocationId, recipient_address: recipient }),
      });
      setPreview(result);
      setNotice("Unsigned delivery preview created. No token was signed or transferred.");
    } catch (err) {
      setError(err.message || "Could not prepare this BALMZ delivery.");
    } finally { setBusy(""); }
  }

  async function refreshQueue() {
    setBusy("queue"); setError(""); setNotice("");
    try {
      const result = await request("/api/v1/admin/balmz/presale/deliveries?state=active&limit=50");
      setQueue(result.deliveries || []);
      setNotice("Admin delivery queue refreshed.");
    } catch (err) {
      setError(err.message || "Admin delivery queue is unavailable.");
    } finally { setBusy(""); }
  }

  async function approve(delivery) {
    setBusy("approve:" + delivery.delivery_id); setError(""); setNotice("");
    try {
      await request("/api/v1/admin/balmz/presale/delivery/" + encodeURIComponent(delivery.delivery_id) + "/approve", { method: "POST" });
      setNotice("Exact transaction digest approved. A wallet signature is still required.");
      await refreshQueue();
    } catch (err) {
      setError(err.message || "Delivery approval failed.");
    } finally { setBusy(""); }
  }

  async function signAndSubmit(delivery) {
    setBusy("sign:" + delivery.delivery_id); setError(""); setNotice("");
    try {
      const signed = await signPreparedSolanaDelivery({
        unsignedTransactionBase64: delivery.unsigned_transaction_base64,
        expectedAuthority: delivery.authority_address,
      });
      const result = await request(
        "/api/v1/admin/balmz/presale/delivery/" + encodeURIComponent(delivery.delivery_id) + "/submit",
        { method: "POST", body: JSON.stringify({ signed_transaction_base64: signed.signedTransactionBase64 }) },
      );
      setNotice("Wallet-signed transaction submitted once: " + result.tx_signature);
      await refreshQueue();
    } catch (err) {
      setError(err.message || "Wallet signing or delivery submission failed.");
    } finally { setBusy(""); }
  }

  async function reconcile(delivery) {
    setBusy("reconcile:" + delivery.delivery_id); setError(""); setNotice("");
    try {
      const result = await request("/api/v1/balmz/presale/delivery/" + encodeURIComponent(delivery.delivery_id));
      setNotice("Finalized delivery state: " + result.state + (result.tx_signature ? " · " + result.tx_signature : ""));
      await refreshQueue();
    } catch (err) {
      setError(err.message || "Finalized delivery reconciliation failed.");
    } finally { setBusy(""); }
  }

  return (
    <section className="panel balmz-delivery-console">
      <div className="panel-head">
        <div><h2>Non-custodial BALMZ-SOL delivery</h2><span>Explicit recipient selection · exact-message wallet signing · finalized reconciliation</span></div>
        <span className="balmz-delivery-closed">Release gates remain closed by default</span>
      </div>

      <div className="balmz-delivery-buyer">
        <h3>Prepare a settled allocation</h3>
        <p>Select the allocation and recipient yourself. Only fresh ownership-verified Mainnet addresses are accepted by the backend.</p>
        {safeAllocations.length ? <>
          <label>Settled allocation
            <select value={allocationId} onChange={event => { setAllocationId(event.target.value); setPreview(null); }}>
              <option value="">Choose an allocation</option>
              {safeAllocations.map(item => <option key={item.allocation_id} value={item.allocation_id}>
                {item.allocation_id} · {item.token_amount} BALMZ-SOL
              </option>)}
            </select>
          </label>
          <label>Recipient Solana Mainnet wallet
            <select value={recipient} onChange={event => setRecipient(event.target.value)}>
              <option value="">Select recipient explicitly</option>
              {safeRecipients.map(address => <option key={address} value={address}>{address}</option>)}
            </select>
          </label>
          <button type="button" className="primary" disabled={Boolean(busy) || !allocationId || !recipient} onClick={prepare}>
            {busy === "prepare" ? "Preparing…" : "Prepare unsigned delivery"}
          </button>
        </> : <p className="balmz-delivery-muted">No settled allocations are available for this account.</p>}
        {preview && <div className="balmz-delivery-preview">
          <b>Unsigned preview: {preview.delivery_id}</b>
          <span>{preview.amount_tokens} BALMZ-SOL · {preview.recipient_address}</span>
          <span>Message SHA-256: <code>{preview.message_sha256}</code></span>
          <span>Estimated fee: {preview.estimated_network_fee_lamports ?? "See server fee ceiling"} lamports</span>
          <span>No signature or broadcast has occurred. An administrator must review and sign with the configured distribution wallet.</span>
        </div>}
      </div>

      <div className="balmz-delivery-admin">
        <div className="balmz-delivery-admin-head">
          <div><h3>Administrator signing queue</h3><p>Visible only to the configured World Wallet AI administrator.</p></div>
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={refreshQueue}>{busy === "queue" ? "Loading…" : "Refresh admin queue"}</button>
        </div>
        {queue.map(delivery => <article className="balmz-delivery-item" key={delivery.delivery_id}>
          <div><b>{delivery.delivery_id}</b><span>{delivery.state} · {Number(delivery.amount_base_units) / 1e9} BALMZ-SOL</span><span>Recipient: {delivery.recipient_address}</span><span>Digest: <code>{delivery.message_sha256}</code></span></div>
          <div className="balmz-delivery-actions">
            {delivery.state === "prepared" && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => approve(delivery)}>{busy === "approve:" + delivery.delivery_id ? "Approving…" : "Approve exact message"}</button>}
            {delivery.state === "approved" && <button type="button" className="primary" disabled={Boolean(busy) || !delivery.unsigned_transaction_base64} onClick={() => signAndSubmit(delivery)}>{busy === "sign:" + delivery.delivery_id ? "Waiting for wallet…" : "Sign and submit once"}</button>}
            {(delivery.state === "submitted" || delivery.state === "reconciliation_required") && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => reconcile(delivery)}>{busy === "reconcile:" + delivery.delivery_id ? "Checking…" : "Verify finalized delivery"}</button>}
            {delivery.tx_signature && <a href={"https://explorer.solana.com/tx/" + encodeURIComponent(delivery.tx_signature)} target="_blank" rel="noreferrer">Open Solana Explorer</a>}
          </div>
        </article>)}
        {!queue.length && <p className="balmz-delivery-muted">Refresh the queue to load pending deliveries. Non-admin accounts will not be allowed to read it.</p>}
      </div>

      {error && <div className="feature-error" role="alert">{error}</div>}
      {notice && <div className="security-note" role="status">{notice}</div>}
      <p className="balmz-delivery-footnote">The browser asks the connected Solana wallet to sign. The backend never receives a private key, never modifies the approved message, and never retries an ambiguous broadcast.</p>
    </section>
  );
}
