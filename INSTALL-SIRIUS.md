# SIRIUS — Installation locale (Windows)

Assistant vocal HUD style Iron Man. Frontend React + Backend FastAPI (+ Electron pour le .exe).

---

## Guide rapide pour débuter

### Installer SIRIUS sur un PC Windows

1. Téléchargez le fichier `SIRIUS-Setup-<version>.exe`.
2. Ouvrez le fichier téléchargé. Si Windows affiche un avertissement, vérifiez
  que le fichier provient bien de votre source SIRIUS, puis autorisez son
  exécution.
3. Acceptez le contrat de licence.
4. Choisissez le dossier d'installation ou conservez le dossier proposé.
5. Cliquez sur **Installer** et attendez la fin de l'installation.
6. Laissez l'option de démarrage activée : SIRIUS ouvrira automatiquement son
  interface et son backend local.
7. Au premier démarrage, autorisez l'accès au microphone si Windows le demande.
8. Créez votre profil dans SIRIUS, puis ajoutez les clés des services que vous
  souhaitez utiliser. La clé Groq est nécessaire pour le cerveau distant ; les
  autres intégrations sont facultatives.

Pour les démarrages suivants, utilisez le raccourci **SIRIUS** du Bureau ou du
menu Démarrer. Vous n'avez besoin d'installer ni Python, ni Node.js, ni
MongoDB. Le fichier `SIRIUS-portable-<version>.exe` permet aussi d'utiliser
SIRIUS sans installation classique.

### Utiliser SIRIUS sur Android ou une tablette Android

1. Installez Android Studio sur l'ordinateur de développement.
2. Ouvrez le dossier `frontend/android` dans Android Studio.
3. Configurez un appareil Android ou un émulateur.
4. Définissez `REACT_APP_BACKEND_URL` avec l'adresse HTTPS du backend SIRIUS.
5. Depuis le dossier `frontend`, exécutez `npm run mobile:sync`.
6. Lancez l'application depuis Android Studio sur le téléphone ou la tablette.
7. Autorisez le microphone et les notifications lorsque Android les demande.

Pour créer directement un APK de test sous Windows, ouvrez un terminal dans
`frontend` et lancez `npm run mobile:apk`. Le fichier sera créé dans
`frontend/android/app/build/outputs/apk/debug/app-debug.apk`. Pour un APK de
publication signé, configurez d'abord la signature Android puis lancez
`npm run mobile:apk:release` ; sans signature configurée, l'APK release ne
sera pas installable tel quel sur un téléphone.

### Utiliser SIRIUS sur iPhone ou iPad

1. Sur un Mac, installez Xcode et les outils nécessaires.
2. Ouvrez le dossier `frontend/ios` dans Xcode.
3. Sélectionnez un iPhone ou un iPad connecté, ou un simulateur.
4. Définissez `REACT_APP_BACKEND_URL` avec l'adresse HTTPS du backend SIRIUS.
5. Depuis le dossier `frontend`, exécutez `npm run mobile:sync`.
6. Dans Xcode, choisissez l'équipe de signature Apple, puis lancez l'application.
7. Autorisez le microphone et les notifications lorsque iOS les demande.

Sur Android comme sur iPhone/iPad, `127.0.0.1` désigne l'appareil mobile et
non le PC. Le backend doit donc être publié sur une adresse HTTPS accessible
par le téléphone ou la tablette. La publication dans Google Play ou l'App
Store nécessite en plus les comptes développeur correspondants.

---

## A. Vous êtes l'utilisateur final : installer SIRIUS

Rien à installer au préalable : **ni Python, ni Node.js, ni MongoDB**.

1. Récupérez le fichier `SIRIUS-Setup-<version>.exe`.
2. Double-cliquez dessus, acceptez le contrat de licence, choisissez le dossier.
3. SIRIUS démarre seul : il lance son propre backend sur `127.0.0.1:8001`.

L'installation ne demande pas de droits administrateur (installation par
utilisateur). Les données, journaux et secrets restent dans votre dossier
utilisateur Windows. Les mises à jour sont proposées automatiquement.

Une version `SIRIUS-portable-<version>.exe` existe aussi : aucun installateur,
elle s'exécute directement.

