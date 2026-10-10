import { useMemo, useState } from "react";

const shortcuts = [
  { label: "Etherscan", detail: "Ethereum mainnet explorer", url: "https://etherscan.io/" },
  { label: "Sepolia", detail: "Ethereum testnet explorer", url: "https://sepolia.etherscan.io/" },
  { label: "BscScan", detail: "BNB Chain explorer", url: "https://bscscan.com/" },
  { label: "CoinGecko", detail: "Crypto market data", url: "https://www.coingecko.com/" },
  { label: "WalletConnect", detail: "Wallet connection tools", url: "https://walletconnect.com/" },
  { label: "Google", detail: "Search the web", url: "https://www.google.com/" },
];

function normalizeDestination(value) {
  const text = value.trim();
  if (!text) return "";
  if (/^(0x[a-fA-F0-9]{40})$/.test(text)) return "https://etherscan.io/address/" + text;
  if (/^(0x[a-fA-F0-9]{64})$/.test(text)) return "https://etherscan.io/tx/" + text;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(text) && !/\s/.test(text)) return "https://" + text;
  return "https://www.google.com/search?q=" + encodeURIComponent(text);
}

export default function BrowserPage({ onNavigateLogin }) {
  const [address, setAddress] = useState("https://etherscan.io/");
  const [currentUrl, setCurrentUrl] = useState("https://etherscan.io/");
  const [history, setHistory] = useState(["https://etherscan.io/"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [frameError, setFrameError] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const secureHost = useMemo(() => {
    try { return new URL(currentUrl).hostname.replace(/^www\./, ""); } catch { return "Search"; }
  }, [currentUrl]);

  function navigate(value) {
    const nextUrl = normalizeDestination(value);
    if (!nextUrl) return;
    try {
      const parsed = new URL(nextUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) return;
    } catch { return; }
    setAddress(nextUrl);
    setCurrentUrl(nextUrl);
    setFrameError(false);
    setHistory(previous => [...previous.slice(0, historyIndex + 1), nextUrl]);
    setHistoryIndex(previous => previous + 1);
  }

  function goBack() {
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    setHistoryIndex(index);
    setCurrentUrl(history[index]);
    setAddress(history[index]);
    setFrameError(false);
  }

  function goForward() {
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    setHistoryIndex(index);
    setCurrentUrl(history[index]);
    setAddress(history[index]);
    setFrameError(false);
  }

  function openExternal() {
    window.open(currentUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="content feature-content browser-page">
      <div className="page-heading browser-heading">
        <div><p className="eyebrow">WORLD WALLET AI • WEB3 WORKSPACE</p><h1>Browser</h1><p className="muted">Search the web, explore blockchain data, and open connected tools alongside your wallet.</p></div>
        <button className="secondary" onClick={onNavigateLogin}>Account / Sign in</button>
      </div>

      <article className="panel browser-panel">
        <div className="browser-toolbar">
          <button className="browser-icon-button" type="button" onClick={goBack} disabled={historyIndex <= 0} aria-label="Back">←</button>
          <button className="browser-icon-button" type="button" onClick={goForward} disabled={historyIndex >= history.length - 1} aria-label="Forward">→</button>
          <button className="browser-icon-button" type="button" onClick={() => { setFrameError(false); setCurrentUrl(value => value); }} aria-label="Refresh">↻</button>
          <form className="browser-address-form" onSubmit={event => { event.preventDefault(); navigate(address); }}>
            <span className="browser-lock">⌑</span>
            <input aria-label="Search or enter website" value={address} onChange={event => setAddress(event.target.value)} placeholder="Search Google or enter website / address" autoCapitalize="none" autoCorrect="off" spellCheck="false" />
            <button className="primary" type="submit">Go</button>
          </form>
          <button className="secondary browser-open-button" type="button" onClick={openExternal}>Open tab ↗</button>
        </div>

        <div className="browser-site-meta"><span className="browser-live-dot" /> <b>{secureHost}</b><span>Embedded web view</span><button type="button" onClick={() => setShowHelp(value => !value)}>{showHelp ? "Hide tips" : "Browser tips"}</button></div>
        {showHelp && <div className="browser-help"><b>When a page will not load here</b><p>Some sites, including many sign-in pages and blockchain explorers, block embedded views or require first-party cookies. Use <b>Open tab ↗</b> to use the full website in your browser. Signing in to Etherscan happens on Etherscan itself; World Wallet AI does not receive or store your Etherscan password.</p></div>}

        <div className="browser-shortcuts" aria-label="Quick websites">
          {shortcuts.map(site => <button type="button" key={site.label} onClick={() => navigate(site.url)} className={secureHost.includes(site.label.toLowerCase()) ? "browser-shortcut selected" : "browser-shortcut"}><b>{site.label}</b><small>{site.detail}</small></button>)}
        </div>

        <div className="browser-frame-wrap">
          <iframe
            key={currentUrl}
            title={"World Wallet AI Browser: " + secureHost}
            src={currentUrl}
            className="browser-frame"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-forms allow-scripts allow-popups allow-popups-to-escape-sandbox"
            onError={() => setFrameError(true)}
            allow="clipboard-read; clipboard-write"
          />
          {frameError && <div className="browser-frame-notice"><b>This site cannot be displayed inside the wallet.</b><p>Open it in a full browser tab to continue. Some websites deliberately block embedding.</p><button className="primary" type="button" onClick={openExternal}>Open {secureHost} ↗</button></div>}
        </div>
        <div className="browser-footer"><span>Current site: <b>{currentUrl}</b></span><button type="button" className="secondary" onClick={openExternal}>Open in full browser ↗</button></div>
      </article>

      <div className="browser-security-note"><b>Security:</b> Never enter your wallet recovery phrase or private key into a website. Website login sessions are managed by that website. Wallet connection and transaction signing require a supported wallet connection and your explicit approval.</div>
    </section>
  );
}
