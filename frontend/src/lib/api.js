// © 2026 Daniel Partel – ΣIRIUS Assistant. Logiciel protégé.
// Centralisation du pipeline réseau HTTP & Timeout de sécurité

export const BACKEND_BASE_URL = (process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001")
  .replace(/\/+$/, "");
export const API_BASE_URL = `${BACKEND_BASE_URL}/api`;

export const resolveBackendUrl = (url) => {
  if (typeof url !== "string") return url;
  if (/^\/api(?:\/|$)/.test(url)) return `${BACKEND_BASE_URL}${url}`;
  if (/^undefined\/api(?:\/|$)/.test(url)) {
    return `${BACKEND_BASE_URL}/${url.slice("undefined/".length)}`;
  }
  return url;
};

/**
 * Envoie une commande au serveur Cloud / Backend Sirius avec contrôle de timeout.
 * @param {string} command - La commande utilisateur
 * @returns {Promise<any>} - La réponse JSON du serveur
 */
export const cloudAnswer = async (command) => {
  if (!command || !command.trim()) return null;

  // Timeout automatique de 30 secondes pour éviter tout blocage indéfini
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${API_BASE_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include", // 👈 Indispensable pour transmettre le cookie d'authentification
      body: JSON.stringify({ prompt: command }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Erreur réseau HTTP : ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      console.warn("[ΣIRIUS API] La requête vers le Cloud a dépassé le délai de 30s.");
    } else {
      console.error("[ΣIRIUS API] Erreur de communication :", error);
    }
    throw error;
  }
};

/**
 * Enregistrement des logs d'apprentissage Sirius Prime
 */
export const logPrimeCommand = async (command, intent = null) => {
  try {
    await fetch(`${API_BASE_URL}/prime/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // 👈 Ajouté par sécurité ici aussi
      body: JSON.stringify({ text: command, intent }),
    });
  } catch (err) {
    // Échec silencieux pour ne pas bloquer l'expérience utilisateur
  }
};