import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

const App = React.lazy(() => import('./App.jsx'))

class AppRecoveryBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, message: '' }
  }

  static getDerivedStateFromError(error) {
    return { failed: true, message: error?.message || 'The application could not start.' }
  }

  componentDidCatch(error) {
    console.error('[World Wallet AI] React failed to render:', error)
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main style={{
        minHeight: '100vh', padding: 'clamp(24px, 6vw, 72px)',
        display: 'grid', placeItems: 'center', color: '#f4f7fb',
        background: 'radial-gradient(circle at 80% 10%, rgba(255,107,0,.14), transparent 34%), #070d1d',
        fontFamily: 'Inter, system-ui, sans-serif'
      }}>
        <section style={{
          width: 'min(720px, 100%)', padding: 'clamp(24px, 5vw, 48px)',
          border: '1px solid #243650', borderRadius: 22,
          background: 'rgba(12,23,41,.96)', boxShadow: '0 24px 80px rgba(0,0,0,.28)'
        }}>
          <div style={{ color: '#ff7a18', fontSize: 12, fontWeight: 800, letterSpacing: 2 }}>WORLD WALLET AI</div>
          <h1 style={{ fontSize: 'clamp(34px, 7vw, 58px)', lineHeight: 1.08, margin: '22px 0 16px' }}>
            Your Crypto.<br /><span style={{ color: '#ff7a18' }}>Your Freedom.</span>
          </h1>
          <p style={{ color: '#a8b7cb', lineHeight: 1.8, maxWidth: 560 }}>
            The wallet application could not start correctly. This recovery screen keeps the page usable and shows the startup error below instead of leaving a blank blue screen.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 28 }}>
            <button onClick={() => window.location.reload()} style={{
              padding: '13px 18px', borderRadius: 10, border: 0,
              background: '#ff7a18', color: '#111827', fontWeight: 800, cursor: 'pointer'
            }}>Reload wallet</button>
            <button onClick={() => {
              try { sessionStorage.setItem('world_wallet_show_login', '1') } catch {}
              window.location.reload()
            }} style={{
              padding: '13px 18px', borderRadius: 10, border: '1px solid #344863',
              background: '#101e33', color: '#f4f7fb', fontWeight: 700, cursor: 'pointer'
            }}>Try sign in</button>
          </div>
          <details style={{ marginTop: 26, color: '#8295ae', fontSize: 12 }}>
            <summary style={{ cursor: 'pointer' }}>Technical details</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#ffb4a0' }}>{this.state.message}</pre>
          </details>
        </section>
      </main>
    )
  }
}

function StartupFallback() {
  return <main style={{
    minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24,
    color: '#f4f7fb', background: '#070d1d', fontFamily: 'Inter, system-ui, sans-serif'
  }}><p role="status">Loading World Wallet AI…</p></main>
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppRecoveryBoundary>
      <React.Suspense fallback={<StartupFallback />}>
        <App />
      </React.Suspense>
    </AppRecoveryBoundary>
  </React.StrictMode>,
)
