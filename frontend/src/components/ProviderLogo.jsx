import { FaMicrosoft } from "react-icons/fa6";
import { SiGoogle, SiGmail } from "react-icons/si";
import "./ProviderLogo.css";

const OutlookMark = () => (
  <span className="outlook-mark" aria-hidden="true">
    <i /><i /><i /><i />
  </span>
);

const PROVIDER_ICONS = {
  google: SiGoogle,
  gmail: SiGmail,
  microsoft: FaMicrosoft,
  outlook: OutlookMark,
};

export default function ProviderLogo({ provider, size = 20, title = "" }) {
  const Icon = PROVIDER_ICONS[provider] || FaMicrosoft;
  return (
    <span className={`provider-logo provider-logo-${provider}`} style={{ "--provider-logo-size": `${size}px` }} title={title || undefined} aria-hidden="true">
      <Icon />
    </span>
  );
}
