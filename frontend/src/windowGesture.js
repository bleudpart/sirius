import { useCallback, useEffect, useRef } from "react";

export function isPrimaryGesture(event) {
  return event.button === 0 && event.isPrimary !== false;
}

export function fixedWindowFrame(element) {
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if ([style.transform, style.perspective, style.filter].some((value) => value && value !== "none")) {
      const rect = parent.getBoundingClientRect();
      const scaleX = parent.offsetWidth ? rect.width / parent.offsetWidth : 1;
      const scaleY = parent.offsetHeight ? rect.height / parent.offsetHeight : 1;
      return {
        left: rect.left + parent.clientLeft * scaleX,
        top: rect.top + parent.clientTop * scaleY,
        scaleX, scaleY,
      };
    }
  }
  return { left: 0, top: 0, scaleX: 1, scaleY: 1 };
}

// Keep only the latest position per frame; capture keeps iframe crossings reliable.
export function trackWindowGesture(event, { element, onMove, onEnd }) {
  if (!isPrimaryGesture(event)) return () => {};
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  let frame = 0;
  let latest = null;
  let ended = false;
  const matches = (next) => next.pointerId === pointerId;
  const flush = () => {
    frame = 0;
    if (latest) {
      const point = latest;
      latest = null;
      onMove(point);
    }
  };
  const move = (next) => {
    if (ended || !matches(next)) return;
    latest = { clientX: next.clientX, clientY: next.clientY, pointerId };
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const finish = (next, disposed = false) => {
    if (ended || (next?.pointerId != null && !matches(next))) return;
    ended = true;
    if (frame) cancelAnimationFrame(frame);
    if (!disposed) flush();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    document.removeEventListener("visibilitychange", onVisibility);
    handle.removeEventListener("lostpointercapture", finish);
    observer.disconnect();
    element.classList.remove("window-gesture-active");
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    if (!disposed) onEnd?.();
  };
  const onVisibility = () => { if (document.hidden) finish(); };
  const observer = new MutationObserver(() => {
    if (!element.isConnected || !handle.isConnected) finish(undefined, true);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  element.classList.add("window-gesture-active");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  document.addEventListener("visibilitychange", onVisibility);
  handle.addEventListener("lostpointercapture", finish);
  if (handle.setPointerCapture && pointerId != null) {
    try { handle.setPointerCapture(pointerId); }
    catch (error) {
      if (error.name !== "NotFoundError") {
        finish(undefined, true);
        throw error;
      }
      console.warn("Capture du geste indisponible ; suivi dans la fenêtre :", error);
    }
  }
  event.preventDefault();
  return () => finish(undefined, true);
}

export default function useWindowGesture() {
  const disposeRef = useRef(null);
  useEffect(() => () => disposeRef.current?.(), []);
  return useCallback((event, options) => {
    disposeRef.current?.();
    disposeRef.current = trackWindowGesture(event, options);
  }, []);
}
