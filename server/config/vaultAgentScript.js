// Fills in the Windows sync program (assets/ForgeVaultSync.ps1) for one PC: the Forge
// address, the PC's own key, its vault folder and the vault folder icon. Plain PowerShell,
// which every Windows 10 and 11 PC already has, so nothing needs installing.
import { readFileSync } from 'node:fs';

const asset = (name) => new URL(`../assets/${name}`, import.meta.url);
const template = readFileSync(asset('ForgeVaultSync.ps1'), 'utf8');
let icon = '';
try {
  icon = readFileSync(asset('forge-vault.ico')).toString('base64');
} catch {
  // Without the icon file the folder uses Windows' own folder icon.
}

// Inside single quotes, PowerShell only treats ' specially. Line breaks are removed.
const quoted = (value) => String(value).replace(/[\r\n]/g, ' ').replace(/'/g, "''");

export function vaultAgentScript({ serverUrl, key, pcFolder, name, extensions }) {
  const values = {
    __FORGE_URL__: quoted(serverUrl.replace(/\/+$/, '')),
    __AGENT_KEY__: quoted(key),
    __PC_FOLDER__: quoted(pcFolder),
    __PC_NAME__: quoted(name),
    __TYPES__: extensions.map((e) => `'${quoted(e)}'`).join(', '),
    __ICON_B64__: icon,
  };
  return template.replace(/__(FORGE_URL|AGENT_KEY|PC_FOLDER|PC_NAME|TYPES|ICON_B64)__/g, (token) => values[token]);
}
