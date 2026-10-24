import { act } from "react";
import { createRoot } from "react-dom/client";
import InteriorCamera from "./InteriorCamera";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("rear camera capture stays local, scales the photo and releases tracks on closure", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const stop = jest.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
  } });
  const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const drawImage = jest.fn();
  const context = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage });
  const encode = jest.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,cGhvdG8=");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const captured = jest.fn();
  try {
    await act(async () => root.render(<InteriorCamera onCapture={captured} onClose={() => {}} />));
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: false, video: expect.objectContaining({ facingMode: { ideal: "environment" } }),
    }));
    expect(captured).not.toHaveBeenCalled();
    const video = host.querySelector("video");
    Object.defineProperties(video, { videoWidth: { value: 3200 }, videoHeight: { value: 2400 } });
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent.includes("Prendre la photo")).click());
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1600, 1200);
    expect(captured).toHaveBeenCalledWith(expect.objectContaining({ realPlace: true, dataUrl: "data:image/jpeg;base64,cGhvdG8=" }));
    await act(async () => root.unmount());
    expect(stop).toHaveBeenCalled();
  } finally {
    host.remove(); play.mockRestore(); context.mockRestore(); encode.mockRestore();
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else delete navigator.mediaDevices;
  }
});

test("permission resolving after closure releases the camera without delivering a photo", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let resolve;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: () => new Promise((done) => { resolve = done; }),
  } });
  const stop = jest.fn();
  const captured = jest.fn();
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<InteriorCamera onCapture={captured} onClose={() => {}} />));
    await act(async () => root.unmount());
    await act(async () => resolve({ getTracks: () => [{ stop }] }));
    expect(stop).toHaveBeenCalled();
    expect(captured).not.toHaveBeenCalled();
  } finally {
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else delete navigator.mediaDevices;
  }
});

test("minimizing the window stops the camera and closes the preview", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const stop = jest.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
  } });
  const play = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onClose = jest.fn();
  try {
    await act(async () => root.render(<InteriorCamera onCapture={() => {}} onClose={onClose} />));
    await act(async () => { host.classList.add("holo-minimized"); });
    expect(stop).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); host.remove(); play.mockRestore();
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else delete navigator.mediaDevices;
  }
});
