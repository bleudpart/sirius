export const isFrenchVoice = (voice) => /^fr(?:-|$)/i.test(voice?.lang || "");

// Les voix Google TTS d'Android n'ont pas de prénom : fr-fr-x-frb/frd sont masculines, fra/frc/vlf féminines.
const FEMALE = /\b(?:female|femme|amelie|amélie|audrey|marie|julie|celine|céline|hortense|denise|eloise|éloïse|charline|virginie|chantal|x-fra|x-frc|x-vlf)\b/i;
const MALE = /\b(?:male|homme|man|paul|henri|thomas|nicolas|claude|mathieu|guillaume|daniel|jerome|jérôme|x-frb|x-frd)\b/i;

export function selectFrenchVoice(voices, { localOnly = false, gender = "female" } = {}) {
  const candidates = (voices || []).filter((voice) => isFrenchVoice(voice) && (!localOnly || voice.localService));
  const score = (voice) => {
    const name = voice.name || "";
    const preferred = gender === "male" ? MALE : FEMALE;
    const opposite = gender === "male" ? FEMALE : MALE;
    return (/^fr-FR$/i.test(voice.lang) ? 10 : 0)
      + (preferred.test(name) ? 2 : opposite.test(name) ? 0 : 1);
  };
  return candidates.reduce((best, voice) => !best || score(voice) > score(best) ? voice : best, null);
}
