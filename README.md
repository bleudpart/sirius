
# SIRIUS Assistant

Assistant vocal personnel avec HUD futuriste style « Iron Man ».
Frontend **React** + Backend **FastAPI** (Python), packagé en application Windows autonome via **Electron**.

© 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Voir [LICENSE](./LICENSE) et [CONTRAT_LICENCE.txt](./CONTRAT_LICENCE.txt).

![Logo SIRIUS](./logo_sirius.png)

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
- **Dossiers intelligents** — dossiers métier et notes par utilisateur, propositions sourcées de stocks bas et factures échues THÉMIS, de DLC proches, non-conformités ouvertes et documents à échéance HACCP (selon les permissions). Le fil de travail associe sources, décisions motivées, engagements, réunions et tâches explicitement saisies, brouillons de relance/réapprovisionnement/contrôle, pistes de prochaine étape et simulations sans écriture. Un point de comparaison révèle les changements depuis la dernière visite ; un transfert entre métiers reste un dossier privé à reprendre manuellement. Les actions sont relues avant enregistrement et une confirmation supplémentaire n'envoie **jamais** de courrier, ne crée pas de commande et ne modifie pas HACCP. Une photo de terrain reste un aperçu local non téléversé ; la dictée n'est offerte que si le navigateur prend en charge la transcription locale. Les messages Outlook entrants ne sont pas analysés.
- **ASCLÉPIOS# · Bien-être & santé (guide pédagogique pour adultes)** — portrait dans la galerie MYTHOS et en colonne dans le module, comme les autres personnages du Panthéon ; séances illustrées de remise en mouvement, renforcement général ou pratique régulière pour la prise de masse, selon le temps et le matériel disponibles. Les variantes douce, courte ou habituelle sont proposées à partir du ressenti et de l'historique **local** puis choisies explicitement, jamais imposées. Progression manuelle, pause, ressenti et journal local par compte (suppression sur confirmation) ; aucune donnée sportive n'est envoyée au serveur ou utilisée pour les propositions proactives. Les schémas ne contrôlent pas la posture et les séances ne remplacent pas un avis médical.

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
     (ou crée la release à la main sur GitHub en y joignant `SIRIUS Setup x.y.z.exe`,
     `SIRIUS Setup x.y.z.exe.blockmap` et `latest.yml` depuis `frontend\dist`)
- **Son de démarrage personnalisé** : place un fichier `boot-sound.mp3` (libre de droits) dans `frontend/public/`. Activable dans **Configuration → « Son de démarrage »**.
- **Sauvegarde de la mémoire locale** (SQLite) avec Sirius Doctor :
  ```
  cd backend
  python sirius_doctor.py backup    # instantané + manifeste SHA-256
  python sirius_doctor.py check     # contrôle sans sauvegarde
  ```
- **Spotify** : enregistre ta Redirect URI locale dans le Dashboard Spotify et ajoute ton compte (User Management, mode Development).
