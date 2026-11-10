import { useRef, useState } from "react";

export default function HaccpSignature({ onChange }) {
  const canvas = useRef(null);
  const drawing = useRef(false);
  const [error, setError] = useState("");

  const position = (event) => {
    const area = canvas.current.getBoundingClientRect();
    return {
      x: (event.clientX - area.left) * canvas.current.width / area.width,
      y: (event.clientY - area.top) * canvas.current.height / area.height,
    };
  };
  const start = (event) => {
    if (event.button !== 0 && event.pointerType !== "touch") return;
    event.preventDefault();
    const context = canvas.current.getContext("2d");
    if (!context) { setError("La zone de signature est indisponible sur cet appareil."); return; }
    setError("");
    const point = position(event);
    context.strokeStyle = "#13202b";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x + 0.1, point.y + 0.1);
    context.stroke();
    drawing.current = true;
    canvas.current.setPointerCapture?.(event.pointerId);
  };
  const move = (event) => {
    if (!drawing.current) return;
    event.preventDefault();
    const point = position(event);
    const context = canvas.current.getContext("2d");
    context.lineTo(point.x, point.y);
    context.stroke();
  };
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvas.current.toDataURL("image/png"));
  };
  const clear = () => {
    const context = canvas.current.getContext("2d");
    if (!context) { setError("La zone de signature est indisponible sur cet appareil."); return; }
    context.clearRect(0, 0, canvas.current.width, canvas.current.height);
    drawing.current = false;
    onChange("");
  };

  return <div className="haccp-releve-signature">
    <span>Signature manuscrite *</span>
    <canvas ref={canvas} width={600} height={180} aria-label="Zone de signature manuscrite"
      onPointerDown={start} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={finish} onLostPointerCapture={finish} />
    <button type="button" onClick={clear}>Effacer la signature</button>
    <small>Signature dessinée, non certifiée par certificat.</small>
    {error && <p role="alert">{error}</p>}
  </div>;
}
