function captureRectangle(region, bounds) {
  if (region == null) return undefined;
  if (![region.x, region.y, region.w, region.h].every(Number.isFinite)
      || region.x < 0 || region.y < 0 || region.w <= 0 || region.h <= 0) {
    throw new Error("Zone de capture invalide.");
  }
  const x = Math.floor(region.x);
  const y = Math.floor(region.y);
  const right = Math.min(bounds.width, Math.ceil(region.x + region.w));
  const bottom = Math.min(bounds.height, Math.ceil(region.y + region.h));
  if (right <= x || bottom <= y) throw new Error("Zone de capture hors de la fenêtre.");
  return { x, y, width: right - x, height: bottom - y };
}

module.exports = { captureRectangle };
