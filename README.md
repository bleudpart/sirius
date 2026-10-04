
# SIRIUS Assistant

Assistant vocal personnel avec HUD futuriste style « Iron Man ».
Frontend **React** + Backend **FastAPI** (Python), packagé en application Windows autonome via **Electron**.

© 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Voir [LICENSE](./LICENSE) et [CONTRAT_LICENCE.txt](./CONTRAT_LICENCE.txt).

![Logo SIRIUS](./frontend/public/icon-source.png)

---

## Boutique publique

La page `/acheter` est rendue par `frontend/src/PublicStore.jsx`.
Elle présente une capture statique du HUD et les prérequis des fonctions,
sans lecteur vidéo vide, compteur d'utilisation ni témoignages non vérifiés.
L'animation du noyau n'est pas une démonstration fonctionnelle.
La galerie « ΣIRIUS en situation » utilise `frontend/public/demo/sirius-dossiers.png`
et `sirius-planning.png` : captures locales avec données fictives et session API
simulée, identifiées comme données de démonstration. Elles ne prouvent pas
une connexion IA ou un service externe. Les liens ouvrent les images originales.
Dans la boutique, les titres et noms des formules utilisent Cinzel doré ;
les descriptions, prix, boutons et champs de saisie gardent leurs styles de lecture.
Ne présenter un paiement comme fictif que lorsque le mode test du prestataire
est effectivement vérifié ; la page ne le déduit pas de sa configuration frontend.

Validation ciblée depuis `frontend` :
`npm test -- --watchAll=false --runInBand src/PublicStore.test.jsx`.

Sur Windows, **Capture de l'interface** et **Capture d'une zone (souris)**
utilisent la capture native Electron et enregistrent les PNG dans le dossier
Images / SIRIUS Captures. La sélection d'une zone peut être annulée avec Échap.
Les raccourcis de capture Windows restent indépendants de ces commandes.
Le panneau **SIRIUS ANTICIPE** se déplace en glissant son en-tête ; sa position
est mémorisée sur cet appareil, sans modifier les actions des suggestions.

## Cache mail facultatif

Pendant une connexion Google ou Microsoft, **Vérifier l'état** actualise le statut
et **Arrêter l'attente** interrompt la demande locale et son suivi. Cette action
ne révoque pas une autorisation déjà accordée chez le fournisseur ; l'onglet
externe peut être fermé manuellement. Les requêtes ont un délai de 20 secondes,
et les erreurs sont affichées avant le bloc du cache mail.