La base mobile Capacitor est préparée dans `frontend/capacitor.config.js` pour
Android, iPhone, iPad et tablettes. Les projets `frontend/android` et
`frontend/ios` sont initialisés. Utilisez
`npm run mobile:sync` après chaque modification du frontend, puis
`npm run mobile:android` ou `npm run mobile:ios` pour ouvrir l'environnement
natif correspondant. Android se compile avec Android Studio ; iPhone et iPad
se compilent sur un Mac avec Xcode.

Pour un téléphone, `REACT_APP_BACKEND_URL` doit pointer vers une URL HTTPS
accessible depuis Internet ou le réseau local. Ne laissez pas la valeur
`http://127.0.0.1:8001`, car sur mobile elle désigne le téléphone lui-même et
non le PC qui héberge SIRIUS. Les autorisations microphone, notifications et
stockage devront être validées dans chaque projet natif avant publication.

THÉMIS fournit la gestion des devis et factures, le suivi des paiements et
pièces fournisseurs, un journal comptable, une synthèse TVA, un rapprochement
bancaire et un bilan prévisionnel. Ces fonctions servent au suivi de
l'entreprise et à la préparation des données ; elles ne remplacent pas une
comptabilité légale certifiée, une déclaration fiscale officielle ni la
validation d'un expert-comptable.

Pour relancer l'application sans ouvrir Python ou Node.js, double-cliquez sur
`DEMARRER-SIRIUS.bat` depuis le dossier du projet ou utilisez le raccourci
SIRIUS créé sur le bureau.

---

## B. Vous êtes le distributeur : créer l'installateur

À la racine du projet, double-cliquez sur **`CREER-INSTALLATEUR-SIRIUS.bat`**.

Le script fait tout automatiquement :
- détecte Node.js 18+ et Python 3.10–3.12, et **les installe via winget s'ils
  manquent** (c'est ce qui bloquait l'installation sur un PC sans Python) ;
- crée un environnement Python isolé (`backend\.venv-build`) pour ne pas polluer
  le Python du système ;
- installe les dépendances, compile le HUD React, transforme le backend Python
  en exécutable autonome (PyInstaller), puis génère l'installateur NSIS ;
- ouvre `frontend\dist` avec l'installeur et la version portable.

Options en ligne de commande :

```
CREER-INSTALLATEUR-SIRIUS.bat                     # génération locale
CREER-INSTALLATEUR-SIRIUS.bat -Publish            # publie sur GitHub Releases (GH_TOKEN requis)
CREER-INSTALLATEUR-SIRIUS.bat -SkipPrerequisites  # n'installe rien automatiquement
```

