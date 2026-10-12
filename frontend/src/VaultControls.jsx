import { useState } from "react";
import { decryptVault, encryptVault, parseVault, validateVaultKeys } from "@/configurationVault";
import {
  deviceKeysStorageKey, forgetPersonalKeys, hasSavedPersonalKeys, loadApiKeys, readLegacyKeys,
  readStoredVault, removeStoredVault, savePersonalKeys,
} from "@/apiKeyStorage";

// Teste puis enregistre les clés sur l'appareil. Renvoie null si l'utilisateur annule.
export async function persistPersonalKeys(keys, validateKeys) {
  const storageKey = deviceKeysStorageKey();
  const next = validateVaultKeys(keys);
  const unverified = Object.values(next).some(Boolean) ? await validateKeys(next) : [];
  if (unverified?.length && !window.confirm(`Vérification impossible pour : ${unverified.join(", ")}. Enregistrer quand même ces clés ? Vous pourrez les retester plus tard.`)) {
    return null;
  }
  const saved = await savePersonalKeys(next, storageKey);
  return { saved, unverified: unverified || [] };
}

function safeLegacyKeys() {
  try { return readLegacyKeys(); } catch { return null; }
}

function safeOldVault() {
  try { return readStoredVault(); } catch { return null; }
}

export default function VaultControls({ onKeys, validateKeys, children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [password, setPassword] = useState("");
  const [backupFile, setBackupFile] = useState(null);
  const [savedOnDevice, setSavedOnDevice] = useState(hasSavedPersonalKeys);
  const oldVault = safeOldVault();
  const legacyKeys = safeLegacyKeys();

  const run = async (operation) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (failure) { setError(failure.message || "Enregistrement des clés impossible."); }
    finally { setBusy(false); setSavedOnDevice(hasSavedPersonalKeys()); }
  };

  const applyKeys = async (next, message) => {
    const result = await persistPersonalKeys(next, validateKeys);
    if (!result) { setNotice("Enregistrement annulé."); return; }
    onKeys(loadApiKeys());
    const pending = result.unverified.length ? ` Non vérifiées : ${result.unverified.join(", ")}.` : "";
    setNotice(Object.keys(result.saved).length ? `${message}${pending}` : "Clés effacées de cet appareil.");
  };

  const requirePassword = () => {
    if (password.length < 12) throw new Error("Saisissez un mot de passe de 12 caractères minimum.");
  };

  const exportBackup = () => run(async () => {
    requirePassword();
    const current = loadApiKeys();
    if (!Object.values(current).some(Boolean)) throw new Error("Enregistrez d'abord vos clés.");
    const content = JSON.stringify(await encryptVault(current, password));
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "sirius.vault";
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    setPassword("");
    setNotice("Sauvegarde téléchargée. Gardez ce mot de passe : il sera demandé pour la restaurer.");
  });

  const restoreBackup = () => run(async () => {
    if (!backupFile) throw new Error("Choisissez d'abord le fichier sirius.vault.");
    requirePassword();
    if (backupFile.size > 128 * 1024) throw new Error("Fichier trop volumineux.");
    const next = await decryptVault(parseVault(await backupFile.text()), password);
    setPassword(""); setBackupFile(null);
    await applyKeys(next, "Sauvegarde restaurée et enregistrée sur cet appareil.");
  });

  const recoverOldVault = () => run(async () => {
    requirePassword();
    const next = await decryptVault(parseVault(oldVault), password);
    setPassword("");
    await applyKeys(next, "Ancien coffre récupéré. Plus besoin de mot de passe.");
    removeStoredVault();
  });

  const recoverLegacy = () => run(async () => {
    if (!window.confirm("Reprendre les anciennes clés enregistrées sur cet appareil ?")) return;
    await applyKeys(legacyKeys, "Anciennes clés reprises et enregistrées.");
  });

  const forget = () => run(async () => {
    if (!window.confirm("Effacer vos clés personnelles de cet appareil ?")) return;
    forgetPersonalKeys();
    onKeys(loadApiKeys());
    setNotice("Clés effacées de cet appareil.");
  });

  return (
    <section data-testid="vault-controls">
      <h2>Mes clés personnelles</h2>
      <p className="setup-note">Collez votre clé, puis cliquez sur « ENREGISTRER » en bas. C'est tout : elle reste chiffrée sur cet appareil et se recharge toute seule.</p>
      {savedOnDevice && <p className="fw-status ok" data-testid="vault-saved-status">✓ Vos clés sont enregistrées sur cet appareil.</p>}
      <fieldset className="vault-key-fields" disabled={busy}>{children}</fieldset>
      {busy && <p role="status">Opération en cours…</p>}
      {error && <p className="fw-status ko" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <details data-testid="vault-advanced">
        <summary>Avancé : sauvegarde, autre appareil, effacement</summary>
        <p className="setup-note">Utile seulement pour changer d'appareil. Le fichier de sauvegarde est protégé par un mot de passe que vous choisissez.</p>
        <label className="setup-label" htmlFor="vault-password">Mot de passe de la sauvegarde (12 caractères minimum)</label>
        <input id="vault-password" className="setup-input" type="password" autoComplete="off" value={password}
          onChange={(event) => setPassword(event.target.value)} data-testid="vault-password" disabled={busy} />
        <div className="setup-actions">
          <button type="button" className="setup-io-btn" onClick={exportBackup} disabled={busy} data-testid="vault-export">Télécharger une sauvegarde</button>
        </div>
        <label className="setup-label">Restaurer une sauvegarde (sirius.vault)
          <input type="file" accept=".vault" disabled={busy} data-testid="vault-import"
            onChange={(event) => { setBackupFile(event.target.files?.[0] || null); event.target.value = ""; }} />
        </label>
        {backupFile && <button type="button" className="setup-io-btn" onClick={restoreBackup} disabled={busy} data-testid="vault-restore">Restaurer {backupFile.name}</button>}
        {oldVault && <button type="button" className="setup-io-btn" onClick={recoverOldVault} disabled={busy} data-testid="vault-recover-old">Récupérer mon ancien coffre (mot de passe une dernière fois)</button>}
        {legacyKeys && <button type="button" className="setup-io-btn" onClick={recoverLegacy} disabled={busy}>Reprendre mes anciennes clés</button>}
        <div className="setup-actions">
          <button type="button" className="setup-io-btn" onClick={forget} disabled={busy} data-testid="vault-forget">Effacer mes clés de cet appareil</button>
        </div>
      </details>
    </section>
  );
}
