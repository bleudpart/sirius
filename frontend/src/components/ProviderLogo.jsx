import { FaMicrosoft } from "react-icons/fa6";
import { SiGmail, SiGoogle } from "react-icons/si";
import "./ProviderLogo.css";

const PROVIDER_ICONS = {
  google: SiGoogle,
  gmail: SiGmail,
  microsoft: FaMicrosoft,
  outlook: FaMicrosoft,
};

export default function ProviderLogo({ provider, size = 20, title = "" }) {
  const Icon = PROVIDER_ICONS[provider] || FaMicrosoft;
  return (
    <span className={`provider-logo provider-logo-${provider}`} style={{ "--provider-logo-size": `${size}px` }} title={title || undefined} aria-hidden="true">
      <Icon />
    </span>
  );
}