> Si winget est absent de la machine de build, installez manuellement
> [Node.js LTS](https://nodejs.org) et [Python 3.12](https://www.python.org/downloads/),
> puis relancez le script.

`frontend\BUILD.bat` reste disponible pour un build manuel lorsque Node.js et
Python sont déjà présents.

---

## C. Développement (lancer les sources)

### 1. Prérequis
- Node.js 18+ et Yarn  (`npm install -g yarn`)
- Python 3.10+
- MongoDB local **optionnel** : s'il est absent, SIRIUS utilise automatiquement
  une base SQLite locale (`sirius_docstore.db`). Variable `SIRIUS_DB=local` ou
  `SIRIUS_DB=mongo` pour forcer un mode.

### 2. Backend (FastAPI)
```
cd backend
pip install -r requirements-local.txt
```
> IMPORTANT : utilise `requirements-local.txt` (liste propre).
> Ne lance PAS `pip install -r requirements.txt` (liste complète du serveur, contient des paquets internes introuvables).
Crée un fichier `backend/.env` (copie `backend/.env.example`) et remplis tes clés :
```
MONGO_URL="mongodb://localhost:27017"
DB_NAME="sirius"
CORS_ORIGINS="*"
GROQ_API_KEY=...            # cerveau (seule clé obligatoire)
SERP_API_KEY=...            # optionnel · recherche web
GROQ_MODEL=llama-3.3-70b-versatile
SPOTIFY_CLIENT_ID=...       # « qu'est-ce qui joue »
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://localhost:8001/api/spotify/callback
MEDIA_EMBED_PARENT=localhost # optionnel · domaine autorise pour les lecteurs Twitch
```
Lancer le backend :
```
uvicorn server:app --host 127.0.0.1 --port 8001 --no-proxy-headers
```

Le backend doit rester lié à l'interface loopback : le bootstrap automatique et
les contrôles Omega sont réservés aux connexions locales directes.

### 3. Frontend (React)
```
cd frontend
yarn install
```
Par défaut, le frontend utilise le backend local `http://127.0.0.1:8001`. Crée `frontend/.env` seulement pour le remplacer :
```
REACT_APP_BACKEND_URL=http://localhost:8001
```
Lancer en dev :
```
yarn start
```

### 4. Publier une mise à jour automatique
Pour publier via GitHub Releases :
1. Ouvre un terminal à la racine du projet.
2. Configure le jeton de publication : `set GH_TOKEN=ton_token_github`.
3. Lance `CREER-INSTALLATEUR-SIRIUS.bat -Publish` (ou `RELEASE-SIRIUS-AUTO.bat`).

Le script augmente automatiquement le numéro de version, compile le HUD et le
backend, publie la release GitHub, puis les applications installées proposent le
redémarrage lorsque la mise à jour est téléchargée.

## 5. Sauvegarder la mémoire locale
Depuis `backend/`, **Sirius Doctor** crée une copie SQLite cohérente de
`sirius_local.db`, contrôle la base avant et après la copie, puis écrit un
manifeste SHA-256 à côté de la sauvegarde :

```
python sirius_doctor.py backup
```

Les instantanés sont placés dans `backend/backups/sirius_doctor/` et ne sont
pas ajoutés à Git. Pour un contrôle sans sauvegarde :

```
python sirius_doctor.py check
```

Pour revérifier plus tard un instantané et son manifeste :

```
python sirius_doctor.py verify backups\sirius_doctor\sirius_local-<horodatage>.db
```

Ajoute `--json` à chaque commande pour une sortie exploitable par un script.
Cet outil couvre la mémoire SQLite locale ; les données MongoDB et le stockage
objet doivent être sauvegardés avec les outils natifs du service concerné.

## 6. Module multimedia
- Ouvre **MEDIA PROXY** depuis le menu `MEDIAS`, ou dis par exemple :
  `Sirius, lance une musique lofi sur Spotify`.
- Le HUD synchronise son etat entre ses fenetres avec `ws://localhost:8001/api/media/ws`.
- YouTube, Spotify, Twitch, TikTok et Deezer utilisent uniquement leurs lecteurs ou liens
  officiels. SIRIUS ne telecharge ni ne relaie leurs flux.
- Netflix ne propose pas de lecteur iframe public : SIRIUS ouvre donc sa page officielle
  dans le navigateur.
- En deploiement hors de `localhost`, configure `MEDIA_EMBED_PARENT` avec le nom de
  domaine du frontend afin que le lecteur Twitch puisse s'integrer correctement.

## 7. Productivite & Travail
- Ouvre **PRODUCTIVITE & TRAVAIL** depuis le menu `OUTILS`, ou utilise des commandes
  comme `Sirius, ouvre mes notes`, `analyse ce document` ou `montre mes taches`.
- Le module inclut DocAnalyzer, CodeAssist, SmartNotes, TaskMaster et ReportBuilder.
- Les analyses de documents et de code sont locales : le code n'est jamais execute et
  aucune cle API supplementaire n'est necessaire.
- Les notes, taches et rapports sont enregistres dans la base SQLite locale de Sirius
  et sont effaces lors de la suppression du compte correspondant.

## Notes
- La voix et le micro utilisent le navigateur (gratuit, instantané) : utilise **Chrome ou Edge** pour la reconnaissance vocale.
- Sirius mémorise automatiquement ce que tu lui dis d'important (pop-up « Mémoire enregistrée »). Tout reste sur ton PC.
- Spotify « qu'est-ce qui joue » : pense à enregistrer ta Redirect URI locale dans le Dashboard Spotify et à ajouter ton compte (User Management, mode Development).

## Son de démarrage personnalisé (ex : thème Terminator)
Sirius joue un son au lancement. Pour mettre TON propre son :
1. Récupère un fichier audio **MP3** dont tu as les droits.
2. Renomme-le exactement **`boot-sound.mp3`**.
3. Place-le dans le dossier **`frontend/public/`** (à côté de `manifest.json`).
4. Relance Sirius : il jouera ton fichier au démarrage.
- Si aucun fichier `boot-sound.mp3` n'est présent, Sirius joue une percussion synthétisée (sans copyright).
- Tu peux activer/couper le son dans **Configuration → « Son de démarrage »**.
- ⚠️ Le thème original de Terminator est protégé par des droits d'auteur : utilise un fichier libre de droits ou que tu possèdes.
