// Retire de la voix les mentions de sources et les liens, qui restent visibles à l'écran.
// « Santé : source temporairement indisponible. » (minuscule, sans deux-points) est conservé.
const SOURCE_BLOCK = /(^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?Sources?(?:[ \t]+(?:et|&)[ \t]+liens?)?[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*\n(?:[ \t]*(?:[-*+•]|\d+[.)]|\[|https?:\/\/|www\.)[^\n]*(?:\n|$))+/g;
const SOURCE_SENTENCE = /(^|[.!?…][ \t]+|\n)[ \t]*(?:\*\*|__)?Sources?[ \t]*(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[^\n]*?(?:[.!?…](?=\s|$)|(?=\n)|$)/g;
const SOURCE_ASIDE = /[ \t]*\((?:sources?|via)[ \t]*:?[^)\n]*\)/gi;
const URL = /[ \t]*\(?[ \t]*(?:https?:\/\/|www\.)[^\s)]+\)?/gi;

export function stripSpokenSources(text) {
  return String(text || "")
    .replace(SOURCE_BLOCK, "$1")
    .replace(SOURCE_SENTENCE, "$1")
    .replace(SOURCE_ASIDE, "")
    .replace(URL, "")
    .replace(/[ \t]*:[ \t]*(?=[.!?,;]|\n|$)/g, "")
    .replace(/[ \t]+([.!?,;])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
