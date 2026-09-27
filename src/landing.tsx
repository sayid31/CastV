import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './components/Icon';
import './landing.css';

/**
 * Repository GitHub yang menampung source code dan Release installer.
 * Ubah hanya bagian "owner/nama-repo" bila repo kamu berbeda.
 *
 * Link download memakai nama asset stabil `CastV-latest-<target>.exe`.
 * Nama itu sengaja tidak memuat nomor versi: begitu rilis baru terbit,
 * link yang sama otomatis menunjuk ke installer terbaru dan tidak pernah
 * rusak - landing page juga tidak perlu di-deploy ulang.
 */
const GITHUB_REPO = 'sayid31/CastV';

const DOWNLOAD = {
  version: __APP_VERSION__,
  installer: `https://github.com/${GITHUB_REPO}/releases/latest/download/CastV-latest-x64.exe`,
};

const FEATURES = [
  { icon: 'monitor-up', title: 'Tanpa aplikasi di TV', text: 'TV AirPlay langsung terdeteksi. Tidak perlu install, URL, atau scan QR di sisi TV.' },
  { icon: 'wifi', title: '100% jaringan lokal', text: 'Stream berjalan di Wi-Fi atau LAN kamu sendiri. Tidak ada video yang diunggah ke server mana pun.' },
  { icon: 'lock', title: 'Privat secara default', text: 'Tidak ada akun, tidak ada login, tidak ada telemetry. Tutup aplikasi dan stream pun berhenti.' },
  { icon: 'spark', title: 'Gratis dan ringan', text: 'Aplikasi desktop kecil untuk Windows 10/11. Satu file installer, tanpa biaya langganan.' },
] as const;

const STEPS = [
  { n: '01', title: 'Klik Share Screen', text: 'Buka CastV lalu klik satu tombol Share Screen.' },
  { n: '02', title: 'Pilih perangkat', text: 'Pilih TV AirPlay yang muncul otomatis di daftar nearby.' },
  { n: '03', title: 'Pilih layar', text: 'Pilih seluruh layar atau satu window, lalu streaming berjalan.' },
];

const FAQ = [
  { q: 'Apakah CastV bisa dipakai langsung dari browser?', a: 'Tidak. CastV adalah aplikasi desktop untuk Windows karena perlu akses capture layar dan AirPlay bawaan sistem. Situs ini hanya untuk mengunduh aplikasinya.' },
  { q: 'Apakah TV perlu installing aplikasi?', a: 'Tidak. CastV memakai AirPlay bawaan TV. Yang perlu diinstal hanya CastV di laptop.' },
  { q: 'Berapa besar file yang diunduh?', a: 'Sekitar 107 MB untuk installer Windows. Satu file, tanpa dependency tambahan.' },
  { q: 'Apakah laptop dan TV harus satu Wi-Fi?', a: 'Sebaiknya satu jaringan lokal atau jaringan yang saling bisa dijangkau agar perangkat ditemukan otomatis.' },
  { q: 'Kenapa ada jeda beberapa detik?', a: 'Jalur TV memakai AirPlay HLS yang menambahkan buffering di sisi TV. Jalur browser (WebRTC) jauh lebih cepat.' },
  { q: 'Apakah audio ikut terkirim ke TV?', a: 'Belum pada versi ini. Jalur AirPlay baru mengirim video. Dukungan audio direncanakan untuk pembaruan berikutnya.' },
];

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function DownloadButtons({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`dl-buttons ${compact ? 'is-compact' : ''}`}>
      <a className="dl-btn dl-btn-primary" href={DOWNLOAD.installer} download>
        <Icon name="download" size={18} />
        <span>
          <strong>Download untuk Windows</strong>
          <small>Installer .exe · Windows 10/11 x64</small>
        </span>
      </a>
    </div>
  );
}