Dans **Centre des connexions**, chaque compte SIRIUS peut activer séparément
le cache Gmail ou Outlook de cet appareil. Il contient uniquement les identifiants,
expéditeurs, objets, aperçus (140 caractères), dates et indicateurs de lecture :
25 messages Gmail maximum (limite de l'API actuelle), 50 Outlook maximum.
Aucun corps complet, pièce jointe, jeton OAuth ou envoi différé n'est conservé.
Les snapshots remplacent les précédents ; il ne s'agit pas d'une archive exhaustive.

Le stockage `localStorage` (`sirius_mail_cache_v1:*`) n'est pas chiffré par SIRIUS.
Il reste sur le navigateur ou WebView de l'appareil, sans synchronisation entre PC
et Android. Protégez l'accès à l'appareil. Le cache est séparé par compte SIRIUS
et lié à l'adresse du compte fournisseur ; un changement de fournisseur connecté,
un refus d'autorisation ou sa déconnexion efface et désactive le cache concerné.
Les erreurs de stockage sont affichées, sans effacer silencieusement les données.

Synchronisation explicite à l'activation, puis toutes les cinq minutes lorsque
SIRIUS est ouvert, visible et en ligne. Aucun service d'arrière-plan Android n'est
installé. Recherche et consultation des copies dans le Centre des connexions,
avec horodatage de la dernière synchronisation et effacement/désactivation.
La lecture vocale utilise le moteur déjà configuré, qui peut nécessiter le réseau ;
ce cache ne rend pas la reconnaissance vocale ou l'IA locales. Les commandes mail
existantes restent en ligne et les envois ne sont pas modifiés.

Validation ciblée depuis `frontend` :
`npm test -- --watchAll=false --runInBand src/services/mailCache.test.js src/components/MailCachePanel.test.jsx src/hooks/useMailCache.test.jsx`.

## Guide de premier démarrage

Après la présentation et la configuration du profil, un guide propose trois
entrées : chat écrit, dossiers métier locaux, comptes et connexions facultatifs.
Il explique les noms des six modules locaux et les prérequis réseau et microphone.
Dans le menu Modules, la fonction est affichée avant le nom mythologique ;
les identifiants et commandes existants restent inchangés.
Les noms des modules et leurs titres utilisent Cinzel doré ; les descriptions
gardent leur typographie de lecture, y compris dans le menu, la palette et le guide.
Les dates documentaires affichées (médiathèque, pièces THÉMIS, échéances des
dossiers et du planning) sont au format `JJ/MM/AAAA`. Les API, sauvegardes,
tris et champs natifs de date conservent leurs valeurs ISO.

Le guide se retrouve dans **Modules → Guide de démarrage**. Sa fermeture est
mémorisée localement par compte (`sirius_getting_started_v1:*`) et n'efface
aucune donnée métier. Un problème de stockage affiche une erreur et permet de
continuer sans enregistrer. La configuration du profil n'ouvre plus automatiquement
les connexions : elles sont proposées dans le guide.

Validation ciblée depuis `frontend` :
`npm test -- --watchAll=false --runInBand src/components/GettingStarted.test.jsx src/SiriusSetup.test.jsx src/App.voice.test.jsx`.

## Requêtes de l'assistant

Les appels chat, flux SSE, intention et transcription sont regroupés dans
`frontend/src/services/assistantApi.js`. Les URL viennent de `lib/api.js` ;
`lib/backendRequest.js` conserve le `fetch` courant pour rester compatible avec
les cookies, le bearer et le renouvellement de session appliqués par AuthGate.
Il ne rejoue pas les requêtes lui-même.

Les délais restent de 60 s pour le flux, 30 s pour le chat et la transcription,
12 s pour l'intention. Ils couvrent aussi la lecture du corps de réponse.
L'annulation de la session est propagée et les délais et écouteurs sont nettoyés
dans tous les cas. Les erreurs remontent aux traitements existants de l'interface ;
un JSON d'intention invalide est signalé par ce traitement avant le repli.
La lecture du flux, les actions métier et les règles de repli restent dans App.

Validation ciblée depuis `frontend` :
`npm test -- --watchAll=false --runInBand src/services/assistantApi.test.js src/voiceSession.test.js src/App.voice.test.jsx`.

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

### Sauvegarde des six modules de travail

Les modules ARIANE, PLUTOS, MNÉMOSYNE, NÉMÉSIS, THOT et CHRONOS conservent
leurs données dans le stockage local de l'application, séparément pour chaque
compte et appareil. Ils ne sont pas synchronisés automatiquement avec le serveur.
Ce stockage peut être perdu en effaçant les données de l'application ou du navigateur.

Dans ces modules, **Sauvegarder les six modules** prépare un fichier JSON versionné
contenant les parcours, prix, dossiers, documents, planning et le journal local
(5 Mo maximum pour l'export comme pour l'import ; au-delà, une erreur est affichée
sans modifier les données).
Vérifier le téléchargement effectif et conserver le fichier dans un emplacement privé :
il n'est pas chiffré et peut contenir des informations confidentielles.
Cette sauvegarde ne couvre pas les autres modules ni les dossiers du fil métier serveur.

**Restaurer une sauvegarde** accepte un fichier de 5 Mo maximum, vérifie son format
puis demande confirmation avant de fusionner les données dans le compte actuel.
Les données existantes ne sont pas remplacées ; les doublons identiques sont ignorés
et les entrées de même identifiant mais différentes sont conservées en copie.
Le journal local n'est plus tronqué aux 500 dernières entrées. En cas de stockage
inaccessible ou invalide, les modifications sont bloquées pour éviter de l'écraser.
Toute suppression d'entrée demande confirmation.

### Contrôle de la demande vocale

Sous la barre de commande, un indicateur distingue l'autorisation du microphone,
l'écoute, la transcription serveur (Android), le traitement, la préparation de
la voix et la lecture de la réponse. Les erreurs vocales et le recours à la voix
de secours sont affichés à cet endroit.
Une petite pastille ronde à côté du nom ΣIRIUS, en haut à gauche, indique le microphone réellement ouvert (vert) ou fermé
(rouge), y compris l'écoute des commandes d'interruption pendant une réponse.

**Arrêter** abandonne l'écoute sans envoyer la phrase, interrompt la transcription
et la réponse conversationnelle en cours, et coupe la lecture vocale. Le mode
mains libres est désactivé : le microphone ne redémarre qu'après un geste explicite.
Les réponses conversationnelles arrivant après l'arrêt sont ignorées, même si une
nouvelle demande est lancée. Le texte déjà affiché reste consultable.
L'arrêt n'annule pas une action métier déjà envoyée (email, domotique, etc.) :
vérifier le résultat dans le module concerné.
Ces changements locaux nécessitent une nouvelle compilation Android et ne modifient
pas le bundle déjà publié en test interne.

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
  Sur mobile, **Profil → Mon compte** ouvre la gestion du compte authentifié
  (déconnexion, export des données et demande de suppression), distincte des
  préférences de l'assistant. Après une modification de ce parcours, reconstruire
  l'APK et vérifier la reconnexion sur appareil en portrait et en paysage ;
  un test du site web ne valide pas l'application Android déjà installée.
  La voix Android utilise une capture micro (maximum 15 secondes) envoyée à
  `/api/stt`, plutôt que la reconnaissance Web Speech de la WebView. Maintenir
  **ESPACE**, puis relâcher pour transcrire ; une annulation pendant la demande
  de permission ne doit pas démarrer un enregistrement tardif.
  En mains libres, la capture se termine après environ une seconde de silence
  suivant la parole (la limite de 15 secondes reste active). Vérifier sur appareil
  les pauses, le bruit ambiant et le délai serveur ; ce seuil ne garantit pas
  une transcription immédiate. La présentation se ferme après son chargement
  et la fin de sa voix ; si la voix ne démarre pas, elle ne bloque pas le HUD.
  En mains libres, dire **Sirius** suivi de la commande. Une capture vide ou
  sans commande relance l'écoute ; une erreur de transcription désactive le
  mode et affiche l'erreur plutôt que de laisser le bouton faussement actif.
  La synthèse Android utilise **Gemini Aoede** via `/api/tts/gemini`, pour la
  présentation, les réponses et les personnages, avec un ton français naturel
  et conversationnel. Le serveur appelle l'API REST Gemini avec `httpx` déjà
  présent ; aucun SDK supplémentaire ni secret n'est ajouté à l'APK. Configurer
  `GEMINI_TTS_API_KEY` sur Render, `GEMINI_TTS_MODEL=gemini-3.8-flash-tts`
  et `GEMINI_TTS_VOICE=Aoede`, puis déployer le backend et reconstruire l'APK.
  Le modèle doit être accessible au projet Google ; quotas et facturation sont
  à vérifier. Cette voix n'est pas une copie garantie de Gemini Live.
  Les réglages Cloud TTS `speakingRate`/`pitch` ne sont pas envoyés à Gemini :
  les indications de ton sont distinctes du texte lu. La réponse WAV est validée
  par le serveur et lue comme `audio/wav`, sans modification de hauteur.
  Cette route exige une session authentifiée ; le cache audio en mémoire est
  limité à 64 entrées et 32 Mio de données base64. L'annulation coupe aussi
  la requête en cours et empêche toute lecture tardive. La présentation attend
  au maximum six secondes la génération distante avant le secours local ;
  les réponses disposent de 28 secondes. Le micro reste suspendu pendant
  la génération des réponses, puis reprend à la fin de la lecture.
  Le texte à lire est transmis à Google, sans audio du micro dans cette requête.
  L'indisponibilité de Gemini est signalée ; le secours utilise une voix française
  **locale** du moteur Android via le plugin Capacitor TextToSpeech, en privilégiant
  `fr-FR` et sans grave forcé. Le web et Windows conservent leur sélection vocale.
  Une voix
  française locale doit être installée ; son absence est signalée. Vérifier
  la narration de démarrage, les réponses et leur interruption sur appareil.
  Le backend transmet l'audio au moteur `WHISPER_API_URL` / `STT_BACKEND_URL`
  configuré, sinon à Groq Whisper si une clé Groq est disponible. Vérifier ce
  flux sur appareil et déclarer la collecte audio dans Google Play ; ne pas
  conclure à l'absence de conservation par les prestataires depuis le code seul.
  `npm run mobile:apk:release` produit un APK release signé et `npm run mobile:play`
  un Android App Bundle (AAB) signé. Ces deux commandes exigent
  `SIRIUS_ANDROID_KEYSTORE`, `SIRIUS_ANDROID_STORE_PASSWORD`,
  `SIRIUS_ANDROID_KEY_ALIAS` et `SIRIUS_ANDROID_KEY_PASSWORD` ; les tâches Gradle
  release refusent aussi de démarrer sans cette configuration.
  Ne versionne jamais le keystore ni ses mots de passe. Pour une application
  déjà publiée, utilise sa clé d'upload existante, pas une nouvelle clé.
  La signature ne remplace pas les validations et exigences de la Play Console.
  L'image de présentation de la fiche Play Store est
  `frontend/public/play-feature-1024x500.png` (1 024 × 500, PNG RGB sans transparence).
  Pour la régénérer depuis le logo commun :
  `powershell -ExecutionPolicy Bypass -File frontend\scripts\generate-play-feature.ps1`
  depuis la racine du dépôt.
  La page de confidentialité est préparée pour publication à
  `https://sirius-assistant.fr/confidentialite.html`, sans connexion ni JavaScript.
  Son contenu commun à la page HTML et à la vue React est dans
  `frontend/src/privacyPolicy.json` ; `npm run build` régénère le HTML via
  `frontend/scripts/generate-privacy-page.js`. Avant une soumission Play Store,
  vérifier les prestataires réellement activés, les durées et procédures de
  conservation/suppression et les garanties de transfert du déploiement en ligne :
  le code seul ne prouve pas cette configuration opérationnelle.
  Ce même générateur prépare `https://sirius-assistant.fr/suppression-compte.html`
  depuis `frontend/src/accountDeletionPage.json`. Cette page publique explique
  la demande par e-mail sans connexion et les limites de l'effacement.
  Vérifier sa mise en ligne avant de saisir son URL dans Play Console.
  Les catégories, fondements et durées des exceptions de conservation doivent
  encore être arrêtés par le responsable avant validation finale de la déclaration.
  Le panneau Administration repère les comptes à examiner après 12 mois
  calendaires sans activité authentifiée auprès du serveur. Le suivi commence
  au plus tôt lors de sa première activation pour chaque compte : l'ancienne
  date de connexion ne prouve pas l'inactivité. Les comptes administrateurs
  nécessitent un examen distinct. L'usage hors ligne n'est pas mesuré.
  Aucune purge automatique n'est exécutée. Avant de supprimer un compte,
  vérifier l'activité réelle et traiter séparément les dossiers, fichiers,
  copies locales et éléments soumis à une obligation de conservation.
  Les boutons de suppression utilisateur et administrateur enregistrent une
  demande dans `account_deletion_requests`, visible dans Administration. La
  réponse HTTP 202 indique `pending_review` et `account_deleted: false` :
  ni le compte ni ses données ne sont effacés, aucun abonnement n'est résilié.
  Ce parcours remplace la suppression partielle antérieure. Il ne constitue pas
  encore une procédure complète d'effacement : le responsable doit traiter
  chaque demande, définir les exceptions de conservation et vérifier les fichiers,
  documents partagés, stockages distincts et prestataires avant clôture.
  Dans Administration, **EXAMINER** charge le plan d'effacement. Désactiver
  d'abord le compte, attendre la fin de ses opérations et traiter séparément
  tout blocage (entreprise, pièces comptables, paiements/licences, Photo3D,
  fichiers partagés). Ne pas effacer des justificatifs soumis à conservation
  simplement pour lever un blocage : documenter leur fondement et leur échéance
  dans la procédure du responsable, puis les traiter dans un stockage approprié.
  Le bouton final exige l'identifiant exact et deux validations humaines.
  Il efface seulement les collections personnelles explicitement prévues,
  leurs fichiers sous `UPLOADS_DIR`, les jetons de connexion prévus et la mémoire
  SQLite du compte sur ce serveur. Les copies d'appareils, prestataires,
  sauvegardes et stockages non couverts sont à traiter séparément.
  Une erreur laisse le compte désactivé et la demande `failed` pour nouvel examen ;
  `processing` indique une exécution en cours ou interrompue qui exige un contrôle
  avant toute reprise. La réponse `scope: reviewed_server_data` ne certifie pas
  l'effacement des copies externes. Aucun compte réel ne doit servir aux tests.
- **Son de démarrage personnalisé** : place un fichier `boot-sound.mp3` (libre de droits) dans `frontend/public/`. Activable dans **Configuration → « Son de démarrage »**.
- **Sauvegarde de la mémoire locale** (SQLite) avec Sirius Doctor :
  ```
  cd backend
  python sirius_doctor.py backup    # instantané + manifeste SHA-256
  python sirius_doctor.py check     # contrôle sans sauvegarde
  ```
- **Spotify** : enregistre ta Redirect URI locale dans le Dashboard Spotify et ajoute ton compte (User Management, mode Development).
