import "./ProviderLogo.css";

// Logos de marque reconstruits en SVG multicolore : nets à toute taille et fidèles
// aux couleurs officielles, y compris quand le compte n'est pas connecté.

const GmailMark = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M6 42h9.8V25.3L2 14.9v22.4C2 39.9 3.8 42 6 42z" />
    <path fill="#34A853" d="M32.2 42H42c2.2 0 4-2.1 4-4.7V14.9L32.2 25.3V42z" />
    <path fill="#FBBC04" d="M32.2 9.2v16.1L46 14.9v-3.6c0-5.1-5.4-8-9.2-5.1l-4.6 3z" />
    <path fill="#EA4335" d="M15.8 25.3V9.2L24 15.4l8.2-6.2v16.1L24 31.5z" />
    <path fill="#C5221F" d="M2 11.3v3.6l13.8 10.4V9.2l-4.6-3C7.4 3.3 2 6.2 2 11.3z" />
  </svg>
);

const MicrosoftMark = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#F25022" d="M4 4h19.2v19.2H4z" />
    <path fill="#7FBA00" d="M24.8 4H44v19.2H24.8z" />
    <path fill="#00A4EF" d="M4 24.8h19.2V44H4z" />
    <path fill="#FFB900" d="M24.8 24.8H44V44H24.8z" />
  </svg>
);

const OutlookMark = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#0F4BA8" d="M15 4h29a2 2 0 0 1 2 2v3H15z" />
    <path fill="#0F6CBD" d="M15 9h10.3v9H15z" />
    <path fill="#1890F1" d="M25.3 9h10.3v9H25.3z" />
    <path fill="#50D9FF" d="M35.6 9H46v9H35.6z" />
    <path fill="#0A4A9E" d="M15 18h10.3v9H15z" />
    <path fill="#0F6CBD" d="M25.3 18h10.3v9H25.3z" />
    <path fill="#28A8EA" d="M35.6 18H46v9H35.6z" />
    <path fill="#0F4BA8" d="M15 27h10.3v9H15z" />
    <path fill="#0A4A9E" d="M25.3 27h10.3v9H25.3z" />
    <path fill="#0F6CBD" d="M35.6 27H46v9H35.6z" />
    <path fill="#103F91" d="M46 21v7l-9 6z" />
    <path fill="#28A8EA" d="M8 20h38v20a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z" />
    <path fill="#1490DF" d="M46 20 27 34 8 20z" />
    <rect x="2" y="12" width="24" height="24" rx="3" fill="#0078D4" />
    <path fill="#FFFFFF" d="M14 17.2c-3.6 0-6.2 2.8-6.2 6.8s2.6 6.8 6.2 6.8 6.2-2.8 6.2-6.8-2.6-6.8-6.2-6.8zm0 10.9c-1.8 0-3-1.6-3-4.1s1.2-4.1 3-4.1 3 1.6 3 4.1-1.2 4.1-3 4.1z" />
  </svg>
);

const PROVIDER_ICONS = {
  google: GmailMark,
  gmail: GmailMark,
  microsoft: MicrosoftMark,
  outlook: OutlookMark,
};

export default function ProviderLogo({ provider, size = 20, title = "" }) {
  const Icon = PROVIDER_ICONS[provider] || MicrosoftMark;
  return (
    <span className={`provider-logo provider-logo-${provider}`} style={{ "--provider-logo-size": `${size}px` }} title={title || undefined} aria-hidden="true">
      <Icon />
    </span>
  );
}
