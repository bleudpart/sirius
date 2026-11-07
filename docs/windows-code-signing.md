# Signature et publication Windows de ΣIRIUS

## Architecture détectée

- Interface : React 19, `react-scripts` 5 et CRACO 7 (**pas Vite** dans ce dépôt).
- Bureau : Electron et Electron Builder, configuration dans `frontend/package.json`.
- Backend : Python/FastAPI, PyInstaller via `frontend/scripts/build-backend.js`
  et `backend/sirius-backend.spec`. Deux exécutables Python et Chromium sont
  embarqués dans `resources/backend`.
- Livrables Windows x64 : NSIS `sirius-setup-X.Y.Z.exe` et
  `SIRIUS-Portable-X.Y.Z.exe`. Aucun MSI n'est actuellement généré.
  Le scanner signe/vérifie aussi les `.msi` si une cible MSI est ajoutée.
- Capacitor Android/iOS est indépendant de cette chaîne Windows.

## Prérequis : choisir le bon certificat

**Ne pas acheter un certificat en supposant que sa clé sera exportable en PFX.**
Les exigences CA/B Forum imposent une protection matérielle des clés de
signature publiques modernes, y compris les certificats OV. Un certificat
EV sur token USB n'est pas reconstructible depuis un secret Base64 sur un
runner GitHub hébergé.

Le workflow fourni réalise le mode **PFX exportable demandé**. Il ne convient
à la distribution publique que si votre autorité autorise ce mode de stockage
pour votre certificat et que la chaîne est reconnue par Windows. Un PFX
auto-signé ou issu d'une PKI privée ne donne pas une confiance publique
SmartScreen/Smart App Control. Le workflow refuse une chaîne non approuvée
et ne modifie jamais les racines de confiance Windows pour faire passer un test.
Sans certificat et sans secrets configurés, il ne produit pas de release signée ;
un build local ordinaire reste non signé et peut afficher des avertissements Windows.

Une autre solution est **Microsoft Artifact Signing**
(anciennement Trusted Signing), ou un service de signature avec HSM et
authentification GitHub OIDC. Vérifier l'éligibilité selon le pays et le type
de compte avant toute inscription ou dépense. Cela évite de conserver une clé
privée exportable dans GitHub. Ce mode nécessite un compte et un profil de signature validés :
il ne peut pas être activé uniquement en renommant les secrets PFX.
Electron Builder dispose de `win.azureSignOptions`, qui ne doit pas être
combiné avec `win.signtoolOptions`. Les hooks de signature du backend et les
contrôles après compilation restent nécessaires après cette migration.
Les profils à certificats éphémères demandent aussi une vérification de
l'identité/chaîne adaptée, plutôt que l'empreinte fixe du mode PFX.

La publication via Microsoft Store constitue une autre piste : le Store signe
les packages qu'il accepte. Elle nécessite un compte approuvé et une adaptation
de l'application ; ce dépôt ne génère pas encore de package Store.

## Arborescence des fichiers modifiés ou ajoutés

```text
.github/
  workflows/
    windows-release.yml                 nouveau workflow complet
    sirius-audit.yml                     tests des gardes dans l'audit existant
.gitignore                              exclusion des PFX/P12
README.md                               liens et procédure de release actualisés
RELEASE-SIRIUS-AUTO.bat                  publication locale signée obligatoire
docs/
  windows-code-signing.md                ce guide
frontend/
  package.json                          scripts signés et releases sécurisées
  scripts/
    build-signed-windows.cjs             hooks Electron Builder + release locale
    build-signed-windows.test.cjs        tests des hooks
scripts/
  windows-code-signing.ps1               import, signature, vérification, nettoyage
  test_windows_code_signing.ps1          tests sans clé ni modification de confiance
  stage_windows_release.py              contrôle SHA-512/SHA-256 et staging
  test_windows_release.py               tests des artefacts et du workflow
```

Le [workflow complet](../.github/workflows/windows-release.yml) et les
[commandes PowerShell implémentées](../scripts/windows-code-signing.ps1)
constituent la source de vérité, sans copie divergente dans cette documentation.
Le lock npm ne change pas pour ces ajouts de scripts : aucune dépendance npm
n'est ajoutée. La configuration cible **Electron Builder 26.18.0**, présent
dans l'arbre de travail analysé. Sa montée de version, le lock correspondant
et `frontend/patches/app-builder-lib+26.18.0.patch` étaient déjà en cours avant
ce travail : les publier ensemble, sans réintroduire l'ancien patch 24.13.3.
Ne pas appliquer seulement les hooks `signtoolOptions` à l'ancien Builder.
Les autres modifications préexistantes ne sont pas supprimées par cette chaîne.

