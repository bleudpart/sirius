import { act } from "react";
import { createRoot } from "react-dom/client";
import * as faceapi from "@vladmandic/face-api";
import FaceIdPanel from "./FaceIdPanel";

jest.mock("@vladmandic/face-api", () => ({
  nets: {
    tinyFaceDetector: { loadFromUri: jest.fn().mockResolvedValue(undefined) },
    faceLandmark68Net: { loadFromUri: jest.fn().mockResolvedValue(undefined) },
    faceRecognitionNet: { loadFromUri: jest.fn().mockResolvedValue(undefined) },
  },
  TinyFaceDetectorOptions: jest.fn(),
  detectSingleFace: jest.fn(),
  euclideanDistance: jest.fn(() => 0.2),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("FaceIdPanel", () => {
  let container;
  let root;
  let stream;
  let originalMediaDevices;
  let originalPlay;

  beforeEach(() => {
    localStorage.removeItem("sirius_faceid");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    stream = { getTracks: () => [{ stop: jest.fn() }] };
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: jest.fn().mockResolvedValue(stream) },
    });
    faceapi.detectSingleFace.mockImplementation(() => ({
      withFaceLandmarks() { return this; },
      withFaceDescriptor: jest.fn().mockResolvedValue(null),
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLMediaElement.prototype.play = originalPlay;
    if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    else delete navigator.mediaDevices;
  });

  const mountAndWait = async () => {
    await act(async () => {
      root.render(<FaceIdPanel onClose={() => {}} userName="Camille" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  test("opens the live camera before a face has been enrolled", async () => {
    await mountAndWait();

    const video = container.querySelector('[data-testid="faceid-video"]');
    expect(video.srcObject).toBe(stream);
    expect(container.textContent).toContain("Aucune identité");
    expect(container.querySelector('[data-testid="faceid-enroll-btn"]').disabled).toBe(false);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("reports a missing camera as a camera problem, not a missing saved face", async () => {
    navigator.mediaDevices.getUserMedia.mockRejectedValueOnce({ name: "NotFoundError" });
    await mountAndWait();

    expect(container.textContent).toContain("Aucune caméra détectée");
    expect(container.querySelector(".faceid-state.nocam")).not.toBeNull();
    expect(container.querySelector(".faceid-profile").textContent).toContain("Aucune identité");
    expect(container.querySelector('[data-testid="faceid-retry-camera-btn"]')).not.toBeNull();
  });
});