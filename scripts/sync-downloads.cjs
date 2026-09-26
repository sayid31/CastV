/**
 * Copies the built Windows installers from release/ into public/downloads/
 * so the public landing page can link to them directly.
 *
 * Usage: npm run downloads:sync
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');
const targetDir = path.join(root, 'public', 'downloads');

if (!fs.existsSync(releaseDir)) {
  console.error('Folder release/ belum ada. Jalankan `npm run dist` terlebih dahulu.');
  process.exit(1);
}

const files = fs.readdirSync(releaseDir).filter((name) => name.toLowerCase().endsWith('.exe'));
if (!files.length) {
  console.error('Tidak ada file .exe di release/. Jalankan `npm run dist` terlebih dahulu.');
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const name of files) {
  const from = path.join(releaseDir, name);
  const to = path.join(targetDir, name);
  fs.copyFileSync(from, to);
  const size = (fs.statSync(to).size / (1024 * 1024)).toFixed(1);
  console.log(`  ${name} (${size} MB)`);
  copied += 1;
}

console.log(`\n${copied} installer disalin ke public/downloads/`);
