// Light, dark, or as the device is set. Kept per browser.
const KEY = 'forge-theme';

export function currentTheme() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function applyTheme(theme = currentTheme()) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* not kept */ }
  applyTheme(theme);
}

export function isDark() {
  const theme = currentTheme();
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
