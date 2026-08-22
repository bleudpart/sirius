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
