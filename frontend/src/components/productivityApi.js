const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api/productivity";

export async function productivityRequest(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("Le service Productivite a retourne une reponse invalide.");
  }
  if (!response.ok) {
    throw new Error(payload.detail || "Le service Productivite est indisponible.");
  }
  return payload;
}

