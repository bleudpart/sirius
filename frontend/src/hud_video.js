const VIDEO_MEDIA_MODULE_IDS = new Set(["youtube", "netflix", "twitch", "tiktok"]);

export function isHudVideoModule(mediaModule) {
  return Boolean(
    mediaModule
      && (mediaModule.media_type === "video" || VIDEO_MEDIA_MODULE_IDS.has(mediaModule.id))
  );
}
