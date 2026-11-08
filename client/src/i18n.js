// Translates what is on screen by exact wording, so every screen is covered without each one
// having to ask. It only ever changes text, never values typed in a form, and English simply
// stays wherever there is no translation. Printed documents stay in English.
const STORE_KEY = 'forge-language';
export const LANGUAGES = [['en', 'English'], ['hi', 'हिन्दी'], ['gu', 'ગુજરાતી']];

let words = null;
let observer = null;
let originals = new WeakMap();
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'OPTION', 'CODE']);

const isSkipped = (node) => {
  const parent = node.parentElement;
  if (!parent || SKIP.has(parent.tagName)) return true;
  return Boolean(parent.closest('.no-translate'));
};

function translateText(node) {
  if (!words || isSkipped(node)) return;
  const text = node.nodeValue;
  const key = text.trim();
  if (!key || !words[key]) return;
  originals.set(node, text);
  node.nodeValue = text.replace(key, words[key]);
}

function walk(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) translateText(node);
}

function restore(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (originals.has(node)) node.nodeValue = originals.get(node);
  }
  originals = new WeakMap();
}

export function currentLanguage() {
  try {
    return localStorage.getItem(STORE_KEY) ?? 'en';
  } catch {
    return 'en';
  }
}

export async function setLanguage(language) {
  try {
    localStorage.setItem(STORE_KEY, language);
  } catch {
    // Private windows can refuse this. The choice then lasts only for this page.
  }
  document.documentElement.lang = language;
  observer?.disconnect();
  observer = null;
  words = null;
  restore(document.body);
  if (language === 'en') return;
  const response = await fetch(`/api/v1/public/translations/${encodeURIComponent(language)}`);
  if (!response.ok) return;
  words = (await response.json()).data;
  walk(document.body);
  observer = new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'characterData') translateText(change.target);
      else change.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

export function startLanguage() {
  const language = currentLanguage();
  if (language !== 'en') setLanguage(language).catch(() => {});
}
