import { useEffect, useState } from "react";
import { authClient } from "./auth-client.js";

export default function AccountPasswordSecurity({ accountEmail = "", accessToken, apiBaseUrl, onLogout }) {
  const [receiverEmail, setReceiverEmail] = useState("");
  const [receiverVerified, setReceiverVerified] = useState(false);
  const [receiverCodeSent, setReceiverCodeSent] = useState(false);
  const [receiverCode, setReceiverCode] = useState("");
  const [passwordCodeSent, setPasswordCodeSent] = useState(false);
  const [passwordCode, setPasswordCode] = useState("");
  const [passwordGrant, setPasswordGrant] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function securityRequest(path, body) {
    const response = await fetch(String(apiBaseUrl || "").replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Account security request failed.");
    return data;
  }

  useEffect(() => {
    if (!accessToken || !apiBaseUrl) return undefined;
    let active = true;
    securityRequest("/api/v1/auth/neon/account-security/receiver-email/status")
      .then(data => {
        if (!active) return;
        setReceiverEmail(data.receiver_email || "");
        setReceiverVerified(Boolean(data.verified));
      })
      .catch(err => {
        if (active) setError(err.message || "Receiver Gmail status could not be loaded.");
      });
    return () => { active = false; };
  }, [accessToken, apiBaseUrl]);

  async function sendReceiverCode() {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await securityRequest("/api/v1/auth/neon/account-security/receiver-email/request", { receiver_email: receiverEmail });
      setReceiverEmail(data.receiver_email || receiverEmail.trim().toLowerCase());
      setReceiverCodeSent(true);
      setReceiverCode("");
      setMessage("The first genuine six-digit code was sent to your separate receiver Gmail. It expires in five minutes.");
    } catch (err) { setError(err.message || "Could not send the receiver-Gmail code."); }
    finally { setBusy(false); }
  }

  async function verifyReceiverCode() {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await securityRequest("/api/v1/auth/neon/account-security/receiver-email/verify", { code: receiverCode.trim() });
      setReceiverEmail(data.receiver_email || receiverEmail);
      setReceiverVerified(true);
      setReceiverCodeSent(false);
      setReceiverCode("");
      setMessage("Receiver Gmail verified. You can now start the password-change step.");
    } catch (err) { setError(err.message || "Receiver-Gmail verification failed."); }
    finally { setBusy(false); }
  }

  async function sendPasswordCode() {
    setError(""); setMessage("");
    if (currentPassword.length === 0) { setError("Enter your current BALMZ AI password to confirm your account."); return; }
    if (newPassword.length < 8) { setError("Use a new password with at least eight characters."); return; }
    if (newPassword !== confirmPassword) { setError("The new password entries do not match."); return; }
    setBusy(true);
    try {
      const data = await securityRequest("/api/v1/auth/neon/account-security/password-change/request", {});
      setPasswordCodeSent(true);
      setPasswordCode("");
      setPasswordGrant("");
      setMessage("The second, separate password-change code was sent to " + (data.receiver_email || receiverEmail) + ". It expires in five minutes.");
    } catch (err) { setError(err.message || "Could not send the password-change code."); }
    finally { setBusy(false); }
  }

  async function verifyPasswordCode() {
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await securityRequest("/api/v1/auth/neon/account-security/password-change/verify", { code: passwordCode.trim() });
      setPasswordGrant(data.grant_token || "");
      setPasswordCodeSent(false);
      setPasswordCode("");
      if (!data.grant_token) throw new Error("The backend did not issue a one-time password-change authorization.");
      setMessage("Second code verified. Confirm the change to update your BALMZ AI account password.");
    } catch (err) { setPasswordGrant(""); setError(err.message || "Password-change verification failed."); }
    finally { setBusy(false); }
  }

  async function changeAccountPassword() {
    setBusy(true); setError(""); setMessage("");
    let passwordUpdated = false;
    try {
      if (!passwordGrant) throw new Error("Verify the second code sent to your receiver Gmail first.");
      if (!currentPassword) throw new Error("Enter your current BALMZ AI password.");
      if (newPassword.length < 8) throw new Error("Use a new password with at least eight characters.");
      if (newPassword !== confirmPassword) throw new Error("The new password entries do not match.");

      const signInResult = await authClient.signIn.email({
        email: String(accountEmail || "").trim().toLowerCase(),
        password: currentPassword,
      });
      if (signInResult?.error) throw new Error(signInResult.error.message || "Your current account password was not accepted.");

      await securityRequest("/api/v1/auth/neon/account-security/password-change/complete", { grant_token: passwordGrant });
      setPasswordGrant("");

      const changeResult = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (changeResult?.error) throw new Error(changeResult.error.message || "Neon Auth could not update your password.");
      passwordUpdated = true;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordCodeSent(false);
      setMessage("Your BALMZ AI account password was changed successfully. Other active Neon Auth sessions were revoked. Sign in again with your new password.");
      if (typeof onLogout === "function") await onLogout();
      else await authClient.signOut().catch(() => {});
    } catch (err) {
      if (passwordUpdated) {
        setPasswordGrant("");
        setError("Your password was changed in Neon Auth, but BALMZ AI could not record the final verification receipt. Sign in with your new password and contact support if this message remains.");
        if (typeof onLogout === "function") await onLogout();
        else try { await authClient.signOut(); } catch {}
      } else {
        setError(err.message || "The BALMZ AI account password could not be changed.");
      }
    } finally { setBusy(false); }
  }

  return <article className="panel action-panel">
    <div className="panel-head"><div><h2>Account security &amp; password</h2><span>Two separate one-time codes are delivered to your alternate Gmail</span></div></div>
    <p className="muted">Your login Gmail remains the account identity. The receiver Gmail must be a different mailbox. BALMZ AI verifies both codes, while Neon Auth securely stores and changes your BALMZ AI account password.</p>
    {!receiverVerified ? <>
      <label>Separate receiver Gmail<input type="email" value={receiverEmail} onChange={event => setReceiverEmail(event.target.value)} placeholder="another-address@gmail.com" autoComplete="email" disabled={receiverCodeSent || busy} /></label>
      <button type="button" className="secondary" disabled={busy || !/^[^\s@]+@(?:gmail\.com|googlemail\.com)$/i.test(receiverEmail.trim()) || receiverCodeSent} onClick={sendReceiverCode}>{busy ? "Sending…" : "Send first verification code"}</button>
      {receiverCodeSent && <>
        <label>First code — verify receiver Gmail<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={receiverCode} onChange={event => setReceiverCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Enter six-digit code" /></label>
        <div className="page-actions"><button type="button" className="secondary" disabled={busy || receiverCode.length !== 6} onClick={verifyReceiverCode}>{busy ? "Verifying…" : "Verify receiver Gmail"}</button><button type="button" className="text-btn" disabled={busy} onClick={sendReceiverCode}>Send a new code</button></div>
      </>}
    </> : <>
      <div className="security-note">Verified receiver Gmail: <strong>{receiverEmail}</strong>. Both verification codes are sent to this mailbox. Changing it requires account recovery.</div>
      <h3>Change your password</h3>
      <label>Current BALMZ AI password<input type="password" value={currentPassword} onChange={event => { setCurrentPassword(event.target.value); setPasswordGrant(""); }} autoComplete="current-password" placeholder="Confirm your current account password" /></label>
      <label>New BALMZ AI password<input type="password" value={newPassword} onChange={event => { setNewPassword(event.target.value); setPasswordGrant(""); }} autoComplete="new-password" minLength={8} placeholder="At least eight characters" /></label>
      <label>Confirm new password<input type="password" value={confirmPassword} onChange={event => { setConfirmPassword(event.target.value); setPasswordGrant(""); }} autoComplete="new-password" minLength={8} placeholder="Re-enter your new password" /></label>
      <button type="button" className="secondary" disabled={busy || passwordCodeSent || Boolean(passwordGrant)} onClick={sendPasswordCode}>{busy ? "Sending…" : "Send second password-change code"}</button>
      {passwordCodeSent && <>
        <label>Second code — authorize password change<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={passwordCode} onChange={event => setPasswordCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Enter the second six-digit code" /></label>
        <div className="page-actions"><button type="button" className="secondary" disabled={busy || passwordCode.length !== 6} onClick={verifyPasswordCode}>{busy ? "Verifying…" : "Verify second code"}</button><button type="button" className="text-btn" disabled={busy} onClick={sendPasswordCode}>Send a new code</button></div>
      </>}
      {passwordGrant && <button type="button" className="primary feature-submit" disabled={busy} onClick={changeAccountPassword}>{busy ? "Updating password…" : "Confirm and change password →"}</button>}
    </>}
    {message && <div className="feature-success" role="status">{message}</div>}
    {error && <div className="feature-error" role="alert">{error}</div>}
    <div className="security-note">Never enter your Google/Gmail password here. This form changes only your BALMZ AI account password. Email-only or social-login accounts without a password need a separate account setup flow.</div>
  </article>;
}
