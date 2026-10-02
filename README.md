
# SIRIUS Assistant

Assistant vocal personnel avec HUD futuriste style « Iron Man ».
Frontend **React** + Backend **FastAPI** (Python), packagé en application Windows autonome via **Electron**.

© 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Voir [LICENSE](./LICENSE) et [CONTRAT_LICENCE.txt](./CONTRAT_LICENCE.txt).

![Logo SIRIUS](./frontend/public/icon-source.png)

---

## 🚀 Installation

### Option A — Installer SIRIUS comme un logiciel Windows (recommandé)

1. Ouvre le dossier `frontend` et double-clique sur **`BUILD.bat`**.
   Le script :
   - compile le HUD React,
   - transforme le backend Python en exécutable autonome (PyInstaller),
   - génère l'installateur **NSIS** et une version **portable** dans `frontend\dist`.
2. Dans `frontend\dist`, lance **`SIRIUS Setup 1.0.0.exe`** et suis l'assistant d'installation.
3. SIRIUS apparaît ensuite dans le menu Démarrer comme n'importe quel logiciel.

> L'application installée démarre elle-même son backend sur `127.0.0.1:8001`.
> Aucun serveur Python manuel n'est nécessaire. Les données, journaux et secrets
> restent dans ton dossier utilisateur Windows.

