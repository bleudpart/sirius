const SECOND = 1000;
const MINUTE = 60 * SECOND;

export function getDisplayAutoCloseDelay(item) {
  if (item?.type === "message") {
    const wordCount = String(item.contenu || "").trim().split(/\s+/).filter(Boolean).length;
    return Math.min(10 * MINUTE, Math.max(2 * MINUTE, 30 * SECOND + wordCount * 450));
  }
  if (item?.type === "image") return 90 * SECOND;
  return null;
}
