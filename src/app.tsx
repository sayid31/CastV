import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './components/Icon';
import { SenderConsole } from './components/SenderConsole';
import './desktop.css';

function App() {
  const [version, setVersion] = useState('');

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => { if (data?.version) setVersion(String(data.version)); })
      .catch(() => { /* version chip stays hidden */ });
  }, []);

  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-bar-brand">
          <span className="app-mark"><span /><span /><span /></span>
          <span className="app-brand-text">Cast<em>V</em></span>
        </div>
      </header>

      <main className="stage">
        <div className="stage-inner">
          <div className="stage-intro">
            <h1>Berbagi layar PC</h1>
            <p>Pilih perangkat receiver, lalu tentukan layar yang ingin dikirim ke TV atau browser.</p>
          </div>

          <SenderConsole />
        </div>
      </main>

      <footer className="app-foot">
        <span>CastV{version ? ` v${version}` : ''}</span>
        <i />
        <span>AirPlay · HLS</span>
        <i />
        <span>Koneksi lokal</span>
        <i />
        <span>Tidak ada data yang diunggah</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
