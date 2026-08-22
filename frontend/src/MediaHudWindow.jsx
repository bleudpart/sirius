import MediaHUD from "@/components/MediaHUD";

export default function MediaHudWindow() {
  const close = () => {
    if (window.siriusMedia?.closeHud) {
      void window.siriusMedia.closeHud();
      return;
    }
    window.close();
  };

  return (
    <main className="media-hud-window">
      <MediaHUD standalone onClose={close} />
    </main>
  );
}

