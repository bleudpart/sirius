import { useSyncExternalStore } from "react";
import { Languages } from "lucide-react";
import { LANGUAGES, getLanguage, setLanguage, subscribeLanguage } from "@/i18n/domTranslator";
import "./languageSwitcher.css";

const LANGUAGE_WORD = { fr: "Langue", en: "Language", ta: "மொழி" };

export default function LanguageSwitcher({ className = "profile-btn top-settings-btn" }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  const index = Math.max(0, LANGUAGES.findIndex((lang) => lang.code === language));
  const active = LANGUAGES[index];
  const next = LANGUAGES[(index + 1) % LANGUAGES.length];
  const title = `${LANGUAGE_WORD[language] || "Langue"} : ${active.label} → ${next.label}`;

  return (
    <button
      type="button"
      className={`${className} sirius-language-btn`}
      onClick={() => setLanguage(next.code)}
      data-testid="sirius-language-btn"
      translate="no"
      title={title}
      aria-label={title}
    >
      <Languages size={15} strokeWidth={1.6} aria-hidden="true" />
      <span className="sirius-language-code">{active.short}</span>
    </button>
  );
}
