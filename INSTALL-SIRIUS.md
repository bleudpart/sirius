# SIRIUS — Installation locale (Windows)

Assistant vocal HUD style Iron Man. Frontend React + Backend FastAPI (+ Electron pour le .exe).

## 1. Prérequis
- Node.js 18+ et Yarn  (`npm install -g yarn`)
- Python 3.10+
- MongoDB local (ou une URL MongoDB)

## 2. Backend (FastAPI)
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
uvicorn server:app --host 0.0.0.0 --port 8001
```

## 3. Frontend (React)
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

## 4. Construire l'application Windows (.exe)
Dans `frontend/`, double-clique sur **BUILD.bat** (garde-le en CRLF / ASCII).
L'exécutable est généré dans le dossier de sortie Electron.

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
