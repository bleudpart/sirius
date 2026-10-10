import { normalizeFrenchElisions } from "./phoneticFr";

const EXCLUDED = "button:not(.sd-email-card):not(.sd-contact-card), svg, script, style, canvas, [data-no-read], .hp-scan";

export function displayReadingText(body, fallback = "") {
  if (!body) return fallback.trim();
  const parts = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(EXCLUDED) || parent.closest("textarea, input, select")) continue;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
  }
  body.querySelectorAll("input:not([type=hidden]), textarea").forEach((field) => {
    if (!field.closest(EXCLUDED) && field.value.trim()) parts.push(field.value.trim());
  });
  return parts.join("\n").trim() || fallback.trim();
}

export function splitDisplayReading(text, limit = 800) {
  const chunks = [];
  let remaining = normalizeFrenchElisions(text).trim();
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit + 1);
    let end = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("! "), prefix.lastIndexOf("? "), prefix.lastIndexOf("\n"));
    if (end < limit / 2) end = prefix.lastIndexOf(" ");
    if (end <= 0) end = limit;
    else if (/[.!?]/.test(remaining[end])) end += 1;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export const isDisplayReadCommand = (command) => /^(?:lis|lit|lire|relis)(?:[- ]moi)?\s+(?:(?:tout\s+)?(?:ce\s+que\s+tu\s+affiches|ce\s+qui\s+est\s+affich[ée])(?:\s+dans\s+(?:ton|mon|le)\s+(?:[ΣsSzZ]irius\s+)?display)?|(?:(?:ton|mon|le)\s+)?(?:[ΣsSzZ]irius\s+)?display)\s*[.!?]*$/i.test(command);
