// One theme choice for every page. Material owns the choice on the notes and game pages (it stores it
// under `<site root>.__palette`); standalone pages such as the home page use these helpers to read and
// write the same entry, so toggling on one page carries to the others. Storage can be blocked, so every
// access is wrapped and the page falls back to the system preference.

const ROOT = new URL('../../', import.meta.url);
const KEY = `${ROOT.pathname}.__palette`;

const schemes = {
  light: { index: 0, color: { media: '(prefers-color-scheme: light)', scheme: 'default', primary: 'custom', accent: 'custom' } },
  dark: { index: 1, color: { media: '(prefers-color-scheme: dark)', scheme: 'slate', primary: 'custom', accent: 'custom' } },
};

export function savedTheme() {
  try {
    const palette = JSON.parse(localStorage.getItem(KEY));
    if (palette && palette.color && palette.color.scheme) return palette.color.scheme === 'slate' ? 'dark' : 'light';
  } catch {
    // Unreadable or blocked storage: follow the system.
  }
  return null;
}

export const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export function applyTheme(theme, { save = false } = {}) {
  document.documentElement.dataset.theme = theme;
  if (!save) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(schemes[theme]));
  } catch {
    // The choice still applies to this page.
  }
}

// Wire a toggle button on a page that does not use Material's own header.
export function initTheme(button) {
  const saved = savedTheme();
  if (saved) applyTheme(saved);
  const label = () => {
    button.textContent = currentTheme() === 'dark' ? 'Light mode' : 'Dark mode';
  };
  button.addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', { save: true });
    label();
  });
  label();
}
