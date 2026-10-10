import { useState } from "react";
import { checkVaultPassword, decryptVault, encryptVault, parseVault, validateVaultKeys } from "@/configurationVault";
import { assertKeyAccount, loadApiKeys, lockApiKeys, readLegacyKeys, readStoredVault, removeLegacyKeys, saveApiKeys, storeVault, vaultStorageKey } from "@/apiKeyStorage";

export default function VaultControls({ keys, onKeys, validateKeys, children }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(null);

  const run = async (operation) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(vaultStorageKey()); }
    catch (failure) { setError(failure.message || "Opération du coffre impossible."); }
    finally { setBusy(false); setPassword(""); setConfirmation(""); }
  };
  const validateForStorage = async (next) => {
    const unverified = await validateKeys(next);
    if (!unverified?.length) return "";
    const accepted = window.confirm(`Vérification impossible pour : ${unverified.join(", ")}. Enregistrer ces clés dans le coffre sans les déclarer fonctionnelles ? Vous devrez les retester avant utilisation.`);
    if (!accepted) setNotice("Enregistrement annulé : les clés non vérifiées n'ont pas été activées.");
    return accepted ? ` Services non vérifiés : ${unverified.join(", ")}. Retestez-les ensuite.` : null;
  };
  const protect = () => run(async (accountKey) => {
    if (password !== confirmation) throw new Error("Les mots de passe du coffre ne correspondent pas.");
    checkVaultPassword(password);
    const next = validateVaultKeys(keys);
    if (!Object.values(next).some(Boolean)) throw new Error("Renseignez au moins une clé personnelle.");
    const existing = readStoredVault();
    if (existing && !window.confirm("Remplacer le coffre personnel de ce compte sur cet appareil ?")) return;
    const verification = await validateForStorage(next);
    if (verification === null) return;
    const envelope = await encryptVault(next, password);
    storeVault(envelope, accountKey);
    saveApiKeys(next); onKeys(next);
    removeLegacyKeys();
    setNotice(`Coffre chiffré enregistré. Clés déverrouillées pour cette session.${verification}`);
  });
  const unlock = () => run(async (accountKey) => {
    const stored = readStoredVault();
    if (!stored) throw new Error("Aucun coffre enregistré pour ce compte sur cet appareil.");
    const next = await decryptVault(parseVault(stored), password);
    assertKeyAccount(accountKey);
    saveApiKeys(next); onKeys(next);
    setNotice("Coffre déverrouillé pour cette session.");
  });
  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await run(async () => {
      if (file.size > 128 * 1024) throw new Error("Coffre trop volumineux.");
      setPending(parseVault(await file.text()));
      setNotice("Coffre chargé. Saisissez son mot de passe pour examiner son contenu.");
    });
  };
  const openPending = () => run(async (accountKey) => {
    const next = await decryptVault(pending, password);
    const services = Object.keys(next).filter((name) => next[name]).join(", ");
    if (!window.confirm(`Importer les services personnels suivants : ${services} ? Le coffre de ce compte sera remplacé, pas la configuration du serveur.`)) return;
    const verification = await validateForStorage(next);
    if (verification === null) return;
    storeVault(pending, accountKey); saveApiKeys(next); onKeys(next); removeLegacyKeys(); setPending(null);
    setNotice(`Coffre importé et déverrouillé.${verification}`);
  });
  const exportFile = () => run(async () => {
    const stored = readStoredVault();
    if (!stored) throw new Error("Protégez et enregistrez vos clés avant d'exporter le coffre.");
    parseVault(stored);
    const url = URL.createObjectURL(new Blob([stored], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "sirius.vault";
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    setNotice("Coffre chiffré exporté. Les modifications non enregistrées n'y figurent pas.");
  });
  const migrate = () => run(async () => {
    const legacy = readLegacyKeys();
    if (!legacy) throw new Error("Aucune ancienne clé enregistrée sur cet appareil.");
    if (!window.confirm("Charger les anciennes clés de cet appareil ? Confirmez qu'elles vous appartiennent. Elles ne seront utilisées qu'après protection du coffre.")) return;
    onKeys(legacy); lockApiKeys();
    setNotice("Anciennes clés chargées pour migration. Testez-les puis protégez le coffre ; l'ancienne copie sera ensuite effacée.");
  });
  return (
    <section data-testid="vault-controls">
      <h2>Mes clés personnelles</h2>
      <details data-testid="vault-quick-guide">
        <summary>Guide rapide : configurer SIRIUS sans modifier de fichiers</summary>
        <ol>
          <li>Pendant l'essai de 7 jours, utilisez les services autorisés sans copier les clés de SIRIUS.</li>
          <li>Pour la suite, cliquez sur « obtenir » uniquement pour les services utiles et créez vos clés sur leurs sites.</li>
          <li>Collez vos clés ici et cliquez sur « TESTER ».</li>
          <li>Choisissez et confirmez un mot de passe de coffre, puis cliquez sur « Protéger et enregistrer ».</li>
          <li>Aux prochaines sessions, déverrouillez le coffre : inutile de recopier les clés.</li>
        </ol>
        <p>Vous avez déjà un fichier sirius.vault ? Importez-le, saisissez son mot de passe et confirmez les services à restaurer.</p>
        <p>La création des comptes et des clés chez les fournisseurs reste nécessaire. Vérifiez leurs tarifs.</p>
      </details>
      <p className="setup-note">Créez les clés chez les fournisseurs via « obtenir », puis testez les services souhaités. Aucun service facultatif n'est obligatoire.</p>
      <p className="setup-note">Les clés sont chiffrées sur cet appareil avec le mot de passe du coffre. Après déverrouillage, elles sont envoyées au backend SIRIUS pour appeler les fournisseurs. Ne déverrouillez le coffre que sur un serveur de confiance.</p>
      <fieldset className="vault-key-fields" disabled={busy}>{children}</fieldset>
      <label className="setup-label" htmlFor="vault-password">Mot de passe du coffre (12 caractères minimum)</label>
      <input id="vault-password" className="setup-input" type="password" autoComplete="off" value={password}
        onChange={(event) => setPassword(event.target.value)} data-testid="vault-password" disabled={busy} />
      <label className="setup-label" htmlFor="vault-confirm">Confirmation pour créer ou remplacer le coffre</label>
      <input id="vault-confirm" className="setup-input" type="password" autoComplete="off" value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)} data-testid="vault-confirm" disabled={busy} />
      <div className="setup-actions">
        <button type="button" className="setup-io-btn" onClick={protect} disabled={busy} data-testid="vault-save">Protéger et enregistrer</button>
        <button type="button" className="setup-io-btn" onClick={unlock} disabled={busy} data-testid="vault-unlock">Déverrouiller</button>
        <button type="button" className="setup-io-btn" disabled={busy} onClick={() => {
          lockApiKeys(); onKeys(loadApiKeys()); setNotice("Clés verrouillées. Le coffre chiffré est conservé.");
        }}>Verrouiller</button>
        <button type="button" className="setup-io-btn" onClick={exportFile} disabled={busy}>Exporter le coffre</button>
        <button type="button" className="setup-io-btn" onClick={migrate} disabled={busy}>Migrer mes anciennes clés</button>
      </div>
      <label className="setup-label">Importer un coffre chiffré
        <input type="file" accept=".vault" onChange={importFile} disabled={busy} data-testid="vault-import" />
      </label>
      {pending && <button type="button" className="setup-io-btn" onClick={openPending} disabled={busy}>Déverrouiller et confirmer l'import</button>}
      {busy && <p role="status">Vérification des services, chiffrement ou déverrouillage en cours…</p>}
      {error && <p className="fw-status ko" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p className="setup-note">Conservez ce mot de passe : il n'est pas celui du compte SIRIUS et n'est pas récupérable ici. Le coffre ne sauvegarde pas vos droits administrateur.</p>
    </section>
  );
}
