// Zips ../extension into public/jobpilot-extension.zip. Runs automatically before
// every build (npm prebuild), so the dashboard's "Download extension" button always
// serves the exact extension version committed alongside the frontend.
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.resolve(root, '..', 'extension');
const out = path.join(root, 'public', 'jobpilot-extension.zip');

const zip = new AdmZip();
zip.addLocalFolder(extDir, 'jobpilot-extension');
fs.mkdirSync(path.dirname(out), { recursive: true });
zip.writeZip(out);

const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
console.log(`packed extension v${manifest.version} -> ${path.relative(root, out)}`);