function App() {
  return (
    <div className="site">
      <header className="site-header">
        <div className="wrap header-inner">
          <span className="logo">
            <span className="logo-mark"><i /><i /><i /></span>
            <span className="logo-text">Cast<em>V</em></span>
          </span>
          <nav className="header-nav">
            <button onClick={() => scrollToId('fitur')}>Fitur</button>
            <button onClick={() => scrollToId('cara-kerja')}>Cara kerja</button>
            <button onClick={() => scrollToId('faq')}>FAQ</button>
          </nav>
          <button className="header-cta" onClick={() => scrollToId('download')}>
            <Icon name="download" size={15} /> Download
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <span className="pill"><span className="pill-dot" /> Gratis · Windows · tanpa akun</span>
              <h1>Tampilkan layar PC ke TV <em>tanpa aplikasi tambahan.</em></h1>
              <p>
                CastV menemukan TV yang mendukung AirPlay di Wi-Fi yang sama, lalu mengirim layar PC
                kamu langsung ke sana. Tidak ada install di TV, tidak ada URL, tidak ada QR.
              </p>
              <DownloadButtons />
              <div className="hero-facts">
                <span><Icon name="check" size={14} /> Delay beberapa detik</span>
                <span><Icon name="check" size={14} /> Video H.264 1080p</span>
                <span><Icon name="check" size={14} /> 100% lokal</span>
                <span><Icon name="monitor" size={14} /> Berjalan di Windows</span>
              </div>
            </div>

            <div className="hero-shot">
              <div className="shot-frame">
                <img src="/app-preview.png" alt="Tampilan aplikasi desktop CastV" />
              </div>
              <span className="shot-caption">Tampilan asli aplikasi CastV untuk Windows</span>
            </div>
          </div>
        </section>

        <section className="section" id="fitur">
          <div className="wrap">
            <div className="section-head">
              <span className="kicker">Fitur</span>
              <h2>Semua yang dibutuhkan, tanpa yang tidak.</h2>
              <p>CastV sengaja dibuat fokus: satu tombol untuk mulai, tanpa akun dan tanpa konfigurasi rumit.</p>
            </div>
            <div className="feature-grid">
              {FEATURES.map((item) => (
                <article className="feature" key={item.title}>
                  <span className="feature-icon"><Icon name={item.icon} size={20} /></span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section section-alt" id="cara-kerja">
          <div className="wrap">
            <div className="section-head">
              <span className="kicker">Cara kerja</span>
              <h2>Tiga langkah, selesai.</h2>
            </div>
            <div className="step-grid">
              {STEPS.map((step) => (
                <article className="step" key={step.n}>
                  <span className="step-n">{step.n}</span>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="download">
          <div className="wrap">
            <div className="download-card">
              <span className="kicker kicker-light">Download</span>
              <h2>Ambil CastV untuk Windows</h2>
              <p>Unduh installer untuk PC, jalankan sekali, lalu CastV langsung siap dipakai.</p>
              <DownloadButtons compact />
              <ul className="requirements">
                <li><span>Versi</span><strong>v{DOWNLOAD.version}</strong></li>
                <li><span>Sistem</span><strong>Windows 10/11 · x64</strong></li>
                <li><span>Ukuran</span><strong>± 107 MB</strong></li>
                <li><span>Jaringan</span><strong>Wi-Fi atau LAN lokal</strong></li>
              </ul>
              <p className="dl-note">
                Windows SmartScreen mungkin menampilkan peringatan karena installer belum code-signed.
                Pilih <strong>More info → Run anyway</strong>.
              </p>
            </div>
          </div>
        </section>

        <section className="section section-alt" id="faq">
          <div className="wrap faq-grid">
            <div className="section-head">
              <span className="kicker">FAQ</span>
              <h2>Pertanyaan yang sering muncul.</h2>
            </div>
            <div className="faq-list">
              {FAQ.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}<Icon name="plus" size={16} /></summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="wrap footer-inner">
          <span className="logo">
            <span className="logo-mark"><i /><i /><i /></span>
            <span className="logo-text">Cast<em>V</em></span>
          </span>
          <span className="footer-note">© 2026 CastV · Dibuat untuk presentasi yang tenang.</span>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
