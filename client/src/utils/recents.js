// Starred pages and recently opened pages. These are one person's conveniences on one device,
// so they live in the browser, and everything still works if the browser refuses to keep them.
const RECENT_KEY = 'forge-recent';
const STAR_KEY = 'forge-stars';
const MAX_RECENT = 10;

const read = (key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A private window can refuse this. Nothing depends on it.
  }
};

export const recentPages = () => read(RECENT_KEY);
export const starredPages = () => read(STAR_KEY);
export const isStarred = (to) => starredPages().some((row) => row.to === to);

export function noteVisit(to, label, kind) {
  if (!label) return;
  write(RECENT_KEY, [{ to, label, kind }, ...recentPages().filter((row) => row.to !== to)].slice(0, MAX_RECENT));
}

export function toggleStar(to, label) {
  const stars = starredPages();
  const next = stars.some((row) => row.to === to) ? stars.filter((row) => row.to !== to) : [...stars, { to, label }];
  write(STAR_KEY, next);
  return next.some((row) => row.to === to);
}
