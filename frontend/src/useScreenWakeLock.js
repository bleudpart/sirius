import { useEffect, useState } from "react";

const IDLE = { status: "idle", message: "" };
const ACTIVE = { status: "active", message: "Écran maintenu allumé pendant le service." };
const RELEASED = {
  status: "released",
  message: "Verrou d’écran libéré ; il sera redemandé au retour dans l’application.",
};

export default function useScreenWakeLock(enabled) {
  const [wakeLockStatus, setWakeLockStatus] = useState(IDLE);

  useEffect(() => {
    if (!enabled) {
      setWakeLockStatus(IDLE);
      return undefined;
    }
    if (!navigator.wakeLock?.request) {
      setWakeLockStatus({
        status: "unavailable",
        message: "Ce navigateur ne permet pas de garder l’écran allumé.",
      });
      return undefined;
    }

    let active = true;
    let lock = null;
    let requesting = false;
    let retryWhenSettled = false;
    const releaseLock = (heldLock) => {
      heldLock.release().catch((failure) => {
        console.error("Libération du verrou d’écran impossible.", failure);
      });
    };
    const requestLock = async () => {
      if (!active || document.visibilityState !== "visible" || lock) return;
      if (requesting) {
        retryWhenSettled = true;
        return;
      }
      requesting = true;
      try {
        const nextLock = await navigator.wakeLock.request("screen");
        if (!active || document.visibilityState !== "visible") {
          await nextLock.release();
          return;
        }
        if (nextLock.released) {
          setWakeLockStatus(RELEASED);
          return;
        }
        lock = nextLock;
        setWakeLockStatus(ACTIVE);
        nextLock.addEventListener("release", () => {
          if (lock === nextLock) {
            lock = null;
            if (active) setWakeLockStatus(RELEASED);
          }
        }, { once: true });
      } catch (failure) {
        if (active) {
          setWakeLockStatus({
            status: "unavailable",
            message: `Maintien de l’écran indisponible : ${failure.message}`,
          });
        } else {
          console.error("Maintien de l’écran interrompu.", failure);
        }
      } finally {
        requesting = false;
        if (retryWhenSettled) {
          retryWhenSettled = false;
          if (active && document.visibilityState === "visible" && !lock) void requestLock();
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void requestLock();
      } else if (lock) {
        const heldLock = lock;
        lock = null;
        setWakeLockStatus(RELEASED);
        releaseLock(heldLock);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void requestLock();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (lock) {
        const heldLock = lock;
        lock = null;
        releaseLock(heldLock);
      }
    };
  }, [enabled]);

  return wakeLockStatus;
}
