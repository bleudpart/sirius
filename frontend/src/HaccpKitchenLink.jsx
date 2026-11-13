import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { LoaderCircle } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";

const API = `${API_BASE_URL}/haccp/cuisine/lien`;
const read = async (response) => (await checkHaccpResponse(response)).json();

// Panneau chef : créer, afficher ou désactiver le QR code Cuisine.
export default function HaccpKitchenLink({ establishmentName = "" }) {
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    haccpFetch(API, {}, read)
      .then((current) => { if (mounted.current) setLink(current); })
      .catch((failure) => { if (mounted.current) setError(failure.message); })
      .finally(() => { if (mounted.current) setBusy(false); });
    return () => { mounted.current = false; };
  }, []);
  const run = async (options, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setError("");
    try {
      const next = await haccpFetch(API, options, read);
      if (mounted.current) setLink(next);
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const create = (confirmText) => run({
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ restaurant_name: establishmentName.trim() }),
  }, confirmText);

  return <section className="workspace-surface haccp-card haccp-qr" aria-label="QR code Cuisine">
    <p className="haccp-kicker">Accès cuisine · sans compte</p>
    <h3>QR code Cuisine</h3>
    {busy && !link && <p role="status"><LoaderCircle className="haccp-loading" size={28} aria-hidden="true" /></p>}
    {link?.active && <>
      <div className="haccp-qr-code"><QRCodeSVG value={link.url} size={240} marginSize={4} /></div>
      <p>Restaurant : <strong>{link.restaurant_name}</strong></p>
      <ol>
        <li>Le cuisinier scanne ce QR code avec l’appareil photo de son téléphone ou de la tablette.</li>
        <li>La page s’ouvre avec PHOTO, OUVERTURE, PRÉPARATION, RETROUVER et RELEVÉS, sans compte ni mot de passe.</li>
        <li>Menu du navigateur → « Ajouter à l’écran d’accueil ». C’est fait pour toujours.</li>
      </ol>
      <p>Ce QR code permet de photographier les réceptions, de créer les étiquettes d’ouverture et de préparation, de remplir les relevés et d’en demander l’impression sur le PC ΣIRIUS du restaurant (laissez-le allumé, ΣIRIUS ouvert). Ne l’affichez pas à la vue des clients.</p>
      <p>Réception : étiquette, facture ou bon de livraison photographié et classé automatiquement dans l’établissement. Ouverture : DLC calculée depuis la consigne fabricant lisible, sans saisie de durée ; sans consigne exploitable, aucune étiquette d’utilisation. Seule la préparation nécessite une saisie.</p>
      <div className="haccp-actions">
        <button type="button" disabled={busy} onClick={() => run({ method: "DELETE" },
          "Désactiver le QR code ? Les téléphones qui l’utilisent ne pourront plus accéder à l’espace cuisine.")}>Désactiver</button>
        <button type="button" disabled={busy || !establishmentName.trim()} onClick={() => create(
          "Créer un nouveau QR code ? L’ancien ne marchera plus : il faudra rescanner sur chaque téléphone.")}>Nouveau QR code</button>
      </div>
    </>}
    {link && !link.active && <>
      <p>Aucun QR code actif. Les cuisiniers n’ont besoin ni de compte ni de mot de passe.</p>
      {!establishmentName.trim() && <p role="alert">Choisissez d’abord l’établissement ci-dessus.</p>}
      <button type="button" disabled={busy || !establishmentName.trim()} onClick={() => create()}>
        Créer le QR code pour {establishmentName.trim() || "le restaurant"}
      </button>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