**Prérequis pour compiler** (uniquement pour créer l'installateur) :
- Node.js 18+ et Yarn (`npm install -g yarn`)
- Python 3.10+

Le logo bleu nuit de référence est `frontend/public/icon-source.png`. Après
une modification du logo, exécuter `frontend\scripts\generate-platform-icons.ps1`
depuis PowerShell avant de reconstruire les applications : le script régénère
les icônes Windows (installateur et portable), web/PWA et Android depuis
cette même source. L'image `frontend/public/play-store-icon.png` est
destinée à la fiche Google Play et n'est pas l'icône embarquée dans l'APK.

> 💾 **Aucun serveur de base de données requis** : sans MongoDB, SIRIUS bascule
> automatiquement sur une base SQLite locale (conversations, HACCP, fichiers…
> tout est persisté dans ton dossier utilisateur Windows).

### Option B — Mode développeur (sans installation)

**Backend :**
```
cd backend
pip install -r requirements-local.txt
```
> ⚠️ Utilise `requirements-local.txt` — pas `requirements.txt` (liste serveur avec paquets internes introuvables).

Crée `backend/.env` (copie `backend/.env.example`) :
```
MONGO_URL="mongodb://localhost:27017"
DB_NAME="sirius"
CORS_ORIGINS="*"
GROQ_API_KEY=...            # cerveau IA (seule clé obligatoire)
SERP_API_KEY=...            # optionnel · recherche web
GROQ_MODEL=llama-3.3-70b-versatile
SPOTIFY_CLIENT_ID=...       # optionnel · « qu'est-ce qui joue »
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://localhost:8001/api/spotify/callback
```
Puis lance :
```
uvicorn server:app --host 127.0.0.1 --port 8001 --no-proxy-headers
```

**Frontend :**
```
cd frontend
yarn install
yarn start
```
Le HUD s'ouvre sur `http://localhost:3000` et parle au backend local `127.0.0.1:8001`.

> 💡 Utilise **Chrome ou Edge** : la reconnaissance vocale s'appuie sur le navigateur (gratuit, instantané).

Guide détaillé : [INSTALL-SIRIUS.md](./INSTALL-SIRIUS.md)

Pour le déploiement en petite entreprise : [GUIDE-ENTREPRISE.md](./GUIDE-ENTREPRISE.md)

---

## Sécurité qualité avec SonarQube

Le dépôt contient une configuration SonarQube dans `sonar-project.properties`.
Avant une release sensible, lance le scan depuis une session PowerShell où le
token reste en variable d'environnement, jamais dans le dépôt :

```powershell
$env:SONAR_HOST_URL="http://localhost:9000"
$env:SONAR_TOKEN="<token-sonarqube>"
.\scripts\sonar-scan.ps1
```

Le script exécute `git diff --check`, une compilation Python ciblée, le build
frontend, puis `sonar-scanner`. Les dossiers de build, artefacts, dépendances,
données locales et secrets sont exclus du scan.

---

## ✨ Fonctionnalités

### Cœur du système
- **SIRIUS SETUP** — profil utilisateur, clés API, choix de la voix
- **Compagnon Dev** — analyse de code
- **Médiathèque / FILES** — gestion des fichiers et de l'audio
- **Architecte visuel** — diagrammes

### Intégré au HUD
- 🎙️ **Commande vocale** talkie-walkie (touche ESPACE) + synthèse vocale neurale (TTS)
- 🌦️ Météo temps réel, horloge, statistiques CPU/RAM
- 📰 **Briefing matinal** (recherche web + synthèse IA), actualités, documentaires, fiches pays
- 🎵 **Spotify** (lecture en cours), 📧 **Outlook** (mails & agenda)
- 📷 Vision caméra, mains holographiques 3D, fond antique, éclairs

### Modules MYTHOS & supervision
- **PANTHEON SYSTEM** — supervision globale
- **NEXUS CÉLESTE** — connexions inter-modules
- **ORACLE DIVIN** — prédictions, marchés
- **SIRIUS PRIME** — mémoire & apprentissage
- **ZEUS CORTEX** — cerveau visuel, iris humain

### Modules spécialisés
- **HACCP** — hygiène & sécurité alimentaire (formulaires 2026)
- **THÉMIS#** — devis, factures, paiements, pièces fournisseurs, journal comptable, synthèse TVA, rapprochement bancaire et bilan prévisionnel
- **ARGUS#** — surveillance & réparation système
- **LOCUS#** — géolocalisation & itinéraires
- **HERACLES#** — investigation OSINT
- **KERAUNOS#** — domotique Home Assistant (avec commandes vocales)
- **PLANS#** — plans 2D/3D de bâtiment : description naturelle → plan coté à l'échelle (vue 2D couleur + 3D isométrique), surfaces/périmètres calculés, export **DXF** (AutoCAD) et SVG — *« Sirius, dessine-moi le plan d'un garage de 6 sur 4 »*
- **TRAILER#** — clichés cinématiques · **PACKAGER#** — livrable multi-plateforme
- **Gestion de la mémoire** — souvenirs longue durée (pop-up « Mémoire enregistrée », tout reste sur ton PC)
- **Cerveau vectoriel** — rappel des souvenirs *par le sens*, **100 % hors-ligne** : modèle d'embeddings multilingue local (~130 Mo, téléchargé une fois), ~10 ms par rappel, sans clé API ; replis automatiques API Gemini puis mots-clés + synonymes
- Galerie MYTHOS, palette de commandes, veille proactive, modes système (normal / frugal / secours)
- **Dossiers intelligents** — dossiers métier et notes par utilisateur, propositions sourcées de stocks bas et factures échues THÉMIS, de DLC proches, non-conformités ouvertes et documents à échéance HACCP (selon les permissions). Le fil de travail associe sources, décisions motivées, engagements, réunions et tâches explicitement saisies, brouillons de relance/réapprovisionnement/contrôle, pistes de prochaine étape et simulations sans écriture. Un point de comparaison révèle les changements depuis la dernière visite ; un transfert entre métiers reste un dossier privé à reprendre manuellement. Les actions sont relues avant enregistrement et une confirmation supplémentaire n'envoie **jamais** de courrier, ne crée pas de commande et ne modifie pas HACCP. Une photo de terrain reste un aperçu local non téléversé ; la dictée n'est offerte que si le navigateur prend en charge la transcription locale. Les messages Outlook entrants ne sont pas parcourus automatiquement.
- **Journée ΣIRIUS et préparation métier** — synthèse des propositions autorisées, engagements confirmés et tâches saisies ; explication de chaque proposition (règle, seuil, source vérifiée et informations manquantes), avec possibilité de la reporter ou de la refuser en motivant le choix. Si la vue globale échoue, le repli sur le dossier sélectionné est signalé et ne montre que les engagements et tâches confirmés, sans date ou déjà échus. Les parcours préparent la couverture de stock uniquement à partir de ventes datées et vérifiées fournies explicitement, le rapprochement de pièces comptables, le journal d'arbitrages architecte, la relance commerciale et la révision rédactionnelle avec provenance, ainsi que les pièces pour une inspection HACCP sur un site et une période choisis. Les preuves sans attribution de site ne valent pas preuve pour ce site et aucune conformité n'est certifiée. Un **seul** message Outlook sélectionné dans la boîte de réception peut servir à préparer un brouillon temporaire, sans surveillance de boîte, envoi ni sauvegarde implicite. Les données absentes restent signalées comme telles ; aucune préparation n'exécute d'action métier.
- Le journal architecte accepte des références et versions de plan, devis et jalon **saisies par la personne** ; elles ne prouvent pas le contenu des pièces. Les sources THÉMIS/HACCP liées sont revérifiées et leurs changements signalés sans calculer automatiquement un coût ou un délai. La file de relecture privée rassemble les propositions à confirmer et les brouillons/transferts confirmés qui attendent une suite manuelle. Une suite déclarée hors de ΣIRIUS est conservée comme **déclaration utilisateur non vérifiée**, distincte d'une exécution par l'application.
- Le carnet client consigne uniquement les ventes, échanges, devis en attente, promesses de rappel ou questions **saisis puis confirmés volontairement** dans un dossier. Un suivi daté échu est affiché à la demande si la source client n'a pas changé, avec sa règle et les informations manquantes ; le consentement à contacter et le dernier échange ne sont pas déduits. Aucun message n'est envoyé automatiquement.
- **ASCLÉPIOS# · Bien-être & santé (guide pédagogique pour adultes)** — portrait dans la galerie MYTHOS et en colonne dans le module, comme les autres personnages du Panthéon ; séances illustrées de remise en mouvement, renforcement général ou pratique régulière pour la prise de masse, selon le temps et le matériel disponibles. Les variantes douce, courte ou habituelle sont proposées à partir du ressenti et de l'historique **local** puis choisies explicitement, jamais imposées. Progression manuelle, pause, ressenti et journal local par compte (suppression sur confirmation) ; aucune donnée sportive n'est envoyée au serveur ou utilisée pour les propositions proactives. Les schémas ne contrôlent pas la posture et les séances ne remplacent pas un avis médical.
- Si le backend local est interrompu pendant le chargement d'un module, FDE_OMEGA conserve l'erreur affichée et vérifie que la sonde `/health` indique `ok` avant de recharger via « Réessayer ». Il n'efface pas les données enregistrées ; les saisies non sauvegardées peuvent être perdues au rechargement.

### Multimédia
- **MEDIA PROXY** (menu `MEDIAS`) ou à la voix : *« Sirius, lance une musique lofi sur Spotify »*
- YouTube, Spotify, Twitch, TikTok, Deezer via leurs lecteurs officiels uniquement
- Synchronisation entre fenêtres via WebSocket

### Productivité & Travail
- Menu `OUTILS` ou à la voix : *« Sirius, ouvre mes notes »*, *« analyse ce document »*, *« montre mes tâches »*
- **DocAnalyzer**, **CodeAssist**, **SmartNotes**, **TaskMaster**, **ReportBuilder**
- Analyses 100 % locales : le code n'est jamais exécuté, aucune clé API supplémentaire

> **Limite comptable importante :** les fonctions de journal, TVA, rapprochement
> bancaire et bilan prévisionnel de THÉMIS sont des outils de suivi et de
> pilotage. Elles ne constituent pas une comptabilité légale certifiée, une
> déclaration fiscale officielle ou un remplacement d'un expert-comptable.

Liste complète des modules et dates : [MODULES_SIRIUS.txt](./MODULES_SIRIUS.txt)

---

## 🔧 Astuces

- **Mises à jour automatiques** : l'application installée vérifie les nouvelles versions sur
  [GitHub Releases](https://github.com/bleudpart/sirius/releases) au démarrage puis toutes les 4 h,
  télécharge en arrière-plan et propose le redémarrage (sinon installation à la fermeture).
  **Publier une nouvelle version :**
  1. Configure le jeton GitHub : `set GH_TOKEN=ton_token_github`
  2. Lance `RELEASE-SIRIUS-AUTO.bat` à la racine du projet, ou `npm run release:auto` depuis `frontend/`
  3. Le script augmente automatiquement `version`, compile le HUD/backend, puis publie la release.
     Pour une publication manuelle, utilise le nom exact de l'installateur indiqué
     dans `frontend\dist\latest.yml` et son fichier du même nom suivi de `.blockmap`.
     Vérifie la taille et le SHA-512 de l'installateur, publie les exécutables et
     le blockmap, puis `latest.yml` en dernier. Ne mélange pas les fichiers de
     builds différents. Le portable n'est pas utilisé par la mise à jour NSIS.
     Vérifie la signature avec `Get-AuthenticodeSignature` : un build réussi
     ne signifie pas qu'un exécutable est signé. La signature de production
     nécessite un certificat de signature de code reconnu ; conserve sa clé
     et son mot de passe hors du dépôt.
- **Android / Google Play** : depuis `frontend`, `npm run mobile:apk` produit
  un APK **debug**, réservé aux tests et non publiable sur Google Play.
  `npm run mobile:apk:release` produit un APK release signé et `npm run mobile:play`
  un Android App Bundle (AAB) signé. Ces deux commandes exigent
  `SIRIUS_ANDROID_KEYSTORE`, `SIRIUS_ANDROID_STORE_PASSWORD`,
  `SIRIUS_ANDROID_KEY_ALIAS` et `SIRIUS_ANDROID_KEY_PASSWORD` ; les tâches Gradle
  release refusent aussi de démarrer sans cette configuration.
  Ne versionne jamais le keystore ni ses mots de passe. Pour une application
  déjà publiée, utilise sa clé d'upload existante, pas une nouvelle clé.
  La signature ne remplace pas les validations et exigences de la Play Console.
- **Son de démarrage personnalisé** : place un fichier `boot-sound.mp3` (libre de droits) dans `frontend/public/`. Activable dans **Configuration → « Son de démarrage »**.
- **Sauvegarde de la mémoire locale** (SQLite) avec Sirius Doctor :
  ```
  cd backend
  python sirius_doctor.py backup    # instantané + manifeste SHA-256
  python sirius_doctor.py check     # contrôle sans sauvegarde
  ```
- **Spotify** : enregistre ta Redirect URI locale dans le Dashboard Spotify et ajoute ton compte (User Management, mode Development).
