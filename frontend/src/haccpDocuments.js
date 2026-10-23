import { API_BASE_URL } from "./lib/api";

export const escapeDocumentText = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

export async function haccpDocumentRequest(resource, path = "", body) {
  const response = await fetch(`${API_BASE_URL}/haccp/${resource}${path}`, {
    credentials: "include",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(typeof data?.detail === "string" ? data.detail
      : `Document indisponible (${response.status}). Vérifiez les champs et votre connexion.`);
  }
  return response.json();
}

export function printHaccpDocument(html, frameRef, onError) {
  frameRef.current?.remove();
  const iframe = document.createElement("iframe");
  iframe.title = "Document de prévention à imprimer";
  iframe.style.cssText = "position:fixed;left:-10000px;width:1100px;height:800px;border:0";
  iframe.onload = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (error) {
      onError("Impression indisponible sur cet appareil. Utilisez un navigateur permettant l'impression.");
    }
  };
  iframe.srcdoc = html;
  frameRef.current = iframe;
  document.body.appendChild(iframe);
}
