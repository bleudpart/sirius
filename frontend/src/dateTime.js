const LOCAL_TIME_OPTIONS = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

const LOCAL_DATE_OPTIONS = {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
};

export function formatLocalTime(nowLocal = new Date()) {
  return nowLocal.toLocaleTimeString([], LOCAL_TIME_OPTIONS);
}

export function formatUtcTime(nowUTC = new Date(Date.now())) {
  return nowUTC.toISOString().split("T")[1].split(".")[0];
}

export function formatLocalDate(nowLocal = new Date()) {
  return nowLocal.toLocaleDateString([], LOCAL_DATE_OPTIONS);
}

export function getLocalDateKey(nowLocal = new Date()) {
  const year = nowLocal.getFullYear();
  const month = String(nowLocal.getMonth() + 1).padStart(2, "0");
  const day = String(nowLocal.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDocumentDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T| )/.exec(value || "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : (value || "—");
}

const FRENCH_MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export function formatSpeechDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return value;
  return `${day === 1 ? "premier" : day} ${FRENCH_MONTHS[month - 1]} ${match[1]}`;
}
