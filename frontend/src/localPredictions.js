export const PREDICTION_EVENT = "sirius-local-predictions";
const templates = ["analysis", "review", "alert"];
export const predictionOwner = (user) => user?.user_id || user?.id || user?._id || user?.email || null;
const keyFor = (owner) => `sirius_local_predictions_v1_${encodeURIComponent(owner)}`;
const empty = () => ({ enabled: false, events: [], suggestions: [] });
const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function readPredictions(owner) {
  if (!owner) return empty();
  const raw = localStorage.getItem(keyFor(owner));
  if (!raw) return empty();
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Historique prédictif local illisible ; effacez-le avant de réactiver."); }
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.events) || value.events.length > 2016 ||
      !Array.isArray(value.suggestions) || value.suggestions.length > 3 ||
      value.events.some((item) => !templates.includes(item.template) || !/^\d{4}-\d{2}-\d{2}$/.test(item.day) ||
        !Number.isInteger(item.hour) || item.hour < 0 || item.hour > 23) ||
      value.suggestions.some((item) => !templates.includes(item.template) || !Number.isInteger(item.days) || item.days < 3))
    throw new Error("Historique prédictif local invalide ; effacez-le avant de réactiver.");
  return { enabled: value.enabled,
    events: value.events.map(({ template, day, hour }) => ({ template, day, hour })),
    suggestions: value.suggestions.map(({ template, days }) => ({ template, days })) };
}

function save(owner, data) {
  if (!owner) throw new Error("Un compte identifié est requis pour la télémétrie locale.");
  localStorage.setItem(keyFor(owner), JSON.stringify(data));
  window.dispatchEvent(new Event(PREDICTION_EVENT));
  return data;
}

export function configurePredictions(owner, enabled) {
  return save(owner, { ...empty(), enabled });
}

export function forgetPredictions(owner) {
  if (owner) localStorage.removeItem(keyFor(owner));
  window.dispatchEvent(new Event(PREDICTION_EVENT));
}

export function refreshPredictions(owner, now = new Date(), addition = null) {
  const data = readPredictions(owner);
  if (!data.enabled) return data;
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 27);
  const today = dayOf(now);
  const events = data.events.filter((item) => item.day >= dayOf(cutoff) && item.day <= today);
  if (addition && templates.includes(addition)) {
    const item = { template: addition, day: today, hour: now.getHours() };
    if (!events.some((event) => event.template === item.template && event.day === item.day && event.hour === item.hour))
      events.push(item);
  }
  const suggestions = templates.flatMap((template) => {
    const days = new Set(events.filter((item) => item.template === template && item.day < today &&
      Math.min(Math.abs(item.hour - now.getHours()), 24 - Math.abs(item.hour - now.getHours())) <= 1).map((item) => item.day));
    return days.size >= 3 ? [{ template, days: days.size }] : [];
  });
  return save(owner, { enabled: true, events, suggestions });
}