## Secrets et protections GitHub

Dans **Settings → Environments**, créer `windows-signing` et limiter ses
déploiements aux **tags `v*`**, jamais aux branches de PR. Protéger aussi la
création/modification/suppression de ces tags avec un ruleset, ainsi que
`master` et les changements des workflows/hooks. Ajouter des reviewers de
déploiement si une approbation humaine est souhaitée ; sans reviewers, un
tag autorisé lance automatiquement la chaîne.

Créer ces **environment secrets** dans `windows-signing` :

| Secret | Valeur |
| --- | --- |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | PFX chiffré encodé en Base64, sans en-tête |
| `WINDOWS_CERTIFICATE_PASSWORD` | Mot de passe fort du PFX |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | Empreinte SHA-1 du certificat de signature, 40 caractères hexadécimaux sans espaces |

L'empreinte SHA-1 sert **uniquement de sélecteur de certificat**. Les signatures
de fichiers et les horodatages utilisent SHA256.

Le jeton `GITHUB_TOKEN` est fourni automatiquement : aucun PAT de publication
n'est requis dans Actions. Seul le job `publish` dispose de `contents: write`.
Les clés API de production de ΣIRIUS ne sont pas nécessaires à cette compilation.

**Base64 n'est pas un chiffrement.** Conserver le PFX chiffré et son mot de passe
hors du dépôt, ne jamais les coller dans un ticket/chat et ne jamais activer
de traces de commandes contenant des secrets. Les secrets GitHub sont limités
à 48 Ko chacun : un PFX Base64 trop gros doit être remplacé par une méthode
de signature distante, pas découpé dans le code source.

### Préparer les secrets depuis son poste Windows

Ces commandes utilisent le presse-papiers, pas les logs ni un fichier Base64
dans le dépôt. Exécuter uniquement sur votre poste de confiance :

```powershell
$pfx = "C:\Certificats\sirius-codesign.pfx"
$bytes = [IO.File]::ReadAllBytes($pfx)
try {
    [Convert]::ToBase64String($bytes) | Set-Clipboard
} finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
}
# Coller dans WINDOWS_CERTIFICATE_PFX_BASE64 dans l'environnement GitHub.
# Vider le presse-papiers ensuite.
Set-Clipboard -Value ""
```

Pour identifier le certificat **sans afficher ni passer le mot de passe
en ligne de commande** :

```powershell
$password = Read-Host "Mot de passe du PFX" -AsSecureString
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $pfx, $password,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
)
try {
    $certificate.Thumbprint | Set-Clipboard
    # Coller dans WINDOWS_CERTIFICATE_THUMBPRINT.
} finally {
    $certificate.Dispose()
    $password.Dispose()
}
```

Saisir le mot de passe séparément dans `WINDOWS_CERTIFICATE_PASSWORD`.

## Fonctionnement du workflow

1. Tag `vX.Y.Z` correspondant exactement à `frontend/package.json`, dont le
   commit appartient à `origin/master`. Un dispatch sur une branche est refusé.
2. Runner éphémère Windows Server 2022 x64 avec Windows SDK : compilation d'une
   application compatible Windows 11, pas exécution d'un test sur Windows 11.
3. Installation npm depuis le lock ; installation des manifests Python
   serveur, local, build et identité vocale pour inclure les modules desktop.
   Tests frontend, backend ciblés et gardes de signature.
4. Installation du Chromium correspondant à Playwright, puis build React
   et PyInstaller **sans exposer le PFX aux étapes d'installation/tests**.
5. Reconstruction du PFX dans `RUNNER_TEMP`, validation de l'empreinte, de
   la clé privée, des dates, de l'EKU Code Signing et de la chaîne/révocation.
   Import non exportable dans `Cert:\CurrentUser\My` ; le PFX temporaire est
   immédiatement supprimé. Le mot de passe n'est jamais un argument SignTool.
