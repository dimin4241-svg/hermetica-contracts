import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsDir = path.join(here, 'settings');
const sourceSettings = path.join(here, '..', 'standalone', 'settings', 'Devnet.toml');
const targetSettings = path.join(settingsDir, 'Devnet.toml');

fs.mkdirSync(settingsDir, { recursive: true });
fs.copyFileSync(sourceSettings, targetSettings);

await import('./run-jit-reward-ab-poc.mjs');