6. `afterPack` signe en un seul lot les `.exe`, `.msi`, `.dll` et `.pyd` du
   dossier `win-unpacked` (ressources Python/Chromium comprises), **sauf
   l'exécutable Electron principal** : electron-builder édite ensuite ses
   ressources avec `resedit`, qui refuse un exécutable déjà signé. Le hook
   `win.signtoolOptions.sign` (emplacement exigé par electron-builder 26 ;
   `win.sign` est rejeté par son schéma) signe cet exécutable après
   l'édition, puis le désinstalleur NSIS et les artefacts finaux.
   `forceCodeSigning: true` interdit une release sans signature.
   `build-signed-windows.cjs` ne transmet que ces surcharges : electron-builder
   fusionne lui-même le champ `build` de `package.json`.
7. Signature SHA256 et horodatage RFC 3161 SHA256 :

   ```powershell
   & $env:SIRIUS_SIGNTOOL_PATH sign /s My /sha1 $env:SIRIUS_SIGNING_THUMBPRINT `
       /fd SHA256 /tr https://timestamp.digicert.com /td SHA256 `
       /d SIRIUS "C:\Build\sirius-setup-1.2.3.exe"
   if ($LASTEXITCODE -ne 0) { throw "Signature ou horodatage échoué." }
   ```

8. Vérification SignTool `/pa /all /tw` et Authenticode : chaîne valide,
   certificat attendu et horodatage présent. Tout code SignTool non nul,
   **y compris l'avertissement 2**, fait échouer le workflow.
9. Contrôle du SHA-512 et de la taille NSIS dans `latest.yml`, staging des
   fichiers finaux, blockmap, métadonnées, rapport des signatures et
   `SHA256SUMS.txt`. **Aucun octet des exécutables n'est modifié après ce point.**
10. Nettoyage du certificat et de sa clé privée avec `always()`, même après
    une erreur. Si le nettoyage échoue, le job échoue aussi et ne publie pas.
    Le runner hébergé est éphémère ; une interruption brutale n'offre pas la
    même garantie sur un runner auto-hébergé, qui n'est pas prévu ici.
11. Le job de publication, sans PFX ni mot de passe, télécharge l'artefact,
    revérifie les signatures et toutes les empreintes, crée une release
    **draft**, téléverse tous les assets puis la rend publique. Une release
    existante n'est jamais écrasée. Si une création échoue, vérifier/supprimer
    manuellement le brouillon incomplet avant une relance.

Les DLL/PYD embarquées sont signées avec votre certificat, y compris celles
des fournisseurs ; cela ne change ni leur licence ni leur auteur. L'identité
Windows indique l'éditeur du paquet distribué. Tester les composants natifs
sur une machine propre après cette transformation.

### Scripts package.json

```json
{
  "signing:check": "node scripts/build-signed-windows.cjs --check",
  "electron:build:signed": "npm run signing:check && npm run build && npm run backend:build && node scripts/build-signed-windows.cjs",
  "release:auto": "npm run signing:check && npm run version:bump && npm run release",
  "release": "npm run signing:check && npm run build && npm run backend:build && node scripts/build-signed-windows.cjs --publish always"
}
```

Le script de build signé crée une configuration Electron Builder adaptée à
la version réellement installée : `forceCodeSigning`, hooks de signature,
SHA256, identité de l'éditeur déduite du certificat et contrôle de la signature
des mises à jour activé. Le build local ordinaire `npm run electron:build`
reste non signé par défaut. Ne pas distribuer celui-ci comme release signée.
La publication locale utilise `gh` **après** toutes les vérifications et
exige un tag distant existant ; Electron Builder ne publie jamais pendant
la construction.

## Déclencher une version

Depuis une branche `master` à jour, après tests et commit des modifications :

```powershell
Set-Location "C:\ZEUS-S-I-R-I-U-S-SIRIUS-HACCP-forms-2026\frontend"
npm run version:bump
# Vérifier et commiter les fichiers de version générés selon la procédure du dépôt.
# Publier le commit sur master, puis créer le tag correspondant.
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
git tag "v$version"
git push origin "v$version"
```

Ne pas utiliser ces commandes tant que les secrets/protections ne sont pas
configurés. Le tag doit viser le commit contenant le bump, pas son parent.
Pour une relance manuelle : choisir le tag dans **Actions → Windows signed
release → Run workflow**. La relance refuse d'écraser une release déjà publiée.

## Vérification locale des signatures

Installer le Windows SDK, puis depuis la racine du dépôt :

```powershell
$env:SIRIUS_SIGNING_THUMBPRINT = "EMPREINTE_HEXADECIMALE_40_CARACTERES"
# La variable SIRIUS_SIGNTOOL_PATH est facultative pour Verify : le SDK x64
# le plus récent est découvert automatiquement.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File .\scripts\windows-code-signing.ps1 `
    -Action Verify -TargetPath ".\frontend\dist"
if ($LASTEXITCODE -ne 0) { throw "Une signature est invalide." }
```

L'autorisation `ExecutionPolicy Bypass` est limitée à ce processus PowerShell
pour exécuter le script contrôlé ; aucune politique système, SmartScreen ou
Smart App Control n'est désactivée.

Contrôle manuel d'un fichier téléchargé :

```powershell
$file = "C:\Downloads\sirius-setup-1.2.3.exe"
Get-AuthenticodeSignature -LiteralPath $file |
    Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate

$tool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
& $tool verify /pa /all /tw /v $file
if ($LASTEXITCODE -ne 0) { throw "Signature non approuvée ou horodatage manquant." }
Get-FileHash -LiteralPath $file -Algorithm SHA256
```

Comparer l'empreinte de fichier à `SHA256SUMS.txt`, l'éditeur au certificat
attendu, et vérifier aussi `resources\backend` **après installation**.
Tester la désinstallation NSIS et la version portable sur une machine Windows
11 propre, avec Smart App Control actif et un fichier téléchargé conservant
son marquage d'origine Internet.

Pour un build signé local, importer votre certificat avec
`Import-PfxCertificate -Password (Read-Host -AsSecureString)` dans
`Cert:\CurrentUser\My`, définir `SIRIUS_SIGNTOOL_PATH`,
`SIRIUS_SIGNING_THUMBPRINT` et `SIRIUS_SIGNING_PUBLISHER` exactement comme
le CN du certificat, puis `npm run electron:build:signed`. Ne pas utiliser
`Prepare/Cleanup` sur votre magasin de certificats personnel : ces actions
sont réservées au runner éphémère.

## SmartScreen et Smart App Control

- Utiliser un certificat **Code Signing de confiance publique** ou Artifact
  Signing Public Trust. Un certificat TLS ne convient pas.
- Conserver une identité légale d'éditeur stable, un `appId` stable et des
  versions/noms de fichiers cohérents. Planifier le renouvellement et tester
  la vérification des mises à jour Electron lors d'un changement d'éditeur.
- Signer le code natif interne, les exécutables Python, le désinstalleur et
  les conteneurs finaux, pas seulement l'installateur extérieur.
- Horodater chaque signature et vérifier après toutes les opérations
  d'édition/compression. Ne jamais signer a posteriori un installateur dont
  `latest.yml` et le blockmap ont déjà été publiés.
- Éviter UPX et les transformations/obfuscations inutiles en production ;
  évaluer leur désactivation dans le spec PyInstaller après mesure de la taille.
  Les builds PyInstaller ne gagnent pas automatiquement une bonne réputation.
- Publier depuis GitHub Releases et des domaines HTTPS stables. Soumettre les
  faux positifs à Microsoft avec les fichiers exacts concernés. Un scan
  antivirus favorable ne remplace pas une signature ni une validation SAC.
- Ne pas contourner les protections Windows, retirer le marquage Internet
  pour masquer un problème ou recommander de désactiver SAC.

**Ni OV, ni EV, ni la signature seule ne garantissent l'absence d'avertissement
SmartScreen.** La réputation dépend aussi du fichier, de l'éditeur, de la
distribution et des détections. SAC est un contrôle distinct : une signature
valide est importante, mais les dépendances chargées doivent également être
conformes. Microsoft documente actuellement la prise en charge RSA et ECC
pour SAC ; RSA/SHA256 reste un choix largement compatible avec l'outillage.

## Validation et limites d'activation

```powershell
node --test frontend\scripts\build-signed-windows.test.cjs
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File scripts\test_windows_code_signing.ps1
python -m unittest discover -s scripts -p test_windows_release.py
```

Ces tests utilisent des fixtures et des commandes simulées : ils ne signent
pas de release et n'installent aucune racine de confiance sur le poste.
La preuve de production exige ensuite un run GitHub réussi avec votre vrai
certificat et un test Windows 11 propre. Sans secrets/certificat, la chaîne
doit échouer, pas produire un faux artefact « signé ».

Références :

- [SignTool et ses codes de retour](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Signature pour Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)
- [Microsoft Defender SmartScreen](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)
- [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)
- [Exigences Code Signing CA/B Forum](https://cabforum.org/working-groups/code-signing/requirements/)
