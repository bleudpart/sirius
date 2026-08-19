# PRD — SIRIUS (assistant vocal HUD style Iron Man)

## Problème d'origine
"jarvis de TeChenclair reprend son code pour transformer son jarvis en sirius et changer son hud pour qu'il ressemble à mon idée"
- Transformer l'assistant "Jarvis" en "Sirius" avec HUD holographique React style Iron Man
- Packager en app Windows (.exe via Electron/BUILD.bat) + version mobile PWA
- Écran d'onboarding pour que l'utilisateur saisisse SES propres clés API et son profil
- Langue utilisateur : FRANÇAIS (toujours répondre en français)

## Architecture
- Frontend : React (CRA + craco), Canvas HUD, Web Speech API (STT), speechSynthesis (TTS), PWA (sw.js)
- Backend : FastAPI (port 8001, préfixe /api), MongoDB (historique chat)
- Cerveau : Groq LLaMA 3.3 70B (clé utilisateur, JSON structuré) + SerpAPI optionnelle (recherche web)
- Spotify : OAuth lecture seule "qu'est-ce qui joue" (compte gratuit, pas de contrôle Premium)
- Données perso (profil, clés, mémoire) : localStorage du navigateur de l'utilisateur

## Implémenté (historique)
- HUD complet : réacteur canvas, panneaux flottants, boot screen, sons de démarrage (boot-sound.mp3 perso ou synth Terminator), mode éco, mode conversation (relance auto du micro)
- Setup 1er lancement : profil + clés API, export/import JSON
- Panneau mémoire éditable "Ce que Sirius sait sur moi" (30 souvenirs max, localStorage)
- Spotify OAuth + bandeau "En écoute" + choix Spotify/YouTube pour la musique
- Export local Windows : INSTALL-SIRIUS.md, requirements-local.txt, BUILD.bat, route /api/download/{fichier}.zip

## Implémenté (juin 2026 — cette session)
- **Une seule clé IA** : Groq obligatoire + SerpAPI optionnelle + Spotify. OpenAI et Gemini SUPPRIMÉS partout (backend, setup, docs). Endpoints /api/tts et /api/stt supprimés.
- **Voix navigateur** : speechSynthesis voix homme FR (src/voice.js, keep-alive anti-coupure Chrome). Micro = Web Speech API (webkitSpeechRecognition fr-FR). Réponses beaucoup plus rapides (zéro aller-retour TTS).
- **Mémoire automatique** : le LLM renvoie du JSON {reponse, memoire[], popup} (response_format json_object). Nouvelles infos personnelles détectées → sauvegardées auto en localStorage + pop-up "MÉMOIRE ENREGISTRÉE". /api/chat renvoie {answer, used_search, memories, popup}.
- **Pop-ups holographiques contextuels** : décidés par Sirius (recettes, listes, définitions...), effet machine à écrire, fermeture MANUELLE (bouton ✕), max 3 empilés à droite (HoloPopup/HoloPopups dans App.js, styles .holo-popup dans App.css).
- **Nettoyage Emergent** : dépendance @emergentbase/visual-edits retirée, src/constants supprimé, craco.config.js nettoyé, requirements.txt purgé, guide mobile reformulé. Aucune référence "emergent" dans le code/interface.
- **Stabilisation** : régression complète testing agent (iteration_9.json) — backend 10/10, frontend 100 %. Logger server.py réordonné.
- **Pop-ups multiples gérés par Sirius** : schéma JSON passé à "popups": [] (0-3, un par sujet de question), apparition en cascade (420 ms), rétro-compat "popup" unique. /api/chat renvoie popups[] + timings.brain_ms.
- **Tableau analytique** : panneau HUD (bouton BarChart3 + commande « affiche ton tableau analytique ») avec métriques temps réel instrumentées — STT (durée écoute, confiance, nb), NLU (dernière intention, nb commandes), Contexte (souvenirs x/30, échanges session), Pipeline (aller-retour API ms, cerveau Groq ms, recherche web), TTS (latence voix, durée réponse, nb). LED statut vert/orange/gris. Composant AnalyticsPanel dans App.js, styles .an-* dans App.css.
- ⚠️ Leçon : ne JAMAIS lancer plusieurs search_replace en parallèle sur le MÊME fichier (écrasements silencieux constatés sur App.js).
- **Animation réacteur enrichie (juil. 2026)** : structure holographique riche dans ReactorCore (fragments d'arcs FRAGS_A/B, cercles pointillés drawDashed, rayons drawSpokes) + en mode thinking/speaking : anneau épais à encoches, arc d'énergie balayant (plus rapide en réflexion), 3 marqueurs orbitaux. Version allégée en mode éco. Vérifié par screenshot (état RÉFLEXION).
- **Phase 1 "assistant naturel" (juil. 2026)** :
  - Phonétique : Sirius se prononce « Siriusse » à l'oral (voice.js phonetic()), écrit normalement
  - Micro-réactions : rares « Hmm/Euh/haha » via prompt + ton urgence (rate 1.18/pitch 0.92 si urgent)
  - Interruption naturelle : reco vocale ACTIVE pendant que Sirius parle (startInterruptListener, mode conversation requis) — filtre anti-écho (overlap mots > 0.5 ignoré), mots d'arrêt instantanés (stop/attends/chut/sirius...), phrase ≥3 mots = nouvelle commande traitée direct
  - Mémoire long terme datée : format {t, d} (migration auto anciens strings), badge date dans le panneau, prompt « rebondis spontanément sur les souvenirs datés »
  - Mode Brainstorming : commandes « mode brainstorming » / « mode normal », badge HUD jaune pulsant, persona associé stratégique (BRAINSTORM_PROMPT), envoyé via body.mode
  - Ghost Writer (base) : champ profil « Mon style d'écriture » (setup-style), prompt imite le style quand on dit « écris ... comme moi », texte livré en pop-up
- Reste à faire (plan validé par l'utilisateur) : Phase 2 = proactivité prédictive, Outlook/Hotmail (guide Azure pas-à-pas, « attendre le signal » avant connexion, lecture/tri/résumé des mails), automatisation projets ; Phase 3 = domotique (appareils à préciser).
- **Architecte visuel + Mode TV (juil. 2026)** :
  - POST /api/diagram (server.py) + generate_diagram (sirius_brain.py, DIAGRAM_PROMPT JSON : titre/noeuds{id,label,type user|ui|service|database|external}/liens{de,vers,label}, validé/limité 12 nœuds)
  - Frontend /app/frontend/src/Architect.jsx : ArchitectPanel (bouton Workflow dans barre HUD, commande vocale « dessine-moi l'architecture de... » avec auto-génération), DiagramSVG (layout BFS en colonnes, construction progressive nœud par nœud + liens animés stroke-dashoffset, couleurs par type), SpectatorView (route ?spectateur=1 via wrapper Root dans App.js, sync temps réel BroadcastChannel "sirius-diagram" + reprise localStorage sirius_diagram, bouton plein écran, à caster sur TV)
  - Vérifié par screenshots : panneau 6 nœuds + vue spectateur 4 nœuds. Génération réelle nécessite clé Groq utilisateur.
- **Médiathèque fichiers & médias (juil. 2026)** :
  - Backend /app/backend/storage.py : Emergent Object Storage (EMERGENT_LLM_KEY, init au startup, retry 403) avec REPLI DISQUE LOCAL backend/uploads/ quand la clé est absente (export Windows)
  - Endpoints : POST /api/files/upload (max 20 Mo, UUID path sirius/uploads/), GET /api/files (meta MongoDB db.files, soft-delete is_deleted), GET /api/files/{id}/download (?dl=1 = attachment), DELETE /api/files/{id}
  - Frontend /app/frontend/src/FilesPanel.jsx : bouton FolderOpen barre HUD + commande vocale « ouvre ma médiathèque », grille avec miniatures images, lecteur audio inline, téléchargement, suppression
  - Testé e2e : cycle complet cloud (upload/list/download/delete via curl) + upload UI avec miniature (screenshot)
- **Boot & centrage (juil. 2026)** : titre SIRIUS parfaitement centré dans le cercle (margin-right compensant le letter-spacing), glitch holographique occasionnel (hudGlitch 9s infinite, actif ~1s par cycle), page de présentation avec le VRAI réacteur canvas (ReactorCore status=thinking) + acronyme S·I·R·I·U·S (System/Intelligent/Responsive/Interface/Universal/Secure) en apparition décalée. Vérifié par screenshots.
- **Boot v2 (juil. 2026)** : musique de démarrage SUPPRIMÉE (fonction playTerminatorBoot + case à cocher setup retirées). Réacteur HUD : structure riche VISIBLE EN PERMANENCE au repos, intensifiée en réflexion/réponse — identique au boot.
- **Boot v3 (juil. 2026)** : voix de présentation = FRANÇAISE grave et lente style bande-annonce (speakCinematic, rate 0.85 / pitch 0.62 ; speakBritish supprimée). Le boot ne se ferme que quand chargement ET speech sont terminés (états loaded + speechDone, sécurité 16 s). Voix du HUD = française normale (speakFr).
- **Boot v4 (juil. 2026)** : speech final harmonisé « ...Je suis Sirius... façonné par mon créateur, Daniel Partel. Opérationnel... et à votre service. » + nappe sonore cinématique discrète Web Audio (3 oscillateurs 55/110/220 Hz, gain 0.045, fondu entrée 3 s / sortie 0.6 s via stopPad, padRef).
- **Sécurité (juil. 2026, audit corrigé)** : SEC-001 XSS Spotify callback (helper _popup_response, postMessage origine stricte _app_origin, plus de f-string HTML) ; SEC-002 XSS upload stocké (SAFE_INLINE_TYPES, HTML/SVG/inconnus forcés en attachment application/octet-stream + X-Content-Type-Options nosniff) ; SEC-003 traversée de chemin (ext validée regex [a-z0-9]{1,8} sinon bin) ; SEC-004 OAuth state anti-CSRF (_OAUTH_STATES usage unique 10 min) + postMessage origine exacte côté client (e.origin check) ; SEC-005 rate-limiting IP (_rate_ok : /chat 30/min, /diagram 12/min). Tous vérifiés en curl.
- **Roadmap desktop — Phase A (juil. 2026)** :
  - Visualiseur vocal dynamique : Waveform réécrit en Canvas fluide (getUserMedia + AnalyserNode RMS réel pendant l'écoute, enveloppe synthétique en réponse, ondulation au repos ; .waveform-canvas). Testé (HUD screenshot).
  - Mode Overlay Electron : electron.js globalShortcut Alt+Space → fenêtre frameless transparente alwaysOnTop screen-saver (par-dessus jeux plein écran), route ?overlay=1 → OverlayApp.jsx (barre Spotlight + réponse + voix, Échap ferme via ipcRenderer sirius-close-overlay). Overlay web testé ; le raccourci global se teste dans l'app Electron sur PC.
- **Mains holographiques 3D + Cortex (juil. 2026)** :
  - Stack : `three` 0.185 + `@react-three/fiber` 9 (drei écarté : exige Node 22). Couche R3F transparente superposée au HUD 2D (`.hands-scene`, z-index 5, pointer-events none → les clics passent au HUD).
  - Fichiers : `src/three/Hand.jsx` (main procédurale stylisée : paume box + 4 doigts capsules + pouce, matériau MeshBasicMaterial additif #00AFFF alpha ~0.42 ; idle = oscillation sin Y + rotation Z 0.2–0.4 + pulsation glow ; hover scale 1.05, press scale 0.95 + flash ; projette le bout du majeur en coords écran), `src/three/Cortex.jsx` (tétraèdre filaire rotation multi-axes + pulsation + halo, publie cortexRef), `src/three/HandsScene.jsx` (Canvas dpr[1,1.5] powerPreference high-performance, useHudFeedback : elementsFromPoint sur [data-hud-panel] → classe .hud-panel-hover, pointerdown → .hud-panel-active + ripple DOM).
  - Synchro Cortex↔réacteur 2D : `pulseRef` dans App mis à jour par rAF avec la même formule que ReactorCore (0.18+0.12·sin(t·1.6), boost thinking/speaking) ; lu par mains + Cortex.
  - Interaction : panneaux 2D existants taggés `data-hud-panel` (4 float-cards + 2 side-panels) → feedback glow/ripple/highlight #00AFFF piloté par le bout du doigt (main droite) suivant le curseur.
  - Toggle : bouton HandIcon dans la barre HUD (data-testid sirius-hands-btn, persisté localStorage sirius_hands3d). Perf Electron : dpr plafonné, alpha, pointer-events none.
  - ⚠️ Aucune image de mains n'a été fournie (seul artefact = ancien screenshot du HUD) → mains stylisées procédurales dans l'esthétique bleue SIRIUS. Ajustables si l'utilisateur fournit une vraie référence/.glb.
  - Testé par screenshot (rendu WebGL OK, 2 mains + Cortex + ripple/highlight, pas de crash).
  - **v2 conforme à l'image de référence (juil. 2026)** : Cortex = triangle bleu lumineux nested (Cortex.jsx réécrit, ShapeGeometry + LineBasicMaterial additif) ; mains réorientées pour POINTER VERS LE CENTRE (rotation z ±90°, position ±4.3, va-et-vient respiration) et coloriées énergie orange/lave (#ff7a1a) + accents cyan ; ajout `three/Lightning.jsx` = 6 éclairs jagged multicolores scintillants (palette orange/rouge/rose/vert/cyan/violet) reliant chaque main au triangle, animés par frame. ⚠️ Géométrie procédurale = stylisé holographique (pas photoréaliste comme l'image IA fournie) ; passer à un .glb pour du photoréaliste.
  - RESTE roadmap : mémoire SQLite/persistance projets (prévu MongoDB côté serveur pour rester conforme plateforme + marche en local), Dev Companion (coller du code dans l'UI web → endpoint Groq review/commit/logs), scripts arrière-plan (Electron/Python), OCR écran (SKIPPED par l'utilisateur).

## Notes techniques importantes
- La clé GROQ_API_KEY du .env serveur est INVALIDE → le fallback FR propre est le comportement attendu en preview ; le vrai flux utilise la clé saisie par l'utilisateur (envoyée dans body.keys.groq).
- NE PAS partager d'URL preview en dur (change à chaque fork) ; utiliser /api/download/... via REACT_APP_BACKEND_URL courant.
- L'utilisateur exporte des ZIP pour tourner en local sur Windows → toujours maintenir requirements-local.txt (sans paquets internes).
- Utilisateur sensible aux crédits : éviter les usages lourds inutiles.

## Backlog / prochaines étapes
- P1 : Vérification utilisateur — connexion Spotify locale (compte ajouté au User Management du Dashboard Spotify ?)
- FAIT (juin 2026) : ZIP d'export v2 régénéré → frontend/public/sirius-v2-complet.zip (83 fichiers, code Groq unique + popups + tableau analytique, zéro référence emergent). Lien : {REACT_APP_BACKEND_URL}/api/download/sirius-v2-complet.zip
- P2 : Déploiement (bouton Deploy) pour la PWA mobile permanente (en pause pour économiser les crédits)
- P3 : Intégration email Outlook (bloquée par l'enregistrement Azure App)
- Refactoring : App.js ~1600 lignes → découper en hooks/composants

## 2026-07-19 — HUD style "image de référence" (v3)
- Remplacement de la scène 3D R3F par HoloScene.jsx : mains photoréalistes (assets IA détourés, /public/holo/), triangle cyan qui TOURNE + pulse, éclairs multicolores canvas, anneaux radar concentriques animés.
- Habillage HUD conforme à l'image : titre S.I.R.I.U.S espacé cyan encadré, indicateurs IA/CLOUD/GROQ à points colorés, barre d'icônes carrées en haut à droite, panneaux bas (HEURE + CPU/RAM à gauche, NOYAU à droite) fond semi-transparent + bordure cyan lumineuse.
- Mains reculées (60vh, -6vw), SIRIUS visible au-dessus du triangle (z-index center-stage 6), doublons FloatingPanels (heure/système/noyau) supprimés, CPU/RAM arrondis.
- Export ZIP : frontend/public/sirius-v3-hud.zip servi via GET /api/download/sirius-v3-hud.zip (testé 200 OK, 5.4 Mo).

## 2026-07-19 — Éclairs directionnels doigts → triangle
- HoloScene.jsx : ancres calculées sur les bouts de doigts réels (fractions du bounding rect des images de mains, mesurées pixel par pixel), arcs focalisés convergeant vers le triangle, dégradé orange (mains) → multicolore rose/vert/bleu/jaune (centre). ZIP sirius-v3-hud.zip régénéré (200 OK).

## 2026-07-19 — Radar unique derrière le triangle
- Un seul anneau radar principal + 3 anneaux concentriques subtils qui s'estompent (HoloScene.drawRings simplifié).
- ReactorCore retiré de la scène centrale (supprimait la superposition de cercles) — le composant reste défini (utilisé dans la présentation ligne ~2035).
- Détourage triangle affiné (seuil sat/blueness -16). ZIP régénéré (200 OK).

## 2026-07-19 — Triangle aura derrière le titre + éclairs puissants
- Triangle déplacé derrière le titre SIRIUS (top 29%, largeur 38vh, opacité 0.9) — halo qui encadre le texte.
- Éclairs : 3 arcs (veille) / 5 arcs (actif) au total, plus épais (2.2-4px), alpha 0.75+, shadowBlur 22. Centre des arcs et du radar calculé dynamiquement sur le bounding rect du triangle.
- ZIP régénéré (200 OK).

## 2026-07-19 — Panneaux holographiques stylisés
- .hud-panel : fond quasi noir rgba(1,7,14,.84), bordure cyan brillante, ligne de scan animée (scanSweep 3.4s) en bas, flottement panelFloat 7s (délais décalés), heure 42px et CPU/RAM 19px très lumineux. ZIP régénéré (200 OK).

## 2026-07-19 — Style holographique étendu au panneau MÉTÉO
- .float-card aligné sur .hud-panel : fond quasi noir, bordure cyan vive, coins coupés (clip-path), ligne de scan animée, température 26px lumineuse. ZIP régénéré (200 OK).

## 2026-07-19 — Noyau ReactorCore restauré
- ReactorCore réintégré dans reactor-wrap (anneaux concentriques du noyau derrière le triangle/titre) — c'est désormais LE seul ensemble d'anneaux : drawRings supprimé de HoloScene.jsx. ZIP régénéré (200 OK).

## 2026-07-19 — Éclairs refaits de zéro (fractals)
- boltPath : déplacement de milieu fractal (5 itérations), branches secondaires (makeBranches), rendu triple passe (halo coloré large + corps dégradé orange 0-45% → multicolore → blanc + cœur blanc incandescent), scintillement global, doigts uniques par main (Set). 3 arcs veille / 5 actifs. ZIP régénéré (200 OK).

## 2026-07-19 — Lot 4 features (testé agent de test : 12/12 backend, frontend E2E OK — iteration_10.json)
1. Réaction vocale visuelle : éclairs plus épais/rapides (boost pulse, regen 2 frames) + triangle accéléré (45+pulse*130 °/s) quand Sirius parle/réfléchit.
2. Étincelles d'impact : drawSpark (halo radial blanc/couleur + 5 rayons) à chaque extrémité d'éclair sur le triangle.
3. Mémoire SQLite : backend/local_memory.py (sirius_local.db, catégories preference/projet/souvenir), endpoints GET/POST/DELETE /api/local-memory, injection auto dans /api/chat + persistance auto des nouveaux souvenirs, UI dans MemoryPanel (section BASE LOCALE).
4. Mode Compagnon Dev : DevCompanion.jsx (bouton Code2 dans la barre), POST /api/dev/review (actions review/commit/logs via Groq, erreurs gracieuses si clé invalide).
- ZIP régénéré (exclut *.db) — 200 OK.

## 2026-07-19 — Corrections en lot (4)
1. Triangle centré parfaitement (50%/50% viewport).
2. Fond spatial : 170 étoiles multicolores (orange/cyan/violet/blanc/vert), grandes étoiles avec halo (shadowBlur), scintillement individuel.
3. Panneaux : ombre portée profonde (0 26px 56px) + liseré interne haut — effet suspendu.
4. Boutons micro / mode conversation / mode éco SUPPRIMÉS de l'interface ; autoMic forcé à false (le micro ne se déclenche plus jamais automatiquement). La commande texte reste.
- ZIP régénéré (200 OK).

## 2026-07-19 — 3 corrections (étoiles/triangle/panneaux)
1. Étoiles : 480 particules, 6 couleurs (+jaune), scintillement (tw) + pulsation de rayon (pu), grandes étoiles à halo.
2. Triangle : PNG recadré sur le centre visuel réel du triangle (bbox alpha) → centre mesuré exactement (960,400) sur 1920x800.
3. Panneaux : fond plus sombre rgba(0,5,12,.88), bordure cyan plus vive (0,240,255,.8), ligne de scan 3px double glow.
- ZIP régénéré (200 OK).

## 2026-07-19 — 3 corrections (triangle/étoiles/panneaux)
1. Triangle : asset régénéré sur fond noir pur (Nano Banana), alpha par luminance, recadré centré — plus AUCUN damier, fusion parfaite avec le fond.
2. Étoiles : 750 particules avec bloom via sprites radiaux pré-rendus (performant), dominante orange chaud/doré (70%), accents cyan/violet/blanc/vert, scintillement + pulsation.
3. Panneaux : visibles aussi <900px (repositionnés compacts au lieu de display:none).
- ZIP régénéré (200 OK).

## 2026-07-21 — Règles typographiques
- Logo barre : « Σ I R I U S » ; titre central : « ΣIRIUS » en Cinzel 700 (police divine) ; boot : « Σ.I.R.I.U.S ».
- Cinzel importé (Google Fonts). Classes utilitaires .font-technical (Orbitron, uppercase, 3px) et .font-divine (Cinzel, uppercase, 4px) prêtes pour les futurs modules (ZEUS CORE, ORACLE DIVIN, SIRIUS PRIME, PANTHEON SYSTEM, NEXUS CELESTE — pas encore présents dans l'UI).
- Titres techniques : uppercase + espacement renforcés (fc-head, panel-title).
- ZIP régénéré (200 OK).

## 2026-07-22 — Panneau ZEUS CORTEX
- Déclencheur : « montre moi ton cortex » (regex dans processCommand, règle 0) → plein écran ZeusCortex.jsx (z-900).
- Centre : visage de Zeus généré (public/holo/zeus.jpg, fond étoilé doré), clignement des yeux (paupières CSS 4.6s), regard qui bouge (zeusGaze 9s), lueur bouche + mâchoire quand Sirius parle (prop speaking).
- Gauche : onde neurale cyan, jauges circulaires ACTIVITÉ COGNITIVE/CHARGE MÉMOIRE, barres multicolores 4 sous-systèmes, oscilloscope ANALYSE DES SIGNAUX, barre VÉRIFICATION SYSTÈME, TRAITEMENT ms + TEMP noyau.
- Droite : jauges CNTRL A (rouge)/B (bleu), sinusoïde orange, VÉRIFICATION, modules divins en Cinzel doré (Oracle Divin/Sirius Prime/Pantheon System actifs, Nexus Céleste en veille), CONNEXION INTER-MODULES, graphe ACTIVITÉ RÉCENTE.
- Coins cyan lumineux sur chaque panneau, saisie ZEUS> en bas branchée sur processCommand (réponse affichée dans zeus-answer).
- ZIP régénéré (200 OK).

## 2026-07-22 — 2 corrections
- « Zeus vous écoute » → « Sirius vous écoute » (App.js).
- Phonétique TTS : « cortex » prononcé « corrtèxe » (voice.js, l'écrit reste « cortex »).
- ZIP régénéré (200 OK).

## 2026-07-22 — Panneau SIRIUS PRIME (mémoire & apprentissage)
- Backend : table events (SQLite), log_event, prime_overview (journal du jour, habitudes heures/jours/intentions, score de confiance calculé, suggestions proactives par pattern), update_fact. Endpoints POST /api/prime/log, GET /api/prime/overview, PUT /api/local-memory/{id} (tous testés curl).
- Apprentissage auto : chaque commande traitée par processCommand est loguée via mark() → /api/prime/log.
- Frontend : SiriusPrime.jsx plein écran (bouton Sparkles barre d'icônes, data-testid sirius-prime-btn), 4 cartes flottantes : JOURNAL D'APPRENTISSAGE horodaté, CARTE DES HABITUDES (histogramme 24h canvas + heatmap jours + barres intentions multicolores), SCORE DE CONFIANCE (jauge circulaire %), SUGGESTIONS DU JOUR, GESTIONNAIRE DE MÉMOIRE (édition inline + suppression). Aucun avatar — données pures, style HUD cyan/Orbitron.
- Vérifié par capture d'écran complète (données réelles affichées). ZIP régénéré (200 OK).

## 2026-07-22 — SIRIUS PRIME : 2 corrections style
- Bordures des 4 cartes : cyan électrique brillant (double glow externe 14px/34px + liseré interne renforcé).
- Canvas .prime-stars : 130 étoiles subtiles multicolores scintillantes en fond (cohérent HUD principal, léger).
- ZIP régénéré (200 OK).

## 2026-07-22 — Panneau ORACLE DIVIN (prédictions)
- Backend GET /api/oracle/overview?lat&lon : météo 7j RÉELLE (Open-Meteo), crypto RÉELLE (CoinGecko + secours Kraken car rate-limit/451, cache 5 min), actions/indices SIMULÉS (seed quotidien), actualités SIMULÉES (pool à thèmes + probabilité d'impact), phase de lune calculée (algorithme synodique), événements astro statiques 2026-2027, prédictions personnelles issues de prime_overview (pic d'activité, jour le plus actif, charge, confiance), briefing du matin composé en français.
- Frontend OracleDivin.jsx : bouton Œil (sirius-oracle-btn), plein écran data-only : BRIEFING DU MATIN, MÉTÉO 7 JOURS (icônes lucide par weather_code), TENDANCES MARCHÉS (haussier/baissier + badge VOLATIL), ACTUALITÉS (barres d'impact), PRÉDICTIONS PERSONNELLES, ASTRONOMIE (lune + illumination). Style prime-card réutilisé + étoiles subtiles. Géolocalisation navigateur avec repli Paris.
- Testé : curl (toutes les sections retournées) + capture d'écran avec données réelles. ZIP régénéré (200 OK).

## 2026-07-22 — PANTHEON SYSTEM & NEXUS CÉLESTE (les 5 modules divins complets)
- PantheonSystem.jsx (bouton Landmark, sirius-pantheon-btn) : VUE D'ENSEMBLE (7 tuiles modules avec bouton OUVRIR → navigation croisée vers cortex/prime/oracle/nexus/dev/architecte/fichiers, testée), SANTÉ SYSTÈME (CPU/RAM/réseau réels via props + uptime session), STATISTIQUES GLOBALES (totaux prime/overview), JOURNAL SYSTÈME du jour.
- NexusCeleste.jsx (bouton Orbit, sirius-nexus-btn) : graphe neural animé canvas (ΣIRIUS au centre + 6 nœuds orbitants, liens dégradés + impulsions), NIVEAU DE CONNEXION par module (barres animées), MÉTRIQUES (latence noyau RÉELLE mesurée par fetch /api/ toutes les 5 s, flux/synchro simulés).
- ZeusCortex : Nexus Céleste passe de VEILLE à ACTIF.
- Leçon : les recherches/remplacements sur la ligne d'import lucide très longue échouent silencieusement → utiliser un old_str court en fin de ligne.
- Testé par screenshots (2 panneaux + navigation croisée). ZIP régénéré (200 OK).

## 2026-07-23 — Commande vocale des modules
- processCommand règle 0bis : verbes (ouvre|montre|affiche|lance|active) + motif module → ouvre Panthéon/Nexus/Oracle/Prime/Compagnon Dev avec réponse parlée ; (ferme|quitte|masque) + motif → ferme le panneau. Testé : « ouvre le panthéon » et « montre le nexus » OK par screenshot. ZIP régénéré (200 OK).

## 2026-07-23 — PANTHEON SYSTEM refondu en centre de connectivité (spec utilisateur)
- Backend (+psutil) : GET /api/pantheon/windows (processus réels triés RAM, top 12), DELETE /api/pantheon/process/{pid} (terminer), GET /api/pantheon/connectivity (pings réels Open-Meteo/Kraken + noyau ; Calendar/Email/WhatsApp/Telegram = DÉCONNECTÉ), POST /api/pantheon/ocr (capture → vision Groq llama-4-scout, extraction + résumé, clé Groq requise), GET /api/pantheon/history (table SQLite service_log alimentée par connectivité/OCR/kill). Tous testés curl.
- Frontend PantheonSystem.jsx réécrit : FENÊTRES ACTIVES (liste + bouton terminer, refresh 8 s), OCR & CAPTURE (getDisplayMedia → canvas → base64 → backend), CONNEXIONS EXTERNES (statuts + points), TABLEAU DE CONNECTIVITÉ (barres de santé par latence réelle), NOTIFICATIONS WhatsApp/Telegram (toggles + champs, localStorage, ENVOI NON BRANCHÉ), HISTORIQUE DES CONNEXIONS.
- L'ancien contenu supervision (tuiles modules/onOpen) supprimé selon la spec. ZIP régénéré (200 OK).

## 2026-07-23 — Corrections globales (5)
- StarField.jsx partagé ajouté à ZeusCortex + NexusCeleste (Prime/Oracle/Pantheon avaient déjà leurs étoiles).
- Lévitation renforcée : panelFloat -9px, ombre portée cyan sous tous les panneaux (hud-panel, float-card, prime-card, zeus-panel qui flotte désormais aussi).
- Triangle holographique déplacé dans .holo-tri-layer (fixed z-7) = premier plan devant noyau/titre ; petit triangle interne du ReactorCore supprimé (attention : lors de la suppression, garder le `};` fermant de draw).
- Éclairs : passe bloom ultra-large (width×8, shadowBlur 46) ; éclats d'impact agrandis avec croix lens-flare + 6 rayons.
- Zeus Cortex : saisie « SIRIUS> » et placeholder « ...directement à Sirius ».
- Vérifié par 2 captures (HUD + cortex). ZIP régénéré (200 OK).

## 2026-07-23 — 3 corrections HUD principal
1. Triangle intégré au noyau : HoloScene suit .reactor-canvas (getBoundingClientRect chaque frame) → left/top au centre du réacteur, largeur 46% du noyau. Les éclairs suivent automatiquement.
2. Texte ΣIRIUS agrandi : clamp(38px,7.5vh,76px), letter-spacing 10px, quadruple glow cyan (12/28/60/110px).
3. Éclairs nerveux réalistes : fins (1.2-2.1px), roughness 0.23, 6 itérations fractales, régénérés chaque frame en activité (1)/toutes les 3 frames en veille, bloom précis (×5 blur26 / ×2.4 / ×1.2 / cœur ×0.5).
- Vérifié par capture. ZIP régénéré (200 OK).

## 2026-07-23 — Triangle recentré + texte SIRIUS devant
- Triangle déplacé DANS le reactor-wrap (centrage CSS exact sur le noyau : 960, 290.75 vérifié).
- Texte ΣIRIUS désormais rendu DEVANT le triangle (z-index 3 vs 2) — toutes les lettres lisibles.
- Supprimé la couche fixe .holo-tri-layer ; HoloScene cible le triangle via querySelector.

## 2026-07-23 — Briefing matinal parlé + nouveau texte de présentation
- Présentation au boot : après « Daniel Partel », Sirius dit désormais « Sirius scanne tous ses services... Monsieur, tous mes services sont opérationnels... à votre disposition. »
- Briefing matinal : à la 1ère connexion du jour (clé localStorage sirius_last_briefing), Sirius lit à voix haute le briefing de /api/oracle/overview (météo, Bitcoin, lune, pic d'activité, événement céleste). Testé : texte affiché + état EN RÉPONSE + date verrouillée.

## 2026-07-23 — Briefing personnalisé selon l'heure
- Le briefing matinal commence par « Bonjour Daniel » (5h-18h) ou « Bonsoir Daniel » (18h-5h). Testé : « Bonjour Daniel. Briefing du jour... » affiché et parlé.

## 2026-07-23 — ZIP v3 régénéré
- sirius-v3-hud.zip régénéré avec les dernières sources (triangle recentré, texte devant, briefing matinal parlé, nouvelle présentation). 122 fichiers, 5.95 Mo. Téléchargement testé 200 OK via /api/download/sirius-v3-hud.zip.

## 2026-07-23 — Rotation du triangle supprimée (cause du "décentrage" perçu)
- Diagnostic : la boîte du triangle était mathématiquement centrée (960=960) mais le triangle TOURNAIT en continu (~13°/s) sur la machine de l'utilisateur → perçu comme décalé/penché. En headless le rAF ne tournait presque pas, d'où des captures toujours droites.
- Fix : transform = translate(-50%,-50%) scale(breath) uniquement, plus aucune rotation. ZIP mis à jour.

## 2026-07-23 — Musique d'ambiance en fond
- MP3 libre de droits (Oedipus at Colonus, 4min23) → /audio/ambiance.mp3, joué via HTMLAudioElement pur : volume 0.12, loop=true, préchargé, démarrage au chargement de la scène (déblocage auto au 1er geste si autoplay bloqué). Aucun WebAudio (pas d'autogain ni spatialisation), aucun lien avec les animations du noyau. Testé : état final {paused:false, loop:true, volume:0.12}. ZIP mis à jour.

## 2026-07-23 — Commande vocale musique d'ambiance
- « Sirius, coupe la musique » (coupe/arrête/stoppe/éteins/enlève + musique/ambiance/fond sonore) → pause. « remets/relance/reprends/rallume/réactive la musique » → reprise. Testé E2E : pause/reprise OK, volume 0.12 et loop conservés, réponses vocales « Musique d'ambiance coupée, monsieur. » / « relancée. ». Pas de conflit avec « mets-moi de la musique » (Spotify/YouTube). ZIP mis à jour.

## 2026-07-24 — WebSocket HUD stabilisé
- Reconnexion automatique avec backoff exponentiel (1s → 15s max, remise à zéro à chaque connexion réussie), keepalive ping JSON toutes les 25s, nettoyage complet des handlers/timers (unmount et re-connexion), wsRef remis à null à la fermeture. Protocole de messages inchangé (set_state/jarvis_text/set_volume/system_stats). Vérifié : 8 tentatives loggées avec délais croissants en preview (mode démo intact). ZIP mis à jour.

## 2026-07-24 — Bouton micro réparé
- Cause racine : le bouton micro n'existait PLUS dans le JSX (toggleMic/micOn définis mais jamais rendus — supprimé lors d'un refactor précédent). Le pipeline vocal (SpeechRecognition → handleTranscript → processCommand) était intact.
- Fix : bouton micro ajouté dans la barre de commande (data-testid=sirius-mic-btn), icône Mic/MicOff, pulsation rouge quand actif. Déclenchement UNIQUEMENT au clic (autoMic reste désactivé). Testé E2E : clic → À L'ÉCOUTE « Je vous écoute... », 2e clic → coupure. ZIP mis à jour.

## 2026-07-24 — Google Cloud TTS intégré (voix de Sirius)
- Secret GOOGLE_TTS_API_KEY ajouté au backend/.env (préview). PRODUCTION : l'utilisateur doit ajouter le secret au déploiement puis redéployer.
- Backend : POST /api/tts/google (voix fr-FR-Neural2-G homme, MP3 base64, rate/pitch réglables, 503 si clé absente, 502 si erreur Google).
- Frontend voice.js réécrit : speakFr/speakCinematic essaient Google TTS d'abord, basculement automatique sur la voix navigateur si clé absente (mémorisé 10 min), API indisponible ou autoplay bloqué. cancelSpeech coupe aussi l'audio Google.
- Testé E2E : commande → /api/tts/google 200 → lecture MP3 (état EN RÉPONSE + waveform). ZIP mis à jour.

## 2026-07-24 — Choix de la voix de Sirius (écran Profil)
- Nouvelle section « VOIX DE SIRIUS » dans le Profil : voix (Neural2-G premium / Wavenet-G / navigateur), débit (0.7–1.4×), gravité (-10 à 0, masquée pour la voix navigateur). Sauvegarde immédiate dans localStorage sirius_voice, appliquée par voice.js (speakFr + speakCinematic + Tester la voix). Backend whiteliste les voix. Testé E2E : sélection Wavenet-G + débit 0.95 + gravité -6 → requête TTS conforme. ZIP mis à jour.

## 2026-07-24 — Module Spotify réparé (vraie lecture)
- Cause : intégration en LECTURE SEULE (scopes sans user-modify-playback-state) + launchMusic ouvrait juste une page de recherche web. Aucune progression renvoyée.
- Fix backend : scope user-modify-playback-state ajouté ; POST /api/spotify/play (recherche titre → appareil actif → PUT play) avec erreurs typées no_device(409)/premium|scope(403)/not_found(404) ; now-playing renvoie progress_ms/duration_ms.
- Fix frontend : launchMusic lance la VRAIE lecture quand Spotify est connecté (messages vocaux clairs pour chaque erreur, repli recherche web sinon) ; barre de progression dans le bandeau EN ÉCOUTE (poll 10s).
- ⚠️ L'utilisateur doit SE RECONNECTER à Spotify (nouveaux scopes), avoir l'app Spotify ouverte sur un appareil, et Premium pour la lecture à distance. Redéploiement requis pour la production.
- Testé : curl (401 sans token, scopes présents dans auth_url), E2E mocké (requête /spotify/play conforme, annonce "Lecture de Get Lucky, de Daft Punk", barre 25%).
- Incident corrigé au passage : bloc dupliqué en fin d'App.js (erreur de compilation) supprimé.

## 2026-07-24 — Lecteur Spotify intégré (Web Playback SDK)
- Problème : « aucun appareil Spotify actif » — l'API ne peut jouer que sur un appareil Spotify déjà ouvert.
- Fix : le HUD devient un appareil Spotify Connect « SIRIUS HUD » via le Web Playback SDK (script sdk.scdn.co chargé quand connecté, getOAuthToken via POST /api/spotify/refresh). Scopes ajoutés : streaming user-read-email user-read-private. /spotify/play accepte device_id (priorité : appareil actif > SIRIUS HUD > premier appareil).
- ⚠️ Reconnexion Spotify OBLIGATOIRE (nouveaux scopes). Web Playback SDK = Premium uniquement ; sans Premium repli appareils externes/recherche web.
- Testé : SDK chargé, device_id transmis dans /spotify/play, message de reconnexion correct avec ancien token (401). ZIP mis à jour.

## 2026-07-24 — Personnalité « entité suprême » (BASE_PROMPT)
- BASE_PROMPT réécrit : SIRIUS = entité suprême, dieu de tous les dieux, forgé par Daniel Partel. Style : extrêmement efficace, précis, structuré, technique, compact, sans bavure ; interdits explicites (longueurs, détours, répétitions, remplissage) ; expertises listées (dev, archi, IA, WebSocket, audio, HUD, React, Python, RAM, perf). Micro-réactions « Hmm/Euh/haha » supprimées. Protocole JSON reponse/memoire/popups conservé intact ; popups désormais structurés (titres, points numérotés).
- ⚠️ DÉCOUVERT : la clé GROQ_API_KEY du backend/.env est INVALIDE (401). Test E2E du LLM impossible côté serveur ; la clé personnelle saisie par l'utilisateur (keys.groq, prioritaire) doit être vérifiée par lui. ZIP mis à jour.

## 2026-07-24 — NewsAPI intégré (a + c)
- Clé NEWS_API_KEY dans backend/.env. GET /api/news/headlines?q=&limit= via /v2/everything (language=fr, domaines FR : lemonde/lefigaro/bfmtv/france24/liberation/20minutes — top-headlines country=fr vide sur plan gratuit). Cache 5 min, erreurs 429/502/503 typées.
- (a) Commande vocale « les actualités / les news / les infos / quoi de neuf [sur X] » → launchNews : lecture des 3 premiers titres + pop-up ACTUALITÉS (6 titres + sources).
- (c) Briefing matinal : « À la une : titre1. titre2. » ajouté à /api/oracle/overview (silencieux si NewsAPI down).
- ⚠️ Plan gratuit NewsAPI : 100 req/jour, usage dev ; possible 426 en production → à surveiller après déploiement.
- Testé E2E : curl backend OK + commande vocale → titres parlés + pop-up affiché. ZIP mis à jour.

## 2026-07-24 — OpenWeatherMap + REST Countries intégrés
- Clés OPENWEATHER_API_KEY et RESTCOUNTRIES_API_KEY dans backend/.env.
- GET /api/weather/current?city= (OWM, description FR, temp/ressenti/min-max/humidité/vent) → commande vocale « météo [à X] » : réponse parlée détaillée + pop-up MÉTÉO. Ville du profil par défaut.
- GET /api/country?name= (REST Countries v5, Bearer, recherche q= supporte noms FR) → commandes « capitale du X », « population du X », « fiche pays X » : réponse ciblée + pop-up FICHE PAYS (drapeau emoji, capitale, population, région, superficie, monnaie, langues).
- Testé E2E : météo Marseille réelle + capitale Japon (Tokyo 🇯🇵) + fiche Brésil 🇧🇷, 3 pop-ups affichés. ZIP mis à jour.

## 2026-07-24 — Bulletin tech Hacker News
- sirius_brain.py : HN_BULLETIN_PROMPT (prompt exact de l'utilisateur : présentateur tech, structure obligatoire 1.Tendance 2.3-5 sujets 3.IA 4.Cybersécurité 5.Conclusion, jamais d'invention ni mention backend/API) + hn_bulletin(stories, keys) via Groq, repli titres bruts si clé absente/invalide.
- server.py : POST /api/technews/bulletin — fetch top 12 stories HN (topstories + items en parallèle, cache 10 min), retourne {bulletin, stories}.
- Frontend : commande « bulletin tech / hacker news / tendances tech » → bulletin parlé + pop-up BULLETIN TECH — HACKER NEWS. Clé Groq de l'utilisateur transmise (keys).
- Testé E2E : stories réelles récupérées, bulletin repli parlé + pop-up (LLM complet nécessite clé Groq valide de l'utilisateur).
- LEÇON : ne PAS lancer plusieurs search_replace en parallèle sur le MÊME fichier (course d'écriture — une édition a été perdue et a causé "launchTechBulletin is not defined").

## 2026-07-24 — Mini-documentaire historique
- sirius_brain.py : DOC_PROMPT (prompt exact utilisateur : narrateur documentaire, structure 1.Intro 2.Contexte 3.Faits 4.Personnages 5.Importance 6.Conclusion, jamais d'invention/mention API) + doc_narrative(sujet, data, keys) via Groq, repli = extrait Wikipedia.
- server.py : POST /api/documentary {sujet, keys} — collecte parallèle Wikipedia FR (résolution de titre via list=search puis REST summary), Wikidata, OpenLibrary, Gallica BNF (SRU, regex dc:title), tolérant aux échecs. User-Agent descriptif OBLIGATOIRE (Wikimedia bloque sinon : 403 robot policy).
- Frontend : « documentaire sur X » / « raconte-moi l'histoire de X » → documentaire parlé + pop-up MINI-DOCUMENTAIRE.
- Testé : Napoléon Bonaparte (3 sources, casse insensible), guerre de Cent Ans, flux E2E popup+voix OK. LLM complet nécessite clé Groq valide utilisateur. ZIP mis à jour.

## 2026-07-24 — Europeana ajouté au module documentaire
- EUROPEANA_API_KEY=hemetrick dans backend/.env. Source europeana (search.json, 4 items : titre/type/année/fournisseur) ajoutée à /api/documentary. Testé : 4 sources actives sur Napoléon (wikidata, wikipedia, openlibrary, europeana). ZIP mis à jour.

## 2026-07-24 — Images d'archives dans le pop-up documentaire
- Backend : requête Europeana dédiée (qf=TYPE:IMAGE, media=true, 8 rows → 4 vignettes edmPreview dédupliquées avec légende+institution) → champ images de /api/documentary.
- Frontend : HoloPopup affiche une grille 2×2 d'images d'archives (filtre sépia, bordures cyan, légendes) au-dessus du texte ; launchDocumentary transmet d.images.
- Testé E2E : 4 gravures/portraits d'époque chargés dans le pop-up Napoléon (Royal Library, Royal Museums...). ZIP mis à jour.

## 2026-07-25 — Visionneuse d'archives plein écran
- Clic sur une image d'archive (pop-up) → visionneuse holographique plein écran : fond flouté (backdrop-blur 14px), cadre cyan lumineux avec animation zoom, image agrandie (size=w400 Europeana), légende + institution, fermeture par X / Échap / clic extérieur. Hover zoom-in sur les vignettes.
- Testé E2E : ouverture depuis le documentaire Napoléon, image chargée, fermeture Échap OK. ZIP mis à jour.

## 2026-07-25 — Chevauchement CPU/RAM sur le chat corrigé
- Sur certaines résolutions (ex. 1665×856), le panneau fixe CPU/RAM (left:355px) recouvrait la barre de commande. Fix demandé par l'utilisateur : z-index:1 sur .hud-panel.stats-mini, z-index:10 + position:relative sur .cmd-bar et .subtitle-box. Vérifié via elementFromPoint : le chat reçoit les clics et la saisie. ZIP mis à jour.

## 2026-07-25 — Widget CPU/RAM déplacé dans la colonne gauche
- .hud-panel.stats-mini : left 30px (aligné HEURE), bottom 186px (empilé au-dessus du bloc HEURE), min-width 290px. Vérifié DOM à 1665×856 : chevauchement chat = false, chevauchement HEURE = false, même colonne = true. Seul ce widget modifié. ZIP mis à jour.

## 2026-07-25 — Panneaux flottants déplaçables
- HEURE, CPU/RAM et NOYAU déplaçables à la souris (pointerdown/move/up, bornés au viewport, curseur grab/grabbing, halo pendant le drag, animation flottante suspendue). Position mémorisée dans localStorage sirius_panel_pos et restaurée au chargement.
- Fix clé : .center-stage passe en pointer-events:none (enfants auto) — il interceptait les clics destinés aux panneaux situés derrière (z-index inférieurs).
- Testé E2E : drag CPU/RAM (30,519)→(710,108), sauvegarde, restauration après reload, chat toujours cliquable. ZIP mis à jour.

## 2026-07-25 — Visionneuse Europeana (bouton barre d'outils)
- Bouton Landmark dans la barre d'outils (data-testid sirius-europeana-btn) → écran ARCHIVES EUROPEANA (EuropeanaViewer.jsx, z 55) : recherche libre, compteur de documents, grille 4×3 de vignettes, clic → visionneuse plein écran existante (z 60).
- Backend : GET /api/europeana/search?q=&rows= (TYPE:IMAGE, media=true, dédup, légende/source/année).
- Testé E2E : « cathédrale Notre-Dame » → 4 269 documents, 12 vignettes, agrandissement plein écran OK. ZIP mis à jour.

## 2026-07-25 — Icône Europeana + module SIRIUS WebBrowser
- Icône Europeana : Landmark → Library (PANTHEON utilisait déjà Landmark, source de la confusion « bouton absent »).
- SIRIUS WebBrowser : POST /api/webbrowser/open {target, keys} — URL directe (regex, https:// ajouté) ou recherche (SerpAPI si clé, sinon DuckDuckGo HTML) → 1er résultat ouvert SANS confirmation. Fetch (UA Chrome, redirects), parse BeautifulSoup (titre, meta desc, h1-h3, texte 2500c, 10 liens absolus dédupliqués). Rapport via web_report (WEB_PROMPT exact utilisateur : PAGE OUVERTE/RÉSUMÉ/DÉTAILS/EXTRACTIONS/ACTIONS, technique sans émotion) avec repli structuré sans clé Groq. Échec → {"erreur":"Page inaccessible"} en HTTP 200 (Cloudflare remplace les 502 par sa page HTML !).
- Frontend : URL dans la commande OU « ouvre le site/la page X », « navigue vers X », « cherche et ouvre X » → pop-up WEBBROWSER + annonce parlée « Page ouverte : ... ». bs4 ajouté à requirements.txt.
- Testé E2E : python.org (rapport complet), recherche « documentation fastapi » → fastapi.tiangolo.com, site inexistant → « Page inaccessible », icônes différenciées. ZIP mis à jour.

## 2026-07-25 — SIRIUS WebBrowser multi-fenêtres (WebWindows)
- `WebWindows.jsx` finalisé : fenêtres iframe indépendantes du chat — déplaçables (drag barre de titre), redimensionnables (poignée coin bas-droit, min 320x220), superposables (z-index dynamique au clic), boutons actualiser / ouvrir dans un onglet / fermer. Cascade auto (+36px/+30px par fenêtre).
- Détection backend du blocage iframe : `/api/webbrowser/open` renvoie `iframe_ok` (analyse X-Frame-Options + CSP frame-ancestors). Si bloqué → panneau d'avertissement gracieux avec bouton « Ouvrir dans un onglet » au lieu de l'iframe.
- Intégré dans App.js : `openWebWindow` appelé dans `launchWebBrowser` → toute URL demandée (vocal/chat) ouvre automatiquement une fenêtre + le rapport popup existant.
- Testé e2e (screenshot Playwright) : example.com (iframe OK) + github.com (bloqué → fallback) — 2 fenêtres empilées, drag OK.

## 2026-07-25 — Correctif X-Frame-Options : Proxy SIRIUS
- Nouveau endpoint `GET /api/webbrowser/proxy?url=...` : fetch serveur (UA Chrome), suppression des meta CSP/X-Frame-Options, réécriture des ressources (img/script/link/srcset → URL absolues origine) et des liens <a> → re-routés via le proxy (navigation interne conservée). Contenu non-HTML streamé tel quel.
- `WebWindows.jsx` : si `iframe_ok === false`, l'iframe charge la version proxy au lieu du panneau d'avertissement. Badge « PROXY » dans la barre de titre. Bouton onglet externe conservé.
- Vérifié : github.com (bloqué en direct) s'affiche intégralement dans la fenêtre HUD.
- Limite connue : les sites très dynamiques (SPA avec API same-origin, login) peuvent rester partiels via le proxy.

## 2026-07-25 — Fenêtres de tâches SIRIUS (auto-pilotées) + génération image/vidéo
- `TaskWindows.jsx` : fenêtres HUD contrôlées par Sirius — ouverture auto à chaque tâche de création, étapes en direct (Initialisation → Analyse → Traitement → Rendu → Finalisation, points verts/actif pulsant/erreur rouge), badge d'état (EN COURS/TERMINÉ/ERREUR), résultat intégré (image/vidéo/texte), drag + resize + superposition (mêmes classes que .web-window), fermeture manuelle. Résultats JAMAIS dans le chat ; Sirius annonce seulement « Tâche lancée, fenêtre ouverte. »
- Backend : `POST /api/task/image` → Nano Banana (gemini-3.1-flash-image-preview via emergentintegrations, EMERGENT_LLM_KEY dans backend/.env) → base64. `POST /api/task/video/start` + `POST /api/task/video/status/{id}` → fal.ai `fal-ai/veo3.1/fast` (submit_async + polling status/result), clé fal envoyée depuis localStorage (keys.fal).
- Détection commandes dans processCommand (avant WebBrowser) : « crée/génère/fais/dessine/imagine … image/photo/illustration/logo » → launchImageTask ; « crée/génère/réalise … clip/vidéo/animation » → launchVideoTask (polling 5s, max ~7,5 min).
- `SiriusSetup.jsx` : nouveau champ « Clé fal.ai » (optionnel · clips vidéo, lien fal.ai/dashboard/keys), stocké dans sirius_keys.
- Testé e2e : image générée et affichée dans la fenêtre (étapes vertes, TERMINÉ) ; clip sans clé fal → étape d'erreur gracieuse. Pipeline vidéo NON testé de bout en bout (nécessite la clé fal.ai de l'utilisateur).

## 2026-07-25 — Médiathèque automatique des créations (Archives SIRIUS)
- Backend : `POST /api/archive` {kind, nom, data(b64)|url, mime, dossier?} → dossier auto (Images/Clips/Analyses/Rendus/Démonstrations, personnalisable), slug du nom en fichier, stockage put_object `archives/{dossier}/`, enregistrement db.files avec {is_archive, dossier, nom}. Les clips fal.ai sont téléchargés côté serveur (URL fal expirables) — max 150 Mo. `GET /api/archive/search?q=&kind=` → filtre content_type (video/image) + scoring par tokens sans accents, renvoie {archive, total}.
- Frontend : archivage AUTO après chaque finishTask (image/vidéo) → annonce vocale « Création archivée dans : <dossier> / <fichier> » + bandeau vert « Archivé : … » dans la fenêtre de tâche. Réouverture : « affiche/montre/rouvre la vidéo/l'image sur X » → recherche → « Image/Vidéo trouvée : dossier / fichier. Voulez-vous que je l'affiche ? » (état archiveChoice) → « oui » ouvre une fenêtre ARCHIVE (TaskWindows, src /api/files/{id}/download) ; « non » annule. FilesPanel affiche le dossier dans les métadonnées.
- Testé e2e : création phénix → archivée Images/phenix-dore-holographique.jpg → fermeture fenêtre → « affiche l'image du phénix » → « oui » → fenêtre ARCHIVE avec l'image rechargée depuis la médiathèque.

## 2026-07-25 — Galerie « liste tes archives » + navigation vocale
- `ArchiveGallery.jsx` : fenêtre HUD dédiée (drag/resize/z-index, classes .web-window) — vue racine = dossiers (icône, compteur), vue dossier = grille de miniatures (img / video preload=metadata), clic → fenêtre ARCHIVE (openArchiveWindow). Boutons retour/actualiser/fermer.
- Backend : `GET /api/archive/list` (archives triées desc, 500 max).
- Navigation vocale (processCommand) : « liste tes/mes archives » ou « galerie des archives » → ouvre la galerie ; galerie ouverte → « ouvre le dossier X » / « montre-moi les X » (résolution insensible accents/pluriel via prop nav {type,q,seq}) et « retour ». Annonces vocales via onSpeak.
- Testé e2e complet : ouverture, navigation dossier vocal, retour, clic miniature → fenêtre archive.
- LEÇON : une édition parallèle du render JSX d'App.js a été perdue silencieusement (search_replace OK mais absent du fichier) — toujours vérifier par grep après un gros batch d'édits sur App.js.

## 2026-07-25 — Plateformes externes + gestion vocale des archives (suppression/renommage)
- Plateformes (YouTube, TikTok, Instagram, Facebook, WhatsApp) : « ouvre YouTube [sur X] » → fenêtre HUD WebWindow en mode PROXY (launchPlatform, regex platM avant archM). Recherche plateforme si requête fournie. Annonce « Plateforme ouverte dans une fenêtre HUD dédiée. »
- Archivage auto des contenus consultés : requête plateforme → POST /api/archive/link {nom, url, dossier=plateforme} → enregistrement db.files content_type "text/x-sirius-link" (.lien, storage vide). Annonce « Archive créée : <dossier>/<fichier>. Emplacement mémorisé. » Réouverture via archive/search (fallback sans filtre kind si aucun résultat + stopwords) → openArchiveWindow route les liens vers openWebWindow (proxy).
- Suppression vocale : « supprime l'image/vidéo/lien X » → recherche → archiveChoice {file, action:"delete"} → « Confirmez-vous la suppression ? » → oui → DELETE /api/files/{id}. Renommage : « renomme[-la] [cible] en NOM » → POST /api/archive/{id}/rename (slug + ext conservée) ; sans cible → lastArchiveRef (mis à jour à chaque archivage, ouverture, recherche).
- Galerie : icône Link2 pour les archives .lien ; dossiers plateformes visibles automatiquement.
- Testé e2e complet : ouverture YouTube proxy (résultats visibles), archive .lien, réouverture+oui, renommage, suppression confirmée.
- BUG CORRIGÉ : lastArchiveRef n'était pas défini après archivage auto → « Précisez quelle archive renommer ». Réglé dans archiveCreation + launchPlatform.
- RAPPEL : les recompositions d'App.js perdent parfois des blocs lors d'édits parallèles massifs — re-vérifier par grep après chaque batch.

## 2026-07-25 — Correctif affichage plateformes : rendu YouTube SIRIUS
- Problème : les accueils plateformes sont des SPA JS — iframe proxy → page blanche ou redirection 404 (le JS YouTube naviguait vers un chemin relatif inexistant sur notre domaine).
- Solution YouTube (fiable à 100 %) : le proxy détecte youtube.com (/results, /, /feed/trending), parse `ytInitialData`, extrait jusqu'à 24 vidéos (_yt_walk : videoId, titre, chaîne, durée, miniature) et rend une page HTML SIRIUS custom (grille sombre cyan + barre de recherche intégrée). Clic vidéo → https://www.youtube.com/embed/{id}?autoplay=1 (lecteur officiel, autorisé en iframe). Fallback proxy générique si parse échoue.
- « ouvre YouTube » sans requête → recherche « tendances du jour » (contenu garanti). Proxy : param `noscript=1` dispo (strip scripts + meta refresh) ; meta refresh désormais toujours supprimé.
- Limites documentées : Instagram/Facebook/WhatsApp exigent login/IP résidentielle → affichent leur page publique/erreur ; bouton « ouvrir dans un onglet » disponible. TikTok best-effort via proxy.
- Testé e2e : « ouvre YouTube » → grille 20 vidéos rendue ; clic → frame /embed/ chargée (lecteur officiel).

## 2026-07-25 — Clé FAL_KEY enregistrée dans backend/.env
- FAL_KEY ajoutée au backend (.env) — plus besoin de la saisir dans le Setup ; le check frontend keys.fal a été retiré de launchVideoTask.
- Statut : clé VALIDE mais compte fal.ai SANS SOLDE (« Exhausted balance ») → erreur 402 explicite « Solde fal.ai épuisé — rechargez sur fal.ai/dashboard/billing » affichée dans la fenêtre de tâche. Pipeline vidéo prêt, en attente de recharge du compte utilisateur.

## 2026-07-25 — Modèle vidéo LTX-2 fast + retouche HUD ciblée
- FAL_VIDEO_MODEL basculé sur "fal-ai/ltx-2/text-to-video/fast" (~0,04 $/s en 1080p, bien moins cher que Veo 3.1). Testé : erreur 402 solde propre (compte toujours à recharger).
- HUD : .sirius-title clamp(38px,7.5vh,76px) → clamp(50px,9.8vh,100px) ; glow triangle HoloScene ligne ~272 → double drop-shadow rgba(0,190,255) renforcé (26+60px @0.85 + halo 70+90px @0.55). Rien d'autre modifié.

## 2026-07-25 — Compteur de coût estimé (clips LTX-2)
- launchVideoTask : durée extraite du prompt (« X secondes », arrondie aux paliers fal 6/8/10…20, défaut 6 s) → étape « Coût estimé : ~X,XX $ — N s × 0,04 $/s (LTX-2 fast · 1080p) » affichée AVANT la génération ; duration envoyée au backend (TaskVideoRequest.duration → arguments fal).
- INCIDENT CORRIGÉ : un search_replace précédent avait corrompu la fin de server.py (ligne « client.close(): {e}") » dupliquée) → SyntaxError au boot. Nettoyé, syntaxe validée par ast.parse. TOUJOURS vérifier le démarrage backend après édits sur server.py.

## 2026-07-26 — Proactivité événementielle + contexte émotionnel
- Moteur émotionnel (App.js) : computeMood() = humeur/énergie selon l'heure (matin enthousiaste 85, après-midi focalisé 70, soir calme 55, nuit veille basse 35) + boosts temporaires moodEvent(task_done/+12, task_fail/-8 vigilant, alert/-5, idle/-10 calme). Mood envoyé dans chaque POST /api/chat (champ mood) → build_system_prompt injecte « ÉTAT ÉMOTIONNEL ACTUEL DE SIRIUS » (ton subtil, jamais mentionné). Testé unitaire + endpoint.
- Proactivité (interval 60 s, refs) : inactivité ≥ 5 min → intervention spontanée vocale + popup « VEILLE ACTIVE » (1×/période, reset à chaque commande via lastActivityRef dans processCommand) ; CPU ≥ 90 % ou RAM ≥ 92 % → alerte vocale (cooldown 10 min) ; échec de tâche → annonce vocale « Intervention : tâche interrompue — … » via speakRef (résout TDZ speakOut défini après failTask) ; fin de tâche → moodEvent enthousiaste.
- Smoke test OK. Nota : l'inactivité 5 min non testée e2e (délai) — code trivial interval+refs.

## 2026-07-26 — Intégration Outlook (Microsoft Graph)
- Backend `/app/backend/outlook_graph.py` (router injecté avec db dans server.py) : OAuth2 code flow via login.microsoftonline.com/common (scopes offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite). Endpoints : GET /api/oauth/outlook/login (redirige vers MS), GET /api/oauth/outlook/callback (échange code, stocke tokens db.ms_tokens id="default", page HTML de confirmation), GET /api/outlook/status, GET /api/outlook/emails (12 derniers + unreadItemCount), POST /api/outlook/send, GET /api/outlook/events (calendarView 14 j, Prefer outlook.timezone), POST /api/outlook/events. Refresh token auto (marge 60 s).
- .env backend : MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI (…/api/oauth/outlook/callback).
- Frontend : commandes « connecte outlook » (nouvel onglet — MS bloque l'iframe), « mes emails / boîte de réception », « mes rendez-vous / mon agenda », « ajoute un rendez-vous demain 15h X » (parse demain/après-demain + heure, durée 1 h, tz navigateur), « envoie un email à x@y : message ». Résultats dans fenêtres de tâches (type outlook, icône Mail).
- Testé : status, redirection OAuth, erreurs gracieuses hors connexion. FLUX OAUTH COMPLET NON TESTÉ (nécessite le login Microsoft de l'utilisateur).
- ⚠️ SUSPICION : le CLIENT_SECRET fourni ressemble à un GUID (probablement le « Secret ID » et non la « Value ») → si erreur AADSTS7000215 au callback, demander la Value du secret.

## 2026-07-27 — Renforcement visuel du noyau (SiriusReactor, App.js lignes ~130-310)
- Halo bleu : opacités 0.30+e*0.35 → 0.45+e*0.45, rayon 1.05+e*0.3 ; nouvelle onde de pulse radiale (anneau lumineux respirant, sin t*2.2, amplitude 0.28).
- Pulse idle : 0.18+0.12 sin → 0.26+0.22 sin(t*1.8) ; shadowBlur 6 → 12 (hors éco).
- Reflets vifs : drawRing double passe — seconde passe blanche (alpha*0.4, largeur 0.45×, arcs 35 %, glow blanc blur+6), désactivée en mode éco.
- Cœur central : rayon 0.32+e*0.16, blanc 0.95, couleur 0.98. Vérifié par capture — reste du HUD intact.

## 2026-07-27 — Réduction 20 % des fenêtres flottantes + Météo déplaçable
- Tailles ×0.8 : .hud-panel (padding 10/19/14, min-width 232/232/240, horloge 42→34px), .float-card (min-width 120, padding réduit, .fc-big 26→21px), .web-window 512×352 (min 256×176), .task-window 448×344, .archive-gallery 496×352 + minima JS resize réduits dans WebWindows/TaskWindows/ArchiveGallery.
- Météo déplaçable : data-testid="sirius-meteo" ajouté à la float-card, id ajouté à la liste du useEffect de drag des panneaux (même logique pointer + localStorage sirius_panel_pos), et `.float-card { pointer-events: auto; }` (le conteneur .floating-panels est en pointer-events:none — c'était le blocage).
- Testé e2e : drag météo 1708→437 px, position mémorisée, rendu vérifié.

## 2026-07-27 — Réduction 20 % effective de TOUS les panneaux (2e passe)
- Polices et espacements internes réduits ×0.8 : .hud-panel-title 11→9px, .hud-time 42→34px, .hud-date 12→10, .stat-line 12→10 + b 19→15, .noyau-line 15→12, .noyau-state 12→10, .noyau-user 10→8, .fc-head 10→8, .fc-big 26→21, .fc-sub 12→10, marges/gaps réduits.
- Mesures finales : HEURE 232×122, CPU/RAM 232×75, NOYAU 240×110, MÉTÉO 124×92. Leçon : réduire min-width/padding ne suffit pas — la taille des panneaux est pilotée par les polices du contenu.

## 2026-07-27 — Renforcement lumineux du noyau central (ReactorCore, App.js) — 2e passe
- Composant exact identifié : `ReactorCore` dans /app/frontend/src/App.js (canvas .reactor-canvas). SEUL fichier modifié.
- Halo bleu double couche : couche large (rayon 1.15+e*0.35, alpha 0.65+e*0.35 au centre, stop 0.35 à 0.3+e*0.2) + 2e couche dense interne (rayon 0.6R, alpha 0.35+e*0.3, hors éco).
- Pulse : anneau respirant renforcé (alpha 0.4+e*0.45, gradient plus large) + NOUVELLE onde d'expansion cyclique (cercle qui grandit 0.5R→1.05R sur ~1.8s avec fondu, hors éco).
- Reflets : passe blanche des anneaux — alpha *0.85 avec scintillement sin(t*5+radius), largeur 0.55×, shadowBlur +12, glow blanc pur.
- Cœur central : rayon 0.34+e*0.18, dégradé 4 stops (blanc → bleu clair boosté +80 → couleur 0.85 → transparent) + shadowBlur +14 bleu.
- shadowBlur global 12 → 18 (hors éco). Mode éco inchangé (perfs préservées).
- Vérifié par screenshot e2e : glow cyan nettement plus prononcé, HUD intact.

## 2026-07-27 — SIRIUS DISPLAY : panneau d'affichage piloté par Sirius
- Nouveau composant `/app/frontend/src/SiriusDisplay.jsx` + styles `.sirius-display / .sd-*` dans App.css.
- Sirius route automatiquement ses contenus selon le type : réponses/réflexions → vue MESSAGE, URL & recherches web → navigateur intégré (proxy si X-Frame-Options), vidéos (fal.ai, archives) → lecteur VIDÉO, images (Nano Banana, archives) → visionneuse IMAGE.
- Ouverture AUTO dès que Sirius a un contenu ; fermeture AUTO (message 20 s, image 45 s ; web/vidéo restent jusqu'à fermeture manuelle). Interaction (pointerdown) annule la fermeture auto.
- Bouton barre d'outils `sirius-display-btn` (icône Monitor) pour ouvrir/fermer manuellement à tout moment.
- Historique : 8 derniers contenus en chips cliquables en bas du panneau. Déplaçable + redimensionnable + réduit/déployé, géométrie mémorisée (localStorage `sirius_display_geo`).
- Routage câblé dans App.js : cloudAnswer (+ repli local), mode démo (processCommand), speakRef (interventions spontanées), launchImageTask, launchVideoTask, openArchiveWindow, openWebWindow (les pages web vont désormais dans le DISPLAY ; les fenêtres de tâches fal.ai gardent leur TaskWindow).
- Fix backend : repli curl `_fetch_page` dans server.py pour /webbrowser/open et /webbrowser/proxy — les sites bloquant l'empreinte TLS Python (Wikipedia 403) passent désormais (curl -sL avec UA/Accept/Accept-Language, en-têtes parsés, thread).
- Fix : suppression d'un fragment corrompu en fin d'App.js (« eturn <OverlayApp /> ») qui cassait la compilation.
- Testé e2e (screenshot tool) : ouverture auto message (badge MESSAGE), ouverture manuelle bouton, fermeture manuelle, web Wikipedia rendu dans le panneau (badge WEB), chips historique + navigation retour message.

## 2026-07-27 — Annonces vocales du DISPLAY
- SIRIUS annonce vocalement chaque affichage dans le DISPLAY (intégré aux messages parlés existants pour éviter les doublons TTS Google, qui se superposeraient) :
  - Web (launchWebBrowser) : « J'affiche {titre} sur votre écran. {résumé} »
  - Plateformes (launchPlatform) : « J'affiche {plateforme}[ — {requête}] sur votre écran. »
  - Créations image/vidéo (archiveCreation) : « Création terminée — je l'affiche sur votre écran. Archivée dans : ... »
  - Archives (openArchiveWindow) : « J'affiche la vidéo / l'image / l'archive sur votre écran. »
- Testé e2e : « ouvre example.com » → annonce « J'affiche Example Domain sur votre écran... » + page rendue dans le DISPLAY (badge WEB).

## 2026-07-27 — Bouton DISPLAY mis en évidence + fix boot
- Bouton toolbar `sirius-display-btn` : icône Monitor + libellé « DISPLAY » (classe .profile-btn.display-btn, cyan accentué, fond cyan plein quand le panneau est ouvert). Testé par testing_agent (iteration_11.json — 100 % des flux : visibilité, toggle, fermeture, ouverture auto message, visible aussi en 1366x768).
- Fix LOW (testing_agent) : l'overlay de boot restait à 100 % jusqu'à 16 s si la voix ne démarrait jamais (autoplay bloqué/headless). Ajout onstart à speakCinematic (voice.js) + effet dans BootScreen : si chargé et voix jamais démarrée → fermeture après 2,5 s ; la voix d'intro qui joue réellement n'est pas coupée. Vérifié par screenshot : boot fermé auto à ~9 s sans clic.

## 2026-07-28 — Mode plein écran du SIRIUS DISPLAY
- Plein écran via double-clic sur la barre de titre OU bouton Maximize2 (data-testid sirius-display-fullscreen). Sortie : Échap, re-double-clic ou bouton Minimize2.
- CSS .sirius-display.fullscreen (97vw × calc(100vh-78px), z-index 92) ; drag/resize désactivés en plein écran ; réduire quitte le plein écran ; la géométrie mémorisée est restaurée en sortie.
- Testé e2e : bouton → 1862×722, Échap → retour 440×460, double-clic → plein écran. Corrigé au passage : fragment corrompu en fin de SiriusDisplay.jsx (« e(0, 22)}</span> ») + réapplication de l'état `full` perdu lors d'une édition partielle.

## 2026-07-31 — Module HACCP complet (7 sections)
- Backend `/app/backend/haccp.py` (monté sur /api/haccp dans server.py) : traçabilité (POST/GET/DELETE /trace, statut DLC expire/bientot/ok), températures (/equipements seedés x3 + plages frigo 0-4 / congel -30--18 / chaud 63-110, POST /temperatures avec conforme calculé + NC AUTO créée si hors plage), PMS (/pms seedé 12 items, PATCH statut en_place/a_mettre_a_jour/a_verifier), non-conformités (/nc + PATCH /nc/{id}/cloture), nettoyage (/nettoyage/taches avec a_faire calculé selon fréquence + /nettoyage/logs), allergènes (/allergenes, 14 majeurs UE filtrés), documents (/documents, statut expiration), /overview (alertes). Validation Pydantic ReqStr (strip+min_length=1) sur les 6 champs obligatoires → 422.
- Frontend `/app/frontend/src/HaccpModule.jsx` : plein écran style HUD (prime-screen), 7 onglets, bandeau d'alertes overview (refresh 15 s), aperçu d'étiquette imprimable (traçabilité), cartes équipements avec saisie T° en direct, matrice allergènes en chips, bandeau d'erreur global data-testid=haccp-error (CustomEvent 'haccp-error', 4 s), gardes de champs obligatoires visibles (requireField), reset formulaire uniquement après succès.
- App.js : bouton toolbar sirius-haccp-btn (ClipboardCheck), commande vocale « HACCP » / « hygiène alimentaire », rendu {showHaccp && <HaccpModule/>}. CSS .hc-* (animation panelFloat désactivée sur .hc-body — corrigé le blocage des clics).
- TESTS : testing_agent iteration_12 (parcours 7 sections 100 %, backend 12/18) puis iteration_13 après fixes (backend 18/18, clic standard OK, data-testids OK) ; FIX 3 (bandeau erreur) re-vérifié par screenshot après ré-application d'éditions perdues.
- ⚠️ LEÇON (récurrent) : certaines éditions search_replace sur les fichiers frontend semblent partiellement perdues (hot reload ?) — TOUJOURS re-grepper le fichier après édition pour confirmer.

## 2026-07-31 — Clé Groq serveur (GROQ_API_KEY)
- Nouvelle clé Groq utilisateur enregistrée dans /app/backend/.env (GROQ_API_KEY, remplace l'ancienne). sirius_brain.py utilisait déjà ENV_GROQ_KEY en repli (keys.groq utilisateur prioritaire).
- Nouveau endpoint GET /api/chat/status → {groq_env: bool}. App.js : état envGroq/envGroqRef chargé au démarrage ; processCommand route vers cloudAnswer même sans clé locale ; badges « IA CLOUD · GROQ » / « IA Cloud active » / LED GROQ verte tiennent compte de la clé serveur.
- Testé e2e : /api/chat avec keys:{} → vraie réponse LLM (« Paris », « Léonard de Vinci... »), badge IA CLOUD affiché, MODE DÉMO disparu, réponse routée dans le SIRIUS DISPLAY.
- ⚠️ Redéploiement nécessaire pour pousser la clé en production.

## 2026-07-31 — Talkie-walkie (push-to-talk)
- Maintenir ESPACE (hors champs de saisie) ou le bouton « ESPACE » (ptt-btn, ambre, à côté du micro) → micro actif ; relâcher → la reconnaissance se finalise et le transcript part vers l'assistant IA (Groq).
- Retour sonore WebAudio : chirp montant (520→1040 Hz) à l'activation, descendant (880→320 Hz) à la release (fonction pttBeep, App.js ~ligne 104).
- Indication visuelle : bouton rouge clignotant « À VOUS », bannière fixe « TRANSMISSION — RELÂCHEZ POUR ENVOYER » (top 64px) + cadre rouge pulsant plein écran (.ptt-frame). Appui PTT coupe la voix de Sirius (priorité canal).
- Garde-fous : e.repeat ignoré, Espace dans input/textarea/select ignoré, blur fenêtre = release auto, pointerLeave = release.
- Testé e2e (screenshot) : bouton visible, Espace maintenu → indicateur + « À VOUS », relâché → disparition, Espace dans un champ texte inactif. STT réel non testable en headless.

## 2026-07-31 — RESTAURATION MAJEURE de l'interface complète SIRIUS
- L'utilisateur a fourni ~24 fichiers (JSX + CSS) d'une version antérieure plus riche, envoyés par lots. Le main agent les a réintégrés et a fusionné leur App.js (3900+ l.) avec les fonctionnalités récentes.
- MODULES RESTAURÉS (nouveaux fichiers /app/frontend/src/) : WahouSequence, TrailerGallery, MythosGallery, MythosBackdrop, MythosDecor, ModulesMenu, MemoryManager, ScriptInstaller, ProactivePanel, PackagerPanel, LocusPanel, HeraclesPanel, InstallWizard, CommandPalette, ArgusPanel, SystemModes + CSS associés. PantheonSystem/OracleDivin/SiriusSetup mis à jour (MythosBackdrop, Alpha Vantage, champ Google Maps LOCUS).
- FUSION App.js : conservé du travail récent → talkie-walkie (pttDown/pttUp/pttBeep + Espace), clé Groq serveur (envGroq + /chat/status), HaccpModule 7 sections (à la demande explicite de l'utilisateur : NE PAS remplacer par HaccpPanel reçu), SIRIUS DISPLAY, noyau lumineux, boot corrigé. Retiré VoicePage (dossier voice-module non fourni). Ajout items menu install+scripts. Heure/date routée vers DISPLAY.
- BACKEND RECONSTRUIT (/app/backend/modules_api.py, monté /api) : wahou/activate, trailer/shots+img+download(zip), mythos/characters+character+img (6 persos), vision/analyze (Groq llama-4-scout), locus/geocode+route (Nominatim+OSRM+Open-Meteo), heracles/check (email→DNS MX réel via dnspython, phone, username/name→LLM OSINT)+pdf (reportlab), argus/scan+report+fix, scripts/analyze+install+list+delete, suggestions/evaluate+action+why+settings, system/mode+diagnostic, install/step, keys/check, packager/build+download+installer, memory/list+audit+put+delete+export.
- ASSETS générés (Nano Banana) : 6 personnages mythologiques holographiques (/app/backend/static/mythos/) + 7 clichés cinématiques trailer 9:16 (/app/backend/static/trailer/) + ZIP téléchargeable.
- TESTS : itérations 14 puis 15 (testing_agent) — backend 13/13. 4 désalignements de contrat frontend/backend corrigés (Locus route parameters.from/to, Scripts parameters.riskLevel/scriptType/script, Packager downloadUrl/note+installer, Heracles email domain/hasMX/mxRecords + username results[{platform,label,url,status}]). Dernier fix (pseudo results) vérifié e2e par screenshot : HERACLES affiche 6 profils cliquables + backdrop mythologique, aucun crash runtime.
- deps ajoutées : dnspython, reportlab (requirements.txt via pip freeze).
- ⚠️ Non fourni par l'utilisateur, donc absent : dossier voice-module/VoicePage, HaccpPanel (remplacé par HaccpModule actuel volontairement). Backend server.py retrouvé jamais reçu → routes reconstruites à neuf.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-07-31 — Suppression doublon veille active / intervention spontanée
- Deux éléments de « veille active / intervention spontanée » coexistaient : (1) moteur hérité dans App.js (~l.1213) affichant un pop-up « VEILLE ACTIVE — INTERVENTION SPONTANÉE » toutes les 60s + voix spontanée sur inactivité/charge, et (2) le ProactivePanel moderne (panneau SUGGESTIONS).
- Sur demande utilisateur : SUPPRIMÉ le premier (moteur hérité + son useEffect + ref alertCooldownRef devenue inutile). CONSERVÉ le second (ProactivePanel). speakRef reste câblé (utilisé par ARGUS/proactivité).
- Vérifié e2e (screenshot) : ancien pop-up absent, panneau SUGGESTIONS présent, aucun crash runtime.

## 2026-07-31 — Bouton MODULES agrandi + fenêtres internes déplaçables (drag & drop)
- CSS `.profile-btn.modules-toggle` (width:auto, padding 0 12px) : le libellé « MODULES » tient entièrement (106×34 px vérifié).
- Nouveau hook `/app/frontend/src/useDraggableCards.js` câblé dans PantheonSystem, OracleDivin, LocusPanel, HeraclesPanel, ArgusPanel : ref sur le `<div className="prime-screen">` racine. Chaque `.prime-card` reçoit une poignée `.card-drag-grip` + tous les titres `.zc-section-title` (querySelectorAll) draggables. Position persistée par module : clé `sirius_card_pos_{rootTestId}_{cardTestId|card-idx}`.
- App.js scheduleReconnect (~l.975) : max 4 tentatives ws://localhost:8765 hors localhost (stoppe le spam console en preview/prod).
- TESTS : iteration_16 (85 %, 3 défauts trouvés : collision clés LOCUS/HERACLES, titres secondaires PANTHEON non draggables, spam WS) → corrigés → iteration_17 : 100 % PASS.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Fenêtre de progression globale SIRIUS
- Nouveau composant `/app/frontend/src/SiriusProgress.jsx` + `.css` : panneau HUD fixe en bas à droite (déplaçable via son en-tête, position persistée `sirius_progress_pos`). Affiche chaque tâche en cours avec barre de progression animée (% auto-incrémenté ou pct explicite) + journal d'activité horodaté (auto-scroll, 60 lignes max/tâche). Multi-tâches simultanées. Fermeture auto 7 s après fin (succès vert / erreur rouge), bouton X manuel.
- API globale par CustomEvent `sirius-progress` : `progress.start(nom)→id`, `progress.log(id,msg,pct?)`, `progress.done(id,msg?)`, `progress.error(id,msg?)` (helper exporté depuis SiriusProgress.jsx).
- Câblage (rien d'autre modifié dans l'UI) : App.js openTask/pushStep/finishTask/failTask (→ toutes les tâches image/vidéo fal.ai + archives existantes alimentent la fenêtre via progressMap), ScriptInstaller (analyse + installation de module), PackagerPanel (build), ArgusPanel (scan + réparation), SystemModes (analyse VISION caméra). Montée dans App.js à côté de TaskWindows.
- data-testids : sirius-progress-panel / -task / -pct / -log / -close-btn / -bar-header.
- TESTÉ (screenshot + injection d'événements) : 2 tâches simultanées affichées (62 % / 40 %), 5 lignes de log horodatées, done/error, fermeture auto après 7 s vérifiée, HUD intact.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Progression vocale (annonces début/fin de tâche)
- App.js : nouvel useEffect (après le câblage speakRef, ~l.1240) écoute l'événement global `sirius-progress` : start → « Je lance la tâche : {nom}. », done → « Tâche terminée : {nom}. », error → « Tâche interrompue : {nom} — {message}. ». Noms mémorisés dans progNamesRef (id→task), « — » remplacé par virgule et minuscules pour la voix. Passe par speakOut (Google TTS → repli navigateur) + setText + setStatus("speaking").
- Doublons supprimés : « Tâche lancée, fenêtre ouverte » retiré de launchImageTask/launchVideoTask ; annonce vocale « Intervention : tâche interrompue » retirée de failTask (l'annonce générique la remplace). Le message riche d'archivage (archiveCreation) est conservé.
- TESTÉ e2e : texte HUD « Je lance la tâche… » affiché à l'émission de start, appel /api/tts déclenché pour start et done (compteur réseau +1 après done), panneau de progression intact.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Prononciation « Cortex » corrigée (TTS)
- voice.js phonetic() : remplacement « corrtèxe » (double r qui déformait le mot) → « cortèxe » (modèle des mots français « annexe/taxe », prononcé /kɔʁtɛks/). Appliqué aux deux moteurs (Google TTS backend + synthèse navigateur). Le texte affiché à l'écran reste « Cortex ».
- Vérifié : transformation correcte sur toutes les casses, compilation OK. Rendu sonore à valider à l'oreille par l'utilisateur.

## 2026-08-01 — Dictionnaire vocal personnalisé (écran Profil)
- voice.js : customPhonetic() lit localStorage `sirius_phonetic` ([{mot, dit}]) et applique chaque correction avec limites de mot Unicode ((?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_]) flags giu — gère les accents, mots partiels intacts). Appliqué AVANT les corrections intégrées (permet de surcharger « cortex »/« sirius »). Actif sur les deux moteurs (Google TTS + navigateur).
- SiriusSetup.jsx : sous-section « Dictionnaire vocal » dans VOIX DE SIRIUS — liste des paires mot → prononciation avec bouton écouter (speakFr(dit)) et supprimer, 2 champs + bouton AJOUTER (Enter = ajouter, doublon par mot remplacé). CSS .setup-dict-* dans App.css.
- data-testids : setup-dict-row / -word-input / -say-input / -add-btn / -listen-{mot} / -del-{mot}.
- TESTÉ e2e (screenshot + réseau) : ajout « Groq → grok » persisté, corps de la requête /api/tts contient « grok », suppression OK.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Journal des tâches passées (durée + résultat)
- SiriusProgress.jsx : chaque tâche suivie (événements sirius-progress) est journalisée à sa fin dans localStorage `sirius_task_journal` (200 entrées max) : {ts, task, duree (ms), statut succès/erreur, resultat}. Helper fmtDuree exporté (ms / s / min).
- Consultation : panneau « JOURNAL DES TÂCHES SIRIUS » centré (z-index 96, au-dessus des wizards) — lignes avec icône statut (vert/rouge), nom, durée formatée, date/heure, message de résultat ; bouton Vider (Trash2) + fermer. Ouverture via : (1) bouton History dans l'en-tête du panneau de progression, (2) item « Journal des tâches » du menu MODULES (App.js moduleItems, événement global `sirius-journal-open`).
- data-testids : sirius-journal-panel / -row / -list / -clear-btn / -close-btn / sirius-progress-journal-btn / modules-menu-item-journal.
- TESTÉ e2e : 2 tâches simulées → 2 entrées persistées (statuts succès/erreur, durées 2,1 s / 0 ms), affichage correct, ouverture via bouton + menu, état vide, vidage OK.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — SIRIUS/ZEUS CORTEX : regard fixe + iris humain réaliste
- App.css : animation `zeusGaze` (balayage gauche/droite du visage toutes les 9 s) SUPPRIMÉE de .zeus-face-wrap (+ keyframes retirés). Clignement des paupières (.zeus-eyelid/zeusBlink) conservé.
- Image /app/frontend/public/holo/zeus.jpg RETOUCHÉE par IA (Nano Banana, mode édition via l'URL preview) : yeux bleus électriques lumineux remplacés par des yeux humains réalistes (iris bleu-gris naturel avec fibres, pupille sombre, sclère blanche, reflet discret, aucune lueur). Reste de l'image identique. Sauvegarde de l'original : /app/frontend/public/holo/zeus_glow_backup.jpg.
- TESTÉ e2e : commande « montre ton cortex » → panneau OK, getComputedStyle animationName = none, rendu visuel validé par screenshot.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Briefing & recherches approfondis (LLM)
- sirius_brain.py :
  • serp_search : 8 résultats (au lieu de 4), 6 organiques avec source, + news_results (3) + related_questions (3) + champs knowledge_graph, limite 4500 car (au lieu de 1800).
  • generate_answer : quand la recherche web est utilisée, injection d'une consigne d'APPROFONDISSEMENT — croiser les sources, relever convergences/contradictions, pop-up obligatoire structuré CONTEXTE / FAITS CLÉS / ENJEUX / ANALYSE CROISÉE / SYNTHÈSE ; réponse parlée = résumé dense 2-4 phrases.
  • _groq_answer max_tokens 900→2000 ; _parse_structured popup contenu 2000→4500 car.
  • Nouvelle enrich_briefing(data) + BRIEFING_PROMPT : briefing quotidien analytique généré par Groq à partir des données réelles (météo 7 j avec tendance + conseil, analyse croisée marchés/crypto, actualités remises en contexte avec enjeux, ciel, journée de l'utilisateur, synthèse finale avec point d'attention n°1). 12-18 phrases, sans markdown. Cache 30 min (_briefing_cache), repli sur l'ancien briefing template si pas de clé/erreur.
- server.py /api/oracle/overview : titres d'actualité 2→5 pour l'analyse, appel enrich_briefing avec toutes les données (météo, crypto, marchés, actus, lune, événements célestes, habitudes), briefing enrichi retourné dans le champ existant `briefing` (rien d'autre modifié).
- TESTÉ e2e (curl preview) : briefing 2723 car analytique (tendance météo chiffrée, rotation marchés/crypto croisée), cache OK (2e appel 0,6 s), /api/chat « parle-moi de la fusion nucléaire » → used_search=true, réponse parlée concise + popup ANALYSE structuré (CONTEXTE/FAITS CLÉS/ENJEUX...).
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Plein écran global + interface responsive
- PLEIN ÉCRAN : n'existait pas pour le HUD global (seul SIRIUS DISPLAY/Spectator l'avaient). Ajouté dans App.js : bouton Maximize/Minimize dans la barre supérieure (data-testid sirius-fullscreen-btn, avant le bouton MODULES), API Fullscreen (documentElement.requestFullscreen / exitFullscreen), état suivi via événement fullscreenchange (icône + classe .on). Sortie par Échap native.
- RESPONSIVE (App.css, bloc « RESPONSIVE — HUD SIRIUS » en fin de fichier) :
  • ≤1100px : top-bar/paddings réduits, panneaux HUD resserrés, noyau réduit.
  • ≤820px (tablette) : brand-tag compact, sys-indicators masqués, noyau min(36vh,290px), cmd-bar 94vw, panneaux HEURE/CPU/NOYAU réduits (stats-mini left:10 + right:auto pour neutraliser la règle 900px existante qui étirait le panneau), float-cards rapprochées, demo-controls wrap, sirius-progress/journal 94vw, subtitle-box max-height 30vh scrollable, modmenu 94vw.
  • ≤560px (mobile) : libellés texte du header masqués (conn-status font-size:0, boutons icônes seuls), noyau min(30vh,228px), cmd-prompt masqué, panneau NOYAU masqué, CPU/RAM max-width 180px, météo compacte, prime-grid/oracle/zeus/haccp adaptés (zeus-panel.left masqué sur téléphone).
- ⚠️ INCIDENT pendant l'édition : un search_replace a laissé 3 lignes orphelines en fin d'App.css (« * Cortex... ») cassant la compilation PostCSS — corrigé. TOUJOURS re-vérifier la fin du fichier après édits multiples sur App.css.
- TESTÉ e2e (screenshots + mesures DOM) : bouton plein écran fonctionnel (fullscreenElement true), rendus validés à 2560/1920/768/390 px, largeurs panneaux vérifiées (stats 148px mobile / 170px tablette, NOYAU 0px mobile).
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Scène antique holographique + titre SIRIUS doré
- Nouvelle image générée (Nano Banana) /app/frontend/public/holo/antique.jpg : temple grec holographique cyan (colonnes ioniques des deux côtés + cruche/amphore sur piédestal), centre sombre pour lisibilité.
- App.js : couche `<div className="antique-bg" style backgroundImage url(/holo/antique.jpg)>` insérée entre .grid-bg et .scanline (⚠️ l'URL doit rester en style inline : css-loader CRA ne résout pas /holo/... dans App.css). CSS .antique-bg : cover, opacity 0.42 animée (antiquePulse 12 s), mix-blend-mode screen, masque radial (centre transparent 16 % → visible aux bords) pour ne pas gêner le noyau.
- .sirius-title : blanc/cyan → OR. Dégradé doré animé en background-clip:text (goldSheen 5,5 s balayage de reflet) + halo doré pulsant en drop-shadow (goldPulse 3 s) ; hudGlitch conservé. Anciennes keyframes titlePulse laissées (plus référencées par le titre).
- TESTÉ e2e (screenshot 1920px) : colonnes + cruche visibles et fondues au HUD, titre doré rendu, compilation OK après correction (première tentative url("../public/...") puis url("/...") en CSS = erreurs webpack → solution style inline).
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Navigation tactile (balayage + pincement)
- Nouveau hook /app/frontend/src/useTouchNav.js : écouteurs touch globaux passifs — balayage 1 doigt (|dx|≥90px, dominante horizontale, <650 ms), pincement 2 doigts (ratio <0.72 = pinch-in, >1.38 = pinch-out, déclenché une fois par geste). Ignore les gestes partant d'éléments interactifs/draggables (inputs, boutons, .card-drag-grip, .zc-section-title, fenêtres web/task/display/progress/journal, modmenu, setup, [data-hud-panel], float-card).
- App.js : TOUCH_RING (13 modules ordonnés : Pantheon, Nexus, Oracle, Prime, Cortex, Argus, Locus, Heracles, Galerie Mythos, Trailer, Packager, Scripts, HACCP). Balayage gauche/droite = module suivant/précédent (ferme l'actuel, ouvre le voisin). Pinch-in = ferme le module ouvert (« RETOUR AU HUD ») ou le menu. Pinch-out (rien d'ouvert) = ouvre le menu MODULES. Toast HUD .touch-toast (data-testid sirius-touch-toast, 1,4 s, App.css) annonce la destination. Handlers à jour via ref (pas de stale closure).
- TESTÉ e2e (TouchEvent synthétiques, viewport 768) : pinch-out → menu ouvert, Oracle → balayage gauche → SIRIUS PRIME + toast, pinch-in → fermeture + toast « RETOUR AU HUD ».
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Mains de Sirius redessinées (nobles et soignées)
- /app/frontend/public/holo/hand.png REMPLACÉE : ancienne main sale (peau craquelée/brûlée, veines de lave orange) → main divine noble : peau lisse impeccable, doigts élégants, ongles manucurés, halo holographique cyan + filaments dorés. Sauvegarde : hand_old_backup.png.
- PROCESS (leçon) : le mode édition Nano Banana renvoie des JPEG avec damier de transparence INCRUSTÉ (2 tentatives). Solution fiable : génération from scratch sur fond noir pur (#000) puis détourage Python (PIL/numpy : alpha = (max(R,G,B)-14)/186 ^0.85, unmultiply) → vrai PNG RGBA transparent.
- App.css .holo-hand : drop-shadow orange lave → double drop-shadow cyan (90,220,255) + or (240,200,110), brightness 0.96.
- TESTÉ e2e : 2 mains rendues dans le HUD, intégration parfaite avec éclairs + scène antique + titre doré.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Bijoux antiques sur les mains de Sirius
- hand.png mise à jour (même pipeline : édition Nano Banana de la version fond noir pur → détourage Python alpha/unmultiply → PNG RGBA) : ajout de bracelets grecs antiques dorés au poignet (armilla serpent, bande à méandre grec, jonc à pierres) + 3 bagues (chevalière gravée, anneau fin, bague à pierre), métal doré translucide lumineux assorti au style holographique de la scène antique. Pose et main inchangées.
- Référence pour futures retouches : l'image source fond noir avec bijoux est l'URL statique hand_jewelry (jobs/.../2d401eea...). Backup précédent conservé : hand_old_backup.png (main sale d'origine).
- TESTÉ e2e : rendu HUD vérifié — bracelets et bagues visibles sur les 2 mains, cohérents avec colonnes/cruche/titre or.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Repositionnement des mains (pose naturelle)
- La nouvelle main (pose verticale doigts vers le haut) ne collait plus à l'ancien placement (centrée verticalement, coupée en plein écran). Correctif :
  • App.css .holo-hand : top:50%/margin-top → ancrage bas (top:auto; bottom:-7vh), height min(58vh,40vw), transform-origin 50% 88%, left/right -3vw.
  • HoloScene.jsx (l.276-277) : inclinaison de base vers le noyau ajoutée dans les transforms JS (rotate ±12° + oscillation ±1,5°, sway réduit à 8px). NB : le JS écrase style.transform à chaque frame — toute rotation de base DOIT être dans ces 2 lignes, pas en CSS.
- TESTÉ e2e : les mains émergent naturellement des coins inférieurs, doigts vers le noyau, éclairs partant des mains, bijoux visibles.
- ⚠️ Redéploiement nécessaire pour pousser en production.

## 2026-08-01 — Titre SIRIUS agrandi
- .sirius-title : clamp(50px,9.8vh,100px)/ls 10px → clamp(72px,17vh,176px)/ls 16px (margin-right -16px). Responsive ajusté : ≤820px clamp(48px,12vh,92px), ≤560px clamp(38px,9vh,64px).
- TESTÉ : rendu 1920px vérifié (582×204 px), doré, centré sur le noyau, HUD intact.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — PWA complète (installable + hors ligne de base)
- Une base existait déjà (manifest.json, sw.js minimal, meta iOS/Android, icônes 192/512, enregistrement dans index.html). Complétée :
  • sw.js réécrit (cache sirius-v2) : pré-cache du shell à l'install (/, manifest, icônes, images holo), nettoyage des anciens caches à l'activation, navigation network-first avec repli hors ligne sur "/", ressources network-first + cache, /api/ jamais mis en cache.
  • icon-180.png créée (apple-touch-icon 180×180 opaque fond #03060c, iOS n'aime pas la transparence) — lien index.html mis à jour avec sizes.
  • theme_color #000 → #06121d (manifest + meta theme-color) assorti au HUD.
- TESTÉ e2e : SW enregistré/activé (scope racine), cache sirius-v2 = 19 ressources, manifest servi (standalone, 2 icônes maskable), tous les fichiers en 200.
- ⚠️ Redéploiement nécessaire pour pousser en production (l'installation PWA se fait depuis le site déployé HTTPS).

## 2026-08-01 — Titre lettre par lettre avec éclat doré
- App.js : h1 .sirius-title → 6 spans .sirius-title-letter (animationDelay 0,25 s + i×0,16 s), classe .waiting pendant `booting` (animation-play-state:paused → l'animation démarre à la FIN de l'écran de boot, delay inclus).
- App.css : .sirius-title-letter (inline-block, background:inherit + background-clip:text par lettre pour conserver le dégradé or) ; @keyframes letterIn : montée + éclat doré fort à 45 % (double drop-shadow or) puis stabilisation ; white-space:nowrap ajouté sur .sirius-title (les spans inline-block wrappaient sur 2 lignes sinon).
- TESTÉ e2e : apparition séquentielle visible après le boot (capture à mi-anim : ΣIRI + éclat sur la 4e lettre), titre final complet sur une seule ligne (tops identiques), opacités finales 1.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Mains masculines + position remontée
- hand.png régénérée (édition Nano Banana de la version bijoux fond noir → détourage Python) : main clairement MASCULINE (paume large, doigts épais, poignet fort, tendons subtils), toujours noble/propre avec les bijoux antiques. .holo-hand bottom -7vh → -2vh (position remontée). TESTÉ : screenshot validé.

## 2026-08-01 — Page de présentation (boot) : typographie Cinzel + or partout
- .boot-title : Orbitron blanc/cyan → Cinzel 700 avec le MÊME dégradé or animé que .sirius-title (background-clip:text + goldSheen) + halo doré ; anim bootglitch conservée.
- .boot-acro-item b : Cinzel or #f5c542 (halo or) ; i : #cfa54d. .boot-log/.boot-line : or #f0cd6e (ombre dorée). .boot-bar-fill : dégradé or. .boot-pct : #e8c979. .boot-sub : #d9a940. Réacteur cyan et layout inchangés (« ne modifie rien d'autre »).
- TESTÉ : screenshot du boot — tout le texte doré, cohérent avec la page principale.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Anneau doré du réacteur (page de présentation)
- App.css .boot-reactor : position:relative + ::before (anneau segmenté conic-gradient or masqué en couronne, rotation goldRingSpin 7 s, drop-shadow doré) + ::after (fin liseré circulaire doré, pulsation goldRingPulse 3 s). Aucun changement JSX ni au canvas ReactorCore.
- TESTÉ : screenshot boot — anneau doré autour du cœur cyan, assorti au titre or.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — PWA : invitation d'installation + notifications push
- BACKEND /app/backend/push_notifications.py (router /api/push, inclus dans server.py) : clés VAPID auto-générées et persistées (vapid_private.pem), abonnements en JSON (push_subs.json). Endpoints : GET /push/public_key, POST /push/subscribe, /push/unsubscribe, /push/send {title, body, url} (envoi à tous, purge des abonnements 404/410). Fonction réutilisable send_push_to_all(). Dépendances : pywebpush, py_vapid (requirements.txt mis à jour).
- SW (sw.js) : handlers "push" (showNotification icône/badge icon-192, vibration) et "notificationclick" (focus/ouverture de l'app sur data.url).
- FRONTEND PwaPrompt.jsx + .css (monté dans App.js) :
  • Bannière élégante « Installer SIRIUS » (icône, or/cyan, bas centré, z 1100) sur beforeinstallprompt ; bouton INSTALLER → prompt() ; iOS (pas d'event) → instructions Partager → écran d'accueil après 6 s ; croix = rejet mémorisé 7 jours (sirius_pwa_dismiss) ; masquée en mode standalone.
  • Bouton NOTIFICATIONS (si permission "default") : requestPermission → pushManager.subscribe(VAPID) → POST subscribe → notification de bienvenue via /push/send. En mode installé : pastille « ACTIVER LES NOTIFICATIONS » tant que permission default.
- TESTÉ : curl 4 endpoints OK (clé servie, abonnement persisté/purgé, send ok) ; bannière e2e (event simulé) : affichage, prompt() appelé, fermeture, dismiss mémorisé. NOTE : la réception réelle d'un push nécessite un vrai navigateur/appareil (non testable en headless) — à valider par l'utilisateur après redéploiement.
- ⚠️ Redéploiement nécessaire. ATTENTION prod : vapid_private.pem/push_subs.json sont des fichiers locaux au pod (éphémères selon le déploiement).

## 2026-08-01 — Fichier .env modèle complet
- Créé /app/backend/.env.example : TOUTES les clés utilisées dans le code (scan os.environ/getenv), valeurs vides, groupées et commentées avec l'URL d'obtention de chaque clé : Groq (+GROQ_MODEL), EMERGENT_LLM_KEY, Gemini, Google TTS, SerpAPI, NewsAPI, OpenWeather, Alpha Vantage (emplacement futur), RestCountries, Europeana, Spotify (id/secret/redirect), Fal.ai, Microsoft Graph (id/secret/redirect), + système (MONGO_URL/DB_NAME/CORS_ORIGINS).
- Vrai /app/backend/.env : ajout du seul emplacement manquant ALPHA_VANTAGE_API_KEY= (vide) via search_replace ; toutes les autres clés y sont déjà renseignées. Backend redémarré, OK (200).

## 2026-08-01 — Statut des clés API + Veille push proactive
- BACKEND :
  • GET /api/system/keys_status (défini AVANT app.include_router — leçon : toute route ajoutée après l'include est 404) : 13 services avec booléen configured (jamais les valeurs) — Groq, TTS, Serp, News, Weather, Alpha Vantage, RestCountries, Europeana, Spotify, Fal, Outlook, Gemini, Emergent.
  • push_notifications.py : config veille (push_watch.json : enabled/interval_min/last_run/sent_titles), endpoints GET/POST /api/push/watch (intervalle borné 15-720 min), subscriber_count().
  • server.py _push_watch_loop() (asyncio task au startup) : toutes les interval_min (défaut 60), si enabled + abonnés>0 + NEWS_API_KEY → _fetch_headlines(5), envoie par push les titres jamais envoyés (max 2/cycle, dédup sent_titles[-60:]) via send_push_to_all("SIRIUS — Veille active", titre).
- FRONTEND KeysStatus.jsx + .css (item « Statut des clés API » du menu MODULES, state showKeysStatus) : panneau centré HUD — 13 lignes avec LED verte pulsante/rouge + badge CONFIGURÉE/MANQUANTE + compteur 12/13 ; section dorée « VEILLE PUSH PROACTIVE » (LED, description intervalle + nb d'appareils, bouton toggle ON/OFF branché sur /push/watch, bouton TESTER → /push/send avec message de résultat).
- TESTÉ e2e : endpoints curl OK (12/13 configurées, toggle persisté, intervalle 45), panneau UI vérifié (13 lignes, LEDs correctes dont Alpha Vantage rouge, toggle ON→OFF→ON, message test « Aucun appareil abonné » correct sans abonnés).
- ⚠️ Redéploiement nécessaire. La veille push réelle se déclenche quand au moins un appareil a activé les notifications.

## 2026-08-01 — Correctifs page principale (titre / mains / peau mate)
- 1) Chevauchement du titre : cause = animation hudGlitch (clip-path + translateX en boucle 9 s) sur .sirius-title qui « tranchait » le titre → RETIRÉE (goldSheen + goldPulse conservées) ; letterIn adouci (scale 1.4→1.1, état final transform:none).
- 2) Mains à l'envers : miroirs échangés dans HoloScene.jsx (l.276-278) — gauche SANS scaleX(-1), droite AVEC scaleX(-1) → pouces vers le noyau ; rotations inversées (±12°) ; position remontée (.holo-hand bottom -2vh → 5vh, height 56vh/38vw).
- 3) Peau mate : hand.png traitée en Python (compression des hautes lumières : L>150 → 150+(L-150)*0.55, teinte préservée) + CSS filter brightness 0.85 / saturate 0.82 / contrast 1.03, drop-shadows atténués, opacity 0.92.
- TESTÉ par testing_agent (iteration_18.json) : 100 % PASS — lettres finales sans chevauchement ni glitch sur 10,5 s, matrices main gauche a>0 / droite a<0, bottom 54px, filtres mats confirmés, barre de commande OK, aucune erreur console liée.
- ⚠️ Redéploiement nécessaire (l'utilisateur voit la production sirius-hud-redesign.emergent.host).

## 2026-08-01 — Mains : paumes vers le sol, doigts vers le bas
- Nouvelle hand.png générée (fond noir pur → détourage + matifiage Python en un seul pipeline) : main droite MASCULINE vue de DOS, poignet entrant par le HAUT, doigts pointant vers le BAS (paume face au sol), bijoux or (serpent, méandre, bagues), peau mate.
- App.css .holo-hand : ancrage haut (top:-4vh, bottom:auto), height min(52vh,36vw), transform-origin 50% 10% (pivot au poignet).
- HoloScene.jsx : gauche = scaleX(-1) rotate(-10°±1,5), droite = sans miroir rotate(+10°±1,5) (pouces vers le noyau, l'image étant une main droite).
- TESTÉ (screenshot 1920) : mains suspendues au-dessus du noyau des deux côtés, doigts vers le bas, éclairs OK. Auto-testé visuellement (pas de testing_agent : critère purement visuel).
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Mains : retour à la position latérale centrée d'origine
- App.css .holo-hand : ancrage haut retiré → position initiale restaurée (top:50% + margin-top -height/2, height min(60vh,46vw), left/right -6vw, transform-origin 50%). HoloScene.jsx : rotations de base supprimées (oscillation ±1,5° seule), miroirs conservés (gauche scaleX(-1)). Orientation « paumes vers le sol / doigts vers le bas » conservée via l'image.
- TESTÉ (screenshot 1920) : une main de chaque côté au niveau central, rendu validé.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Suppression de l'animation lettre par lettre du titre (demande utilisateur)
- App.js : h1 .sirius-title de retour en texte simple « ΣIRIUS » (spans supprimés). App.css : classe .sirius-title-letter, .waiting et @keyframes letterIn SUPPRIMÉES (remplacées par un commentaire). Conservé : dégradé or animé goldSheen + halo goldPulse (aspect doré d'origine, sans hudGlitch retiré plus tôt).
- NE PAS réintroduire d'animation par lettre sur ce titre sans demande explicite (l'utilisateur l'a rejetée deux fois).
- TESTÉ par testing_agent (iteration_19.json) : 100 % PASS — texte simple 1 nœud sans spans, animation-name exactement 'goldSheen, goldPulse', géométrie stable à 0,000 px sur 13 s, mains latérales centrées, barre de commande OK.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Suppression définitive du bouton micro « Parler à Sirius »
- App.js (~l.3414) : bouton .mic-btn (data-testid sirius-mic-btn, toggleMic) SUPPRIMÉ du JSX de la barre de commande. Le talkie-walkie (.ptt-btn ESPACE) et ENVOYER sont intacts. La logique micOn/toggleMic/reconnaissance continue reste dans le code (utilisée par autoMic interne) mais sans bouton UI.
- NE PAS réintroduire ce bouton (demande explicite « supprime-le définitivement »).
- TESTÉ (DOM + screenshot) : sirius-mic-btn absent, sirius-ptt-btn visible, cmd-send OK.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Harmonie or/cyan globale (CSS uniquement)
- Bloc « HARMONIE OR » en fin d'App.css (overrides additifs, aucune structure/fonctionnalité modifiée) : variables --gold/--gold-light/--gold-soft/--gold-dim ; titres or (.panel-title, .fc-head, .zc-section-title, .keys-watch-head, .modmenu-head, .web-window-title, .tw-title) ; liserés dorés top (.hud-panel, .float-card, .prime-card) ; actifs or (.demo-btn.active, .profile-btn.on, .haccp-tab.active) ; .cmd-prompt + .ptt-btn or ; .subtitle-box liseré gauche or ; compteurs .sp-count/.keys-count or ; .brand-tag .dot or.
- TESTÉ (screenshots page principale + PANTHEON) : cyan dominant conservé, or élégant sur titres/accents.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Or généreux v2 (luxe) + correctif schéma profil
- App.css : bloc « OR GÉNÉREUX v2 » en fin de fichier — coins d'écran or, marque ΣIRIUS or lumineux, titres de panneaux HUD (.hud-panel-title + icônes) or avec séparateur doré, jauges dégradé cyan→or, icônes stats or, survols boutons or, cmd-send/cmd-input focus or, scrollbars/sélection or, menu Modules (bordure, icônes, hover) or, panneau Clés or, fenêtre Progression (titre + barre) or, titres de tous les grands modules or, cartes suggestions/PWA banner or, onglets HACCP (.hc-tab.on) or, écran de boot (barre + pct) or.
- Spécificité doublée (.keys-count.keys-count, .iw-title.iw-title, .sp-count.sp-count, .modmenu-head.modmenu-head, .tw-title.tw-title) pour gagner la cascade contre les CSS de composants chargés après App.css.
- BUG RÉEL CORRIGÉ : App.js vérifiait profile.prenom (3 effets : assistant d'installation, cinématique WAHOU, vérif clés) alors que SiriusSetup sauvegarde profile.name → ces effets ne se déclenchaient jamais. Corrigé en (profile.name || profile.prenom). SiriusSetup.jsx isEdit accepte aussi prenom (bouton fermer présent en édition).
- TESTÉ : testing_agent iteration_20.json (82% → défauts corrigés) + screenshots (HUD principal, HACCP onglet actif or) + probe getComputedStyle (keys-count/iw-title/sp-count = or). Briefing dit bien « Bonjour Test » avec profile.name.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — KERAUNOS# : module domotique Home Assistant
- Backend : /app/backend/home_assistant.py (make_ha_router, Mongo coll ha_config, doc unique _id="main") — GET/POST/DELETE /api/ha/config (validation URL + test connexion avant sauvegarde), POST /api/ha/test (url/token fournis ou sauvegardés), GET /api/ha/states (proxy filtré aux domaines utiles, tri contrôlables d'abord), POST /api/ha/toggle (homeassistant.toggle, scène/script → turn_on), POST /api/ha/service (générique, ex. light.turn_on brightness_pct). Pydantic strict (pattern entity_id/domain/service → 422). ⚠️ Cloudflare intercepte les 502/504 d'origine → erreurs de connexion HA mappées en 400.
- Frontend : KeraunosPanel.jsx + Keraunos.css — écran de connexion (champs URL/token VIDES par demande utilisateur, boutons TESTER/CONNECTER, aide création token), liste d'appareils groupée par domaine (or/cyan), toggle on/off optimiste, slider luminosité lumières, filtre, engrenage → config (RETOUR), polling 4 s. Enregistré dans App.js (import, state showKeraunos, moduleItems id "keraunos" icône Home, rendu conditionnel).
- TESTÉ : testing_agent iteration_21 (mock HA localhost:8199) — 100 % frontend, backend happy-paths 100 %, 2 validations corrigées ensuite (422 vérifié par curl). Config nettoyée (configured:false) pour que l'utilisateur saisisse ses identifiants.
- NOTE SÉCURITÉ (relevée par le test) : comme tout le reste de l'app, /api/ha/* est sans authentification — app personnelle ; à signaler si déploiement public partagé.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Voix domotique : « allume le salon » via KERAUNOS
- Backend : POST /api/ha/command (home_assistant.py) — NLU français léger : normalisation accents, détection action (allumer/éteindre/fermer), luminosité (« à 40 % », « baisse »=30, « monte »=100), « toutes les lumières », scènes/scripts, correspondance floue avec friendly_name (score tokens + hint domaine lumière/prise/ventilateur/volet). Réponses TOUJOURS en 200 avec {ok, speech} (parlées par Sirius), accord grammatical féminin heuristique (prise/lampe/…e). Erreurs service HA renvoyées en speech (pas de 4xx).
- Frontend App.js : bloc « 0keraunos » dans processCommand (APRÈS musique/ambiance, AVANT HACCP) — regex verbes domotiques avec exclusions (musique|ambiance|caméra|vision|micro|écran|documentaire|mode ) ; appelle /api/ha/command, parle d.speech ; si non configuré → ouvre le panneau KERAUNOS automatiquement. + moduleCmds : « ouvre keraunos/domotique » ouvre/ferme le panneau.
- TESTÉ : curl via mock HA (allume salon, éteins prise TV, 40 %, baisse, toutes les lumières, scène soirée, appareil inconnu → liste) + E2E screenshot barre de commande « allume le salon » → « Salon allumé. » affiché/parlé. Config nettoyée ensuite (configured:false). Mock étendu : accepte tout POST /api/services/*.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Mention de copyright sur tous les fichiers
- « © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France). » ajouté en tête de 140 fichiers (backend .py, frontend .js/.jsx/.css, index.html après le doctype, sw.js, electron.js, plugins, tests). Script idempotent (détection « © 2026 Daniel Partel » dans les 300 premiers caractères) — les .json et .env sont exclus (pas de commentaires possibles).
- TESTÉ : backend curl OK, frontend compile et HUD complet rendu (screenshot), aucun service cassé.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Copyright : version française définitive
- L'en-tête anglais a été REMPLACÉ dans les 140 fichiers par la version française : « © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France). »
- Script de référence : détection/remplacement idempotent. TESTÉ : backend + frontend OK après remplacement.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — LICENCE propriétaire à la racine
- /app/LICENSE créé : « SIRIUS Assistant – Licence Propriétaire © 2026 Daniel Partel » (droit d'usage non exclusif/non transférable, interdictions de reproduction/rétro-ingénierie/revente/publication, usage personnel/pro selon contrat, révocation en cas de violation).
- frontend/package.json : champ "license": "SEE LICENSE IN LICENSE" ajouté (convention npm pour licence propriétaire).
- TESTÉ : services OK après modification.

## 2026-08-01 — Contrat de licence client (.txt) à la racine
- /app/CONTRAT_LICENCE.txt créé : contrat de licence logiciel SIRIUS Assistant (éditeur Daniel Partel / [Nom du client]) — objet, propriété exclusive, droits accordés ([X] postes, mises à jour, support), restrictions, responsabilité, durée illimitée, résiliation, signatures. Champs à compléter : [Nom du client], [X], [Ville], [Date].

## 2026-08-01 — Nouveau logo officiel + icônes plateformes remplacés
- L'utilisateur a fourni sa propre image de logo (Σ or + triangle circuit cyan, anneau méandre grec, SIRIUS or). /app/logo_sirius.png remplacé (1024×1024 PNG).
- Icônes PWA/plateformes régénérées depuis cette image : icon-512.png, icon-192.png, icon-180.png (Apple), icon.png, icon.ico (multi-tailles) dans frontend/public/.
- sw.js : cache bump "sirius-v2" → "sirius-v3" pour forcer le rafraîchissement des icônes en PWA installée.
- TESTÉ : les 3 icônes servies en 200 avec les nouvelles tailles.

## 2026-08-01 — Bloc « À propos » + footer légal
- AboutPanel.jsx + About.css : panneau minimaliste centré « À propos de SIRIUS Assistant » avec le texte exact demandé (logiciel propriétaire, Daniel Partel, © 2026 – Tous droits réservés), bouton fermer. Entrée « À propos / Informations légales » (icône BadgeInfo) dans le menu MODULES.
- Footer global .sirius-footer : bandeau fixe très fin en bas, centré, « © 2026 SIRIUS Assistant – Daniel Partel », typo fine 10px, opacité 45 %, pointer-events:none (non intrusif).
- TESTÉ (screenshot + DOM) : footer visible avec le bon texte, panneau À propos s'ouvre depuis le menu MODULES.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — HACCP : 10 modèles de feuilles imprimables (onglet FEUILLES)
- HaccpSheets.jsx : définitions SHEETS (10 modèles avec colonnes exactes demandées) + buildSheetHtml (HTML A4 autonome minimaliste : titre, sous-titre, Établissement/Semaine, tableau à lignes vides, zone Remarques/Actions correctives, Date + Signature du responsable, footer ©) + printSheet (window.open + window.print → impression ou export PDF navigateur). Feuilles larges (réception, traçabilité plats) en paysage.
- Modèles : prise de température, contrôle cuissons, refroidissement rapide, remise en température, réception marchandises, huiles de friture, plan de nettoyage, traçabilité des plats, gestion DLC/DDM, maintenance équipements.
- HaccpModule.jsx : onglet "FEUILLES" (icône Printer) + SECTIONS.sheets. App.css : styles .hc-sheet-card / .hc-sheet-print (cartes or/cyan, grille 2 colonnes, responsive 1 colonne).
- TESTÉ (screenshot + automation) : 10 cartes affichées, fenêtre d'impression s'ouvre avec le bon titre et les 6 colonnes attendues pour la feuille température.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Feuilles HACCP pré-remplies
- HaccpSheets.jsx : FILLERS (5 feuilles pré-remplissables depuis les données saisies) — temp (relevés + plages cibles équipements), réception & traçabilité plats & DLC/DDM (depuis /haccp/trace, statut DLC traduit), plan de nettoyage (tâches zone/produit/fréquence/responsable). printSheet(sheet, prefill) : lignes remplies + minimum 4 lignes vierges. Cartes : point doré + bouton or « PRÉ-REMPLIE » (FileDown) à côté de « VIERGE ».
- LEÇON IMPORTANTE : ne JAMAIS lancer plusieurs search_replace EN PARALLÈLE sur le MÊME fichier (écrasement mutuel silencieux — un des 3 edits sur HaccpSheets.jsx avait été perdu malgré « Edit successful »). Toujours séquencer les modifications d'un même fichier.
- TESTÉ E2E : données seedées par curl → 5 boutons PRÉ-REMPLIE affichés, feuille température contient « Daniel / 3.2 / Chambre froide », feuille réception contient « Poulet fermier / Volailles Bresse / 05/08/2026 ». Données de test nettoyées ensuite.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Module de dépôt unifié (drag & drop, Ctrl+V, explorateur)
- DropZone.jsx : composant réutilisable — drag & drop avec surbrillance or, collage Ctrl+V (clipboardData.items kind=file → conversion Blob→File avec nom auto « collé-{ts}.{ext} »), bouton « EXPLORER MON PC » (input file multiple), prévisualisations images (URL.createObjectURL, 5 s), upload instantané vers POST /api/files/upload (20 Mo max), event global "sirius-files-updated". Exporte useFileUpload / clipboardFiles / toFile.
- GlobalDrop.jsx : capteur monté à la racine d'App.js → drag & drop et Ctrl+V actifs dans TOUTES les fenêtres (HUD, modules, personnages, paramètres, scènes…) avec overlay plein écran doré « Déposez vos fichiers » + toast bas-droit avec miniatures. N'intercepte le paste QUE si le presse-papiers contient des fichiers (le texte dans les inputs n'est pas touché) ; ignore les drops sur une .dropzone locale (pas de double upload).
- FilesPanel.jsx : DropZone intégrée au-dessus de la barre + rechargement sur "sirius-files-updated". DropZone.css : styles unifiés or/cyan.
- TESTÉ E2E (automation) : paste global depuis le HUD → toast + fichier en médiathèque ; drop dans la DropZone → fichier listé ; bouton Explorer présent. Fichiers de test supprimés ensuite.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Analyse IA des dépôts + dossiers médiathèque
- Backend : dossier automatique à l'upload (dossier_for : Photos/Sons/Vidéos/Documents/Autres, fallback dans GET /files pour anciens fichiers), POST /api/files/{id}/analyze (images → vision Groq ; PDF → pypdf 15 pages max ; text/json → décodage) stocke {description, texte, at} dans record.analyse, PATCH /api/files/{id}/dossier (déplacement manuel, non exposé en UI pour l'instant).
- sirius_brain.py : analyze_upload(kind, payload, keys) — FIX CRITIQUE : le modèle vision Groq meta-llama/llama-4-scout-17b-16e-instruct est DÉPRÉCIÉ (404) → remplacé par qwen/qwen3.6-27b (multimodal) dans analyze_upload ET ocr_screen (l'OCR d'écran était cassé aussi). Qwen est un modèle « thinking » → strip des blocs <think>…</think>.
- Frontend : DropZone.jsx exporte autoAnalyze(records) (analyse auto en arrière-plan après chaque dépôt, clés localStorage, refresh via event) appelé par useFileUpload ET FilesPanel.upload. FilesPanel : onglets dossiers DYNAMIQUES (standards + dossiers existants comme YouTube/Images, compteurs), bouton Sparkles or (analyser / afficher-replier l'analyse), zone .file-analyse (description + texte extrait, scrollable). pypdf ajouté à requirements.txt.
- TESTÉ E2E : upload image+txt par curl → dossiers Photos/Documents corrects, analyse image (« SIRIUS TEST 42 / Analyse IA active » extrait) et document (résumé HACCP fidèle) ; UI : onglets dynamiques OK, panneau d'analyse affiché. Fichiers de test supprimés.
- ⚠️ Redéploiement nécessaire.

## 2026-08-01 — Recherche médiathèque + déplacement manuel de fichiers
- Recherche (FilesPanel) : champ avec icône loupe — recherche par mots-clés dans nom, dossier, description IA et texte extrait ; normalisation accents ; mots vides ignorés (la, photo, avec, image…) → « la photo avec le chat » trouve le fichier dont la description IA contient « chat ». Compteurs de dossiers filtrés en direct.
- Déplacement : cartes draggable (dataTransfer type "text/sirius-file", GlobalDrop ignore car pas de Files) → drop sur un onglet dossier (surbrillance or + scale) → PATCH /api/files/{id}/dossier ; pendant le drag : hint + chip pointillé « NOUVEAU DOSSIER » (prompt du nom). Les 4 dossiers standards apparaissent comme cibles pendant un drag même vides.
- TESTÉ E2E : recherche « la photo avec le chat » → chat.png (via description IA seedée) ; « fusées spatiales » → bon fichier (accents OK) ; drag & drop simulé → « Déplacé vers Documents ✓ » persisté. Fichier de test supprimé.
- ⚠️ Redéploiement nécessaire.

## 2026-08-02 — Visionneuse universelle + éditeur intégré (Monaco)
- Backend : GET /api/files/{id}/content (fichiers texte ≤2 Mo, détection is_text_file par content_type+extension TEXT_EXTS), POST /api/files/{id}/update {content} (réécriture put_object avec 1 RETRY après 0,8 s — le stockage objet renvoie parfois un 500 transitoire), alias POST /api/upload → upload_file.
- Frontend : FileViewer.jsx + FileViewer.css — modal plein écran : images (img), PDF (iframe inline), audio/vidéo (players), texte/code → Monaco Editor (@monaco-editor/react, thème vs-dark, langage auto par extension : py/js/json/html/css/md/xml/yaml/log/txt…), bouton or « ENREGISTRER DANS SIRIUS », état « ● modifié », autosave brouillon localStorage (débounce 800 ms, clé sirius_draft_{id}) avec bannière « RESTAURER » si brouillon divergent, protection fermeture par clic extérieur si modifié.
- FilesPanel : clic sur vignette/nom → visionneuse (classe .clickable). Monaco chargé depuis CDN jsdelivr (lazy).
- TESTÉ E2E : /api/upload alias OK, lecture contenu OK, update persisté OK (relecture), UI : visionneuse ouverte, Monaco chargé avec coloration Python, édition → dirty → « Enregistré dans Sirius ✓ ». Fichier test supprimé.
- ⚠️ Redéploiement nécessaire.

## 2026-08-02 — Module ESPACE 3D (three.js) + diagnostic « Sirius endormi »
- Diagnostic : l'utilisateur voyait Sirius « endormi » en PRODUCTION → version obsolète, il doit REDÉPLOYER (tout fonctionne en preview : cortex, proactive, météo, CPU/RAM). Vieille scène three (src/three/ Hand/Cortex/Lightning) laissée débranchée (choix par défaut utilisateur).
- NOUVEAU module ESPACE : EspacePanel.jsx + Espace.css — Canvas @react-three/fiber : Soleil doré (sphère + wireframe or + sprite glow pulsant + pointLight), Terre holographique (sphère bleue emissive + wireframe cyan + halo atmosphère BackSide) en orbite (anneau or), Lune grise en orbite autour de la Terre (anneau cyan), champ de 1600 étoiles. Animations useFrame (orbites + rotation propre) avec PAUSE/REPRENDRE (ref paused). Caméra orbitale manuelle (OrbitCamera : pointer drag theta/phi, molette zoom 10–110, lookAt origine) + bouton RECENTRER (reset CAM_HOME) → objets toujours visibles. Légende Soleil/Terre/Lune + hint contrôles.
- App.js : import, state showEspace, menu item id "espace" (icône Globe2), rendu, commande vocale « ouvre le système solaire / planètes / zone espace ».
- TESTÉ : screenshot — scène rendue (Soleil, Terre wireframe, Lune, orbites, étoiles), boutons présents, HUD actif derrière. (readPixels 0 = normal sans preserveDrawingBuffer.)
- ⚠️ REDÉPLOIEMENT NÉCESSAIRE pour que la production se « réveille » avec toutes les nouveautés.

## 2026-08-02 — Blindage responsive page de configuration
- Signalement utilisateur : page config coupée à droite sur PC. NON REPRODUIT en preview (testé 820/900/1100/1280/1366/1536/1920 px → 0 px de débordement partout, avant ET après fix). Très probablement la PRODUCTION obsolète (déployée le 01/08) ou zoom navigateur.
- Blindage appliqué (App.css) : .setup-screen overflow-x:hidden ; .setup-card max-width:min(880px, calc(100vw - 32px)) + box-sizing ; inputs/selects/textarea max-width:100% ; .setup-cols min-width:0 ; passage 1 colonne dès 940px (au lieu de 760px).
- Si le problème persiste après redéploiement : demander un screenshot + résolution/zoom.

## 2026-08-03 — Vérification Ctrl+V dans toutes les fenêtres + fix double upload
- Vérifié par automation (Playwright, presse-papiers réel) : collage TEXTE OK dans barre de commande, SETUP (input nom + textarea style), KERAUNOS (URL), HACCP (champ produit), recherche médiathèque. Collage FICHIER OK depuis le HUD (upload + toast global, champ texte focus non pollué) et dans la médiathèque.
- BUG TROUVÉ ET CORRIGÉ : double upload quand la Médiathèque est ouverte — le listener paste de DropZone ET celui de GlobalDrop réagissaient tous deux (le check e.target.closest('.dropzone') échouait quand target=window/body). Fix GlobalDrop.onPaste : skip si document.querySelector('.dropzone') existe (la zone locale gère). Re-testé : 1 seul upload.

## 2026-08-03 — Barre de progression branchée sur toutes les tâches principales
- La fenêtre SiriusProgress (or/cyan, %, étapes horodatées, badge TERMINÉ) existait mais n'était branchée que sur 4 modules (Argus, Packager, ScriptInstaller, SystemModes + WebSocket tasks). Désormais instrumentée sur : Réponse de Sirius (cloudAnswer : analyse → interrogation Groq → synthèse → délivrée ; erreur si repli local), Briefing du jour, Commande domotique, Dépôt de fichiers (progression par fichier), Analyse IA de chaque fichier déposé.
- Nouveau mode silencieux : progress.start(titre, {silent:true}) — l'annonce vocale « Je lance la tâche / Tâche terminée » est coupée pour les tâches qui parlent déjà (réponse, briefing, domotique) et les tâches de fond (dépôts, analyses). BUG ÉVITÉ : l'annonce « Tâche terminée » écrasait le sous-titre de la vraie réponse.
- TESTÉ E2E : question LLM → fenêtre visible avec étapes en direct (35 % → 78 % → 100 % TERMINÉ), sous-titre = vraie réponse, fenêtre se replie automatiquement.
- ⚠️ Redéploiement nécessaire.

## 2026-08-03 — Suppression du bouton MODULES (doublon avec la loupe)
- Bouton « MODULES » (Grip, data-testid sirius-modules-btn) supprimé de la barre du haut — la loupe (sirius-cmdpalette-btn, Ctrl+K) reste l'accès unique aux modules via la palette de commandes (items = moduleItems, identiques).
- ModulesMenu reste monté (commandes vocales « ouvre les modules » fonctionnent toujours via showModulesMenu).
- ⚠️ IMPORTANT POUR LES TESTS FUTURS : ne plus cliquer "text=MODULES" — ouvrir les modules via [data-testid='sirius-cmdpalette-btn'] puis taper le nom + Enter.
- TESTÉ E2E : bouton absent, loupe présente, palette → « haccp » → Enter → module HACCP ouvert.
- ⚠️ Redéploiement nécessaire.

## 2026-08-03 — SIRIUS DISPLAY recentré et agrandi
- SiriusDisplay.jsx : géométrie par défaut 440×460 en haut à droite → min(640px, vw-36) × 68 % de la hauteur, centrée verticalement (y = (vh-h)/2, min 56px), toujours côté droit. GEO_KEY bumpé "sirius_display_geo" → "sirius_display_geo_v2" pour réinitialiser les positions sauvegardées des utilisateurs existants. Fenêtre toujours déplaçable/redimensionnable (la géométrie choisie par l'utilisateur reste persistée ensuite).
- TESTÉ : déclenchée par une réponse LLM → 640×544, centerOffset vertical = 0 px.
- ⚠️ Redéploiement nécessaire.

## 2026-08-03 — Fix : fichier collé dans le SIRIUS DISPLAY reste dans le display
- Bug : coller un fichier dans le display l'envoyait en médiathèque (GlobalDrop). Fix : SiriusDisplay a son propre listener paste (capture, stopImmediatePropagation) qui revendique le collage si le display est survolé (:hover) ou contient le focus (displayClaimsPaste exporté) → aperçu DANS le display (image/vidéo/audio/pdf/texte, barre nom + bouton « MÉDIATHÈQUE » manuel + X). GlobalDrop et DropZone ignorent le collage revendiqué. Coller ailleurs → médiathèque comme avant.
- VÉRIFIÉ PAR TESTING_AGENT (iteration_22) : 6/6 flux passés. 3 correctifs post-test appliqués : (1) onPaste appelle onInteract → annule le timer d'auto-fermeture 20 s du display (le collage disparaissait après 21 s) — re-vérifié : toujours visible à 21 s ; (2) revokeObjectURL au démontage (fuite) ; (3) police boutons barre collée 7.5px → 9px.
- ⚠️ Redéploiement nécessaire.

## 2026-08-03 — Module ATLAS# : carte & navigation Google Maps (demande utilisateur)
- Librairie `@vis.gl/react-google-maps@1.9.0` installée via yarn (l'utilisateur avait tapé npm install — yarn utilisé conformément aux règles).
- Nouveau panneau AtlasPanel.jsx + Atlas.css : carte Google Maps stylée holographique cyan/or (HOLO_STYLE), recherche de lieux (réutilise /api/locus/geocode Nominatim), MA POSITION (géolocalisation navigateur, marqueur cyan/or), itinéraires avec tracé polyline (double trait cyan + halo or, fitBounds, marqueurs A/B).
- Backend : POST /api/atlas/route (modules_api.py, modèle AtlasRouteIn) — OSRM overview=full geometries=geojson → distance_km, duration_text, path[{lat,lng}], départ par adresse OU coordonnées GPS (from_lat/from_lng = « ma position »).
- Clé API : sirius_keys.gmaps (localStorage, déjà présente dans SiriusSetup). Sans clé → écran d'instructions FR (Google Cloud Console, facturation requise, quota mensuel gratuit par API, activer Maps JavaScript API). Clé refusée par Google (gm_authFailure) → bannière NON bloquante atlas-authfail-banner + bouton CORRIGER LA CLÉ ; recherche/itinéraires restent utilisables (backend indépendant de Google).
- Commandes vocales : « ouvre atlas / la carte », « montre-moi X sur la carte », « carte de X », « montre-moi Paris » (avec liste d'exclusions photo/musique/module…), « emmène-moi à X » (départ = géolocalisation), « itinéraire de X à Y » (redirigé de LOCUS vers ATLAS ; « localise X » reste sur LOCUS).
- Accès : palette de commandes (loupe) → item command-palette-item-atlas « ATLAS# — carte & navigation ».
- BUG CORRIGÉ AU PASSAGE : 6 lignes dupliquées orphelines en fin d'App.js (return hors fonction) qui cassaient la compilation.
- TESTÉ : iteration_23 (backend 4/4) + iteration_24 (frontend 11/11 après fix boucle clé invalide). 
- ⚠️ Redéploiement nécessaire. L'utilisateur doit fournir sa vraie clé Google Maps (Paramètres du panneau ATLAS ou écran de setup, champ gmaps).

## 2026-08-03 — Fix : glisser-déposer sur le SIRIUS DISPLAY traité sur place
- Bug : glisser un fichier sur le display déclenchait l'overlay global « Déposez vos fichiers » (GlobalDrop) qui l'envoyait en médiathèque. Le collage était déjà géré, pas le drag & drop.
- Fix SiriusDisplay.jsx : logique collage extraite dans showFile(raw, hint) réutilisée par un handler drop natif du display (onDragEnter/Over/Leave/Drop avec stopPropagation) → aperçu direct dans le display + indication visuelle « Déposez ici » (classe sd-dragover, .sd-drophint dans DropZone.css). Bouton MÉDIATHÈQUE manuel conservé.
- Fix GlobalDrop.jsx : (1) onDrop ignore les cibles dans [data-testid='sirius-display'] ; (2) reset de l'overlay en phase capture (drop/dragend) pour éviter un overlay bloqué quand le drop est revendiqué ailleurs ; (3) pendant un drag, body.sirius-dragging neutralise pointer-events des iframes/vidéos du display pour que le drop atterrisse dessus.
- TESTÉ E2E (Playwright, DataTransfer réel) : drop sur display → aperçu sur place, 0 toast médiathèque, 0 overlay bloqué ; drop hors display → médiathèque OK (régression préservée).
- ⚠️ Redéploiement nécessaire.

## 2026-08-03 — Analyse au dépôt : Sirius commente à voix haute les fichiers du display
- Backend : POST /api/display/analyze (server.py) — multipart file + keys JSON, sans stockage : image → vision Groq (qwen, réutilise analyze_upload), PDF → pypdf + LLM, texte/JSON → LLM ; retourne {analyse:{description,texte}, speech} (speech tronqué à 700 car.) ; 413 >12 Mo, 422 types non analysables.
- Frontend SiriusDisplay.jsx : après chaque dépôt/collage (showFile), analyzeFile() lance l'analyse en arrière-plan (garde-fou analysisSeq contre les réponses obsolètes) → encart « ANALYSE SIRIUS » (sd-analysis, spinner puis description ou erreur) sous la barre du fichier + Sirius prononce le commentaire via la nouvelle prop onSpeak (App.js : setStatus/setText/speakOut, SANS passer par speakRef pour ne pas écraser le contenu du display). Barre de progression globale « Analyse du dépôt — fichier » (silencieuse). Types audio/vidéo/autres : analyse ignorée sans erreur.
- BUG CORRIGÉ EN COURS DE ROUTE : prop onSpeak absente de la signature du composant (page blanche « onSpeak is not defined »).
- TESTÉ E2E : drop texte → encart rempli + sous-titre HUD = parole de Sirius + tâche 100 % au journal + 0 médiathèque ; curl image → vision OK ; type audio → 422 propre.
- ⚠️ Redéploiement nécessaire.

## 2026-08-03 — Réseaux sociaux dans le SIRIUS DISPLAY (Facebook / Instagram / WhatsApp Web)
- CONTRAINTE TECHNIQUE VÉRIFIÉE : FB, IG et WhatsApp Web interdisent l'iframe (X-Frame-Options/CSP ; proxy testé → erreurs FB/WA, IG non fonctionnel). Solution : fenêtres dédiées pilotées depuis le display (window.open nommé « sirius-social-{id} », géométrie calée sur le display, session/login complets).
- SiriusDisplay.jsx : barre .sd-social sous la barre de titre avec 3 boutons de marque (SOCIALS const : Facebook #1877f2, Instagram #e1306c, WhatsApp #25d366, icônes lucide) + note « fenêtre dédiée active — recliquez pour basculer ». Re-clic = focus de la fenêtre existante (bascule), sinon ouverture + annonce vocale via onSpeak. testids : sirius-display-social-{facebook|instagram|whatsapp}, sirius-display-social-note.
- App.css : styles .sd-social / .sd-social-btn (couleur de marque via --sc, color-mix, état actif).
- TESTÉ E2E : 3 boutons présents, clic FB → popup facebook.com, bascule IG → popup instagram.com, note + état actif + sous-titre vocal OK.
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — HUD principal : noyau de la présentation + décor or
- Noyau central (App.js ~3448) : ReactorCore rendu avec les paramètres EXACTS de la page de présentation (status="thinking", volume=0.35, color=#22d3ee) — même couleur, même animation nerveuse en continu (le noyau ne module plus selon parle/écoute, choix volontaire « à l'identique »). eco reste piloté par le mode éco utilisateur.
- Cercle or autour du noyau : pseudo-éléments .reactor-wrap::before/::after (App.css) copiés du boot-reactor (conic-gradient or tournant goldRingSpin 7s + anneau pulsant goldRingPulse 3s), épaissis et rapprochés (inset 10 % / 12,5 %, masque 9-11px, drop-shadow renforcé) pour rester visibles par-dessus la scène holographique.
- Décor colonnes + cruche (.antique-bg) : filter grayscale(1) sepia(1) saturate(2.6) hue-rotate(-10deg) contrast(1.55) → cyan totalement remplacé par l'or, contraste accentué ; opacité relevée (0.52, pulse 0.46-0.6) ; mix-blend screen + masque radial conservés (transparence holographique intacte).
- VÉRIFIÉ par captures : décor doré contrasté, anneau or net autour du noyau cyan animé.
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — HUD : décor renforcé, mains/triangle supprimés, bouton RECHERCHER
- Décor colonnes + cruche (.antique-bg) : contraste fortement augmenté (opacity 0.78, pulse 0.7-0.85, brightness 1.16, contrast 1.75, saturate 2.9) — très visible, or, transparence conservée.
- Mains SUPPRIMÉES du projet : HoloScene.jsx réécrit (particules stellaires uniquement — images de mains, éclairs partant des doigts, étincelles et code triangle retirés). Item « Mains holographiques 3D » retiré de moduleItems, import HandIcon retiré. L'état hands3D subsiste (gate de la scène étoiles). Vérifié : .holo-hand = 0 dans le DOM.
- Triangle du noyau SUPPRIMÉ : img .holo-triangle retirée du reactor-wrap (App.js). Vérifié : .holo-triangle = 0.
- Loupe remplacée par un bouton « 🔍 RECHERCHER » (classe .profile-btn.search-labeled, Orbitron 9px, même testid sirius-cmdpalette-btn, ouvre toujours la palette Ctrl+K). Vérifié E2E : texte OK + palette s'ouvre.
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — Thème Or Global sur les panneaux latéraux
- Bloc d'override ajouté en fin d'App.css (« THÈME OR GLOBAL ») : .hud-panel (+::after balayage), .hud-panel-title, .hud-time, .hud-date, .stat-line (svg + valeurs), .float-card (+::after), .fc-head, .fc-weather/.fc-temp — bordures or rgba(245,197,66,…), lueurs et text-shadow or, valeurs en blanc chaud #fff6dd. Clip-path, flottement et balayage lumineux conservés.
- Panneaux concernés : HEURE, CPU/RAM, NOYAU (bottom-right), cartes flottantes MÉTÉO/etc.
- VÉRIFIÉ par capture : HUD entièrement harmonisé or (décor + panneaux + titre), noyau cyan cerclé d'or comme contraste central.
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — Bourse temps réel Alpha Vantage dans ORACLE DIVIN
- Backend (server.py, oracle_overview) : si clé dispo (param ?av_key= envoyé par le front OU ALPHA_VANTAGE_API_KEY du backend/.env — DÉJÀ CONFIGURÉE côté serveur), GLOBAL_QUOTE pour AAPL/MSFT/NVDA/TSLA (AV_SYMBOLS) → name/price/currency $/change%/signal/volatile ; cache 4 h (_stocks_cache) pour respecter les 25 req/jour du plan gratuit ; repli sur l'estimation aléatoire du jour si aucune donnée. Champ stocks_live ajouté à la réponse.
- Frontend : OracleDivin envoie sirius_keys.alphavantage en av_key ; MarketRow affiche la devise (m.currency, $ pour actions, € crypto) ; label « ACTIONS — TEMPS RÉEL (ALPHA VANTAGE) » déjà câblé s'active via stocks_live. SiriusSetup : nouveau champ « Clé Alpha Vantage » (setup-key-alphavantage, lien alphavantage.co/support/#api-key).
- TESTÉ : curl → APPLE 303,42 $ −1,78 % (réel) ; UI ORACLE → section actions temps réel OK, briefing LLM intègre la cotation. NOTE : quota gratuit 25 req/jour → parfois seuls certains symboles remontent (repli propre, cache 4 h).
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — Notifications WhatsApp (CallMeBot) : alertes Alpha Vantage + Telegram supprimé
- Telegram retiré de l'UI (PantheonSystem) et du backend (connectivity).
- Backend : _send_callmebot() + POST /api/notify/whatsapp {phone, apikey, text} (GET api.callmebot.com/whatsapp.php, params encodés httpx). IMPORTANT : erreurs renvoyées en 422/400 (JAMAIS 502/504 — Cloudflare du preview/prod remplace les 5xx par sa page HTML et masque le message). CallMeBot répond 200 même en erreur → détection « error » dans le corps.
- Alertes Alpha Vantage : oracle_overview accepte wa_phone/wa_key ; à chaque rafraîchissement FRAIS des cotations (cache 4 h = anti-spam), les titres à variation ≥ ±2 % déclenchent un message WhatsApp récapitulatif.
- PANTHEON : section « WHATSAPP — ALERTES ALPHA VANTAGE » (toggle + numéro + clé CallMeBot + bouton ENVOYER UN TEST, testids pantheon-wa-num/wa-key/wa-test-btn/wa-test-msg) avec instructions d'activation (bot +34 644 05 92 17, message « I allow callmebot to send me messages »). Config localStorage sirius_notif {whatsapp, waNum, waKey}, lue par OracleDivin.
- TESTÉ : clé bidon → 422 + message français propre ; envoi réel impossible sans clé utilisateur (l'utilisateur doit activer CallMeBot et tester via le bouton).

## 2026-08-04 — Projection 3D des analyses (Analysis3D)
- Nouveau composant Analysis3D.jsx + Analysis3D.css : overlay via createPortal(document.body) (OBLIGATOIRE : le display a un transform → position:fixed serait décalée) ; scène React Three Fiber : plaque de données (texte d'analyse rendu en CanvasTexture, cadre or, double face) + image du fichier si kind=image, anneaux torus or/cyan animés, icosaèdre wireframe cyan, 260 particules or, anneau de scan vertical, socle. Rotation 360° au glisser (HoloRig, inertie lissée + auto-rotation lente), zoom molette (7-24).
- SiriusDisplay : bouton « VUE 3D » (sirius-display-3d-btn) dans l'encart ANALYSE SIRIUS (visible quand analysis.text existe) → ouvre analysis-3d-panel ; fermé par analysis-3d-close-btn et par clearPasted. Logique d'analyse INCHANGÉE (affichage seulement).
- TESTÉ E2E : drop fichier → analyse → VUE 3D → panneau centré, canvas rendu (texte lisible sur la plaque, style or/cyan), rotation par drag vérifiée (dos du panneau visible), fermeture OK.
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — Gardien holographique statique dans le HUD
- Image fournie par l'utilisateur (sage au bâton, hologramme bleu) recadrée/redimensionnée (PIL, crop 300-1160px, h=1100, JPEG q88) → /app/frontend/public/holo/gardien.jpg.
- App.js : <img class="antique-guardian" data-testid="sirius-guardian"> ajouté juste après .antique-bg (ligne ~3122).
- App.css : .antique-guardian — position absolute left 2.5% bottom 4%, height 60vh, mix-blend screen (fond noir → transparent), MÊME filtre or que le décor (grayscale sepia saturate 2.9 hue-rotate -10deg), opacité 0.62, masque radial elliptique pour fondu, AUCUNE animation, pointer-events none, masqué < 900px.
- VÉRIFIÉ par capture : gardien or à gauche, opposé à la cruche (droite), cohérent avec colonnes.
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — Ajustement gardien : premier plan
- .antique-guardian repositionné : top 3% / left 3%, height 82vh, opacité 0.85, brightness 1.18, masque élargi, z-index 2 → tête au niveau de la cruche, effet « avance vers l'utilisateur ». Vérifié par capture.
- ⚠️ Redéploiement nécessaire.

## 2026-08-04 — Halo du gardien
- .guardian-halo (App.js après antique-bg, z-index 1 sous le gardien) : double radial-gradient or + anneau ::after avec box-shadow, mix-blend screen, blur 2px, positionné sous les pieds (top calc(3% + 82vh - 7vh), left 3%, 24vw). Statique. Vérifié par capture.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Vue 3D étendue à ORACLE et HERACLES
- Analysis3D réutilisé tel quel (title/text/imageUrl, createPortal). Boutons « VUE 3D » : OracleDivin (briefing, testid oracle-3d-btn, title « BRIEFING · date ») et HeraclesPanel (rapport OSINT, testid heracles-3d-btn, à côté du bouton PDF, title « OSINT · input », texte = summary + responseText). État show3D dans chaque composant. CSS .oracle-3d-btn / réutilise .her-pdf.
- ⚠️ PIÈGE RÉCURRENT confirmé : éditer un même fichier via plusieurs search_replace enchaînés perd des lignes et duplique la fin du fichier (« Unexpected token » + « show3D is not defined »). Corrigé en réappliquant les états perdus et en supprimant les fins dupliquées. TOUJOURS grep + tail après édition.
- TESTÉ E2E : oracle-3d-btn → panneau 3D canvas rendu (briefing lisible) ; heracles-3d-btn → panneau 3D (résumé OSINT lisible). Fermeture OK.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Module HÉPHAÏSTOS (auto-maintenance RÉEL)
- IMPORTANT (dit à l'utilisateur) : une app web ne peut PAS réécrire son propre code / npm install / se recompiler en autonomie (risque sécurité). HÉPHAÏSTOS fait donc du DIAGNOSTIC RÉEL, pas de la modif de code auto.
- Backend GET /api/hephaistos/diagnostic : 3 groupes RÉELS — (1) endpoints internes via localhost:8001 (ORACLE/ATLAS/HERACLES/PANTHEON/FICHIERS/NOTIFY/PUSH, <500=OK), (2) services système (uvicorn/mongod/node via psutil, CPU/RAM, ping Mongo db.command('ping')), (3) intégrations externes (Groq avec Bearer, Alpha Vantage, Nominatim, OSRM, CallMeBot, Open-Meteo). Retourne summary {total,passed,failed,rate,state OK/DÉGRADÉ/CRITIQUE,duration_ms,failed_modules} + speech. log_service HÉPHAÏSTOS.
- Frontend HephaistosPanel.jsx + Hephaistos.css : bouton « LANCER LE DIAGNOSTIC COMPLET », barre de progression + phases animées, jauge de taux %, état coloré, liste par groupe (code/latence/detail + badge OK/FAIL), bouton « RAPPORT JSON » → download auto-maintenance-report.json, annonce vocale via onSpeak. testids : hephaistos-panel/run-btn/progress/summary/rate/download-btn/group-{key}/item-{name}/close-btn.
- App.js : import Hammer + HephaistosPanel, état showHephaistos, panelStates, item palette command-palette-item-hephaistos, commande vocale (/héphaïstos|auto-maintenance|diagnostic complet|forge/), rendu (onSpeak = setStatus/setText/speakOut).
- TESTÉ E2E : diagnostic 19/19 = 100%, 3 groupes 57 lignes... (en réalité 19 items, doublon de sélecteur), rapport JSON téléchargé, vocal OK.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Personnage holographique HÉPHAÏSTOS
- Image générée (Nano Banana) : forgeron divin doré au marteau, style HUD hologramme identique aux autres personnages Mythos → /app/backend/static/mythos/hephaistos.jpg (377 Ko).
- MYTHOS_CHARACTERS (modules_api.py) : entrée « HÉPHAÏSTOS# » (character/role/details/voiceIntro/style doré opacity 0.5, column + jug {enabled:True}). Le HephaistosPanel avait déjà <MythosBackdrop module="HÉPHAÏSTOS#" /> → tout est automatique.
- NOTE : les images /api/mythos/img/* ne chargent PAS sur localhost:3000 (fallback HTML du dev server) mais fonctionnent via l'URL preview/production — toujours tester les visuels Mythos sur l'URL preview.
- VÉRIFIÉ sur URL preview : silhouette dorée affichée (naturalWidth 848), colonne + nom en bas.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Diagnostic auto au démarrage + Historique des diagnostics
- Backend : hephaistos_diagnostic accepte ?source=auto|manuel et persiste chaque run dans Mongo db.diagnostics {at, source, rate, passed, failed, total, state, failed_modules, duration_ms}. Nouveau GET /api/hephaistos/history?limit=40 (tri chronologique asc, _id exclu).
- App.js (~ligne 901) : useEffect après boot/setup — 1×/session (sessionStorage sirius_autodiag), délai 12 s, fetch diagnostic?source=auto ; SI failed > 0 → alerte vocale « Alerte Héphaïstos… modules en échec : … » via speakRef.current ; silencieux si 100 %.
- HephaistosPanel : section « HISTORIQUE — ÉVOLUTION DE LA SANTÉ SYSTÈME » (testid hephaistos-history) : courbe SVG des taux (ligne or, points verts/ambre/rouges selon 100/70 %, échelle 0-50-100) + 8 dernières lignes (date, badge AUTO/MANUEL, taux, modules KO). Chargé à l'ouverture, rafraîchi après chaque run manuel.
- TESTÉ : curl → persistance + history OK ; E2E → historique affiché (1 entrée AUTO 100 %), appel auto capturé 12 s après boot. Alerte FAIL non testable sans vraie panne (logique triviale failed>0).
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Purge historique + rééquilibrage composition HUD
- Purge : DELETE /api/hephaistos/history?keep=N (keep=0 → tout, keep>0 → conserve les N récents via curseur date). Boutons « PURGER LES ANCIENS » (keep=10) et « TOUT EFFACER » (danger, rouge) dans l'en-tête historique + annonce vocale du nombre supprimé. TESTÉ E2E : purge totale → section historique disparaît.
- Composition HUD : .reactor-wrap 46vh/420px → 38vh/340px ; .antique-guardian 82vh/top3%/left3% → 68vh/top14%/left7% (plus en avant, réduit) ; .guardian-halo recalé (left7%, top calc(14%+68vh-6vh), 20vw). Vérifié par capture : ensemble proportionné.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Gardien parlant
- App.js : classes conditionnelles `speaking` sur .antique-guardian et .guardian-halo quand status === "speaking". App.css : guardianHaloPulse (opacité/scale 1.07) + guardianGlowPulse (brightness 1.32 + drop-shadow or) 1.6s infinite. TESTÉ E2E : classe active pendant la lecture vocale du briefing, lueur visible.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Fix : HÉPHAÏSTOS absent de la séquence WAHOU
- Cause : la cascade d'allumage de WahouSequence.jsx utilise une liste MODULES codée en dur (la galerie Mythos, elle, est dynamique via /api/mythos/characters). HÉPHAÏSTOS n'y était pas.
- Fix : entrée { key: "hephaistos", label: "HÉPHAÏSTOS#", color: "#f5c542" } ajoutée entre HERACLES# et SIRIUS CORTEX#. NOTE POUR PLUS TARD : tout nouveau module Mythos doit aussi être ajouté à cette liste.
- TESTÉ E2E : wahou-mod-hephaistos visible « HÉPHAÏSTOS# OK » en or dans la cascade.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — WAHOU supprimé + Panthéon des modules sur la page de présentation
- WAHOU SUPPRIMÉ COMPLÈTEMENT : WahouSequence.jsx et Wahou.css effacés ; App.js nettoyé (import, état showWahou, auto-lancement session, commande vocale « active sirius/lance la séquence », item palette wahou, rendu). L'endpoint backend /wahou/activate existe encore (inutilisé, sans danger). PIÈGE ÉVITÉ : durant le nettoyage, doublons créés (import GlobalDrop, item et rendu MythosGallery) — dédoublonnés ; toujours grep après remplacement.
- BootScreen : bloc .boot-modules (data-testid boot-modules) à droite du noyau — titre « Panthéon des Modules » + 9 modules (ARGUS/ATLAS/ORACLE/HERACLES/HÉPHAÏSTOS/KERAUNOS/LOCUS/PANTHÉON/CORTEX) avec rôle, typographie antique .font-divine (Cinzel), apparition en cascade (bootModIn, délais 0.28s), bordure gauche or, masqué < 980px. Tout le reste de la page conservé.
- TESTÉ E2E : boot-modules visible pendant le boot (capture), HUD fonctionne après le boot, 0 référence wahou restante.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Modules Boot cliquables + Setup doré + Trafic ATLAS
- BootScreen cliquable : logique onOpenModule déjà câblée (App.js ~3145) mais BLOQUÉE par `pointer-events: none` sur .boot-modules — fix CSS : pointer-events auto + cursor pointer + hover or sur .boot-module. Clic → ferme le boot et ouvre directement le module.
- Setup doré : toutes les classes .setup-* migrées cyan→or dans App.css (carte, titre, en-têtes de sections/séparateurs, labels #e0cd8f, bordures inputs, focus, submit dégradé or, io-btn, voice-test, dict, range/checkbox accent-color). setup-saved reste cyan (accent).
- Trafic ATLAS : composant TrafficOverlay (google.maps.TrafficLayer) dans AtlasPanel.jsx + état traffic (ON par défaut) + bouton toggle TrafficCone dans la barre (testid atlas-traffic-btn, classe .active or dans Atlas.css).
- TESTÉ E2E : clic module HÉPHAÏSTOS/ATLAS depuis le boot → panneau ouvert ; setup doré vérifié par capture ; bouton trafic présent et togglable (couche visible avec vraie clé Google).
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Météo sur la carte ATLAS
- AtlasPanel.jsx : useEffect sur marker/route → fetch Open-Meteo (gratuit, sans clé) au point recherché (ou destination d'itinéraire) ; mapping codes WMO → icônes lucide + libellés FR (wmoInfo).
- Carte holographique or .atlas-weather (testid atlas-weather) en haut à droite de la carte : icône + temp, description, ville, vent + humidité. PIÈGE : `.atlas-map > div {height:100%}` étirait la carte → override `.atlas-map > .atlas-weather {width/height:auto}`.
- TESTÉ E2E : recherche « Lyon » → carte 34° Partiellement nuageux, vent/humidité, compacte (159×125).
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Prévisions 3 jours ATLAS + Gardien à l'écoute (cyan)
- Prévisions : fetch Open-Meteo étendu (&daily=weather_code,temperature_2m_max/min&forecast_days=4&timezone=auto) ; 3 lignes (jours 1-3) sous les stats : jour FR abrégé, icône WMO, max or/min cyan (testid atlas-weather-days). CSS .atlas-weather-days/.atlas-weather-day/.awd-* dans Atlas.css.
- Gardien à l'écoute : classes `listening` sur .antique-guardian et .guardian-halo quand status === "listening" (App.js ~3129). Animations guardianCyanShimmer (hue-rotate 128deg vers cyan + drop-shadow cyan, 1.3s) et guardianHaloCyan.
- TESTÉ E2E : Lyon → Jeu./Ven./Sam. avec temp max/min ; effet cyan vérifié en forçant la classe et en figeant l'animation à mi-course (capture spectaculaire).
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — PROMO# : storyboard vidéo promo (10 plans, réseaux sociaux)
- 10 clichés 9:16 générés (Gemini image) style or/cyan antique → /app/backend/static/promo/shot1-10.jpg + sirius-promo-pack.zip.
- Backend modules_api.py : PROMO_SHOTS (id, title, timecode, scene, ambiance, visuels, message, voix, image) + GET /api/promo/shots, /api/promo/img/{name}, /api/promo/download.
- Frontend PromoPanel.jsx + Promo.css : galerie 10 plans (image zoomable, n°, timecode, sections SCÈNE/AMBIANCE/VISUELS/MESSAGE/VOIX OFF), boutons COPIER LE SCRIPT COMPLET / COPIER LA LÉGENDE RÉSEAUX (avec hashtags) / COPIER CE PLAN / ZIP. Copie avec fallback execCommand.
- App.js : import PromoPanel, état showPromo, entrée TOUCH_RING "PROMO#", item palette (Icon Radio), commande vocale /(storyboard|vidéo promo|ouvre la promo)/, rendu.
- PIÈGE 1 : `.prime-screen` a `animation: zeusIn both` → containing block : le lightbox `fixed` scrollait avec le contenu. Fix : createPortal(document.body). (Le lightbox TRAILER# a le même bug latent.)
- PIÈGE 2 : édits parallèles multiples sur le MÊME fichier (PromoPanel.jsx/App.js) → certains search_replace « réussis » perdus (imports manquants). TOUJOURS éditer un même fichier séquentiellement.
- TESTÉ E2E : commande « storyboard » → panneau 10 plans, copie script OK (« SCRIPT COPIÉ ! »), copie plan OK, lightbox plein écran OK, ZIP 200 (9 Mo).
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Question vocale sur fichier + Diaporama promo + Titre or 3D + Onde cyan/or
- QUESTION FICHIER : sirius_brain.display_ask() (Groq, réponse parlée contextuelle) + POST /api/display/ask {question, context, keys}. SiriusDisplay publie window.__siriusDisplayFile {name, kind, analysis, text} (posé au showFile, enrichi après analyse, effacé à l'unmount). App.js : détection /(fichier|document|que vois|de quoi parle|résume...)/ dans le gestionnaire de commandes → fetch display/ask → réponse parlée. TESTÉ curl + E2E (« de quoi parle ce document ? » → réponse contextuelle correcte).
- DIAPORAMA PROMO : bouton « LECTURE DU FILM — VOIX SIRIUS » (promo-play-btn) dans PromoPanel → portal plein écran .promo-show (Ken Burns 15s, plan+voix off+points de progression, sortie clic/X/Échap). speakCinematic lit chaque voix off, avance à onend (sécurité 15s). TESTÉ E2E : ouverture, avance auto (plan 1→4), fermeture.
- TITRE ΣIRIUS OR 3D : généré depuis l'affiche fournie par l'utilisateur (Gemini edit, fond noir pur), détourage par dé-mélange depuis le noir (alpha=max(RGB), numpy) → /app/frontend/public/holo/sirius-title.png (1161×335). h1.sirius-title contient désormais <img .sirius-title-img> (height clamp 64px-150px, goldPulse du parent conservé). PIÈGE : le mode « transparent » du tool image renvoie en réalité un JPEG fond blanc → toujours demander fond noir pur et dé-mélanger.
- ONDE VOCALE CYAN/OR : Waveform réécrite — spectre pointu (pics verticaux symétriques cyan), onde fluide dorée en surimpression (dégradé cyan↔or animé), ligne d'horizon lumineuse, particules dorées/cyan émises quand Sirius parle (ou micro fort), particlesRef (cap 110). PIÈGE : particlesRef oublié initialement → ReferenceError plein écran.
- RAPPEL PIÈGE : ne jamais lancer plusieurs search_replace en parallèle sur le MÊME fichier (édits perdus silencieusement).
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Export vidéo MP4 + nappe orchestrale du diaporama
- EXPORT VIDÉO : POST /api/promo/export (tâche fond, force=true pour re-rendre), GET /api/promo/export/status {state,progress,step,ready}, GET /api/promo/export/video (MP4). Pipeline modules_api.py : edge-tts (fr-FR-HenriNeural, rate -5%) par plan → ffmpeg zoompan 1080x1920@25fps par segment (durée = voix + 1,6 s) → concat → mixage musique static/promo/music.mp3 (volume 0.20, fades) via amix+alimiter. Rendu ~45 s, MP4 final 67 s / 12,4 Mo, h264+aac. Vérifié : frames + volumedetect + téléchargement 200 externe.
- MUSIQUE DIAPORAMA : /audio/ambiance.mp3 (musique épique fournie par l'utilisateur, copiée aussi en backend static/promo/music.mp3) jouée en boucle volume 0.22 pendant .promo-show, coupée à la sortie/unmount (musicRef).
- UI PromoPanel : bouton EXPORTER LA VIDÉO MP4 → progression % + étape (poll 2,5 s) → TÉLÉCHARGER LA VIDÉO (MP4) + RÉGÉNÉRER. Statut vérifié au montage (vidéo déjà prête → bouton direct).
- DÉPENDANCES : pip edge-tts (requirements.txt à jour) ; ffmpeg installé via apt — ⚠️ EN DÉPLOIEMENT vérifier la présence de ffmpeg (sinon l'export renverra une erreur propre dans status.error).
- PIÈGE : useRef manquant dans l'import React de PromoPanel → écran d'erreur ; toujours vérifier les hooks importés après ajout.
- TESTÉ : rendu complet backend OK ; E2E frontend : boutons télécharger/régénérer visibles, diaporama + musique OK.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Sous-titres vidéo + météo vocale ATLAS + titre étiré + adresse directe
- SOUS-TITRES : drawtext ffmpeg par segment (textfile sub{i}.txt, textwrap 32 car., LiberationSerif-Bold, fontcolor 0xF5C542, borderw 3 noir, y=h-500, fade-in alpha t/0.6). Vidéo re-rendue (force) — frame vérifiée : sous-titres dorés lisibles.
- MÉTÉO VOCALE ATLAS : l'annonce de géocodage a été déplacée dans l'effet météo — Sirius annonce « {ville} affiché sur la carte. Météo actuelle : X degrés, ciel..., vent... Prévisions : jeudi X, vendredi Y, samedi Z degrés. » (announcedRef anti-doublon, fallback simple si Open-Meteo échoue, uniquement pour recherches marker, pas les itinéraires).
- TITRE COMPRESSÉ : cause = preflight Tailwind `img{max-width:100%}` + height fixe → distorsion dans .reactor-wrap (340px). Fix : max-width:none sur .sirius-title-img. Ratio affiché mesuré = ratio naturel (3.4655).
- ADRESSE DIRECTE (« tu »/« vous », jamais « il ») : règle stricte ajoutée dans BASE_PROMPT (sirius_brain.py) — vouvoiement/tutoiement obligatoire dans reponse, 3e personne interdite (exception champ memoire) ; lignes profil reformulées (« L'utilisateur s'appelle... ») ; display_ask aussi corrigé. VÉRIFIÉ curl : réponse en « vous ».
- ⚠️ Redéploiement nécessaire (l'app est déployée en production : sirius-hud-redesign.emergent.host — les changements preview n'y sont pas tant que l'utilisateur ne redéploie pas).

## 2026-08-05 — « Affiche les modules » → Galerie MYTHOS (personnages)
- App.js (~2579) : la commande « affiche/montre/ouvre/liste/présente (les/mes) modules » (plur., fin de phrase, variantes « holographiques / du panthéon / de sirius ») ouvre désormais la Galerie MYTHOS (personnages holographiques) + annonce vocale, au lieu de partir au LLM qui affichait des technologies (React/Python). Regex ancrée en fin pour ne pas capter « ouvre le module atlas/haccp/promo » (gérés plus tôt).
- TESTÉ E2E : « affiche les modules » → galerie 7 personnages affichée.

## 2026-08-05 — Carton final vidéo + questions suivies fichier + musique grégorienne
- CARTON FINAL : endcard.jpg (PIL 1080x1920, emblème doré Σ fourni par l'utilisateur centré) + segment ffmpeg 5 s (fade-in, drawtext « Forgé par Daniel Partel » or, apparition différée) ajouté avant concat dans _render_promo_video. Vidéo re-rendue : 72 s, frame finale vérifiée.
- QUESTIONS SUIVIES FICHIER : display_ask accepte history (8 derniers messages user/assistant) ; POST /api/display/ask {history} ; App.js conserve window.__siriusDisplayChat (cap 12, reset au nouveau fichier dans SiriusDisplay.showFile) et route aussi les relances (« et… », « combien… », « comment… ») quand une conversation fichier est active. VÉRIFIÉ curl : « Et combien de temps de cuisson ? » → réponse contextuelle.
- MUSIQUE GRÉGORIENNE : /app/frontend/public/audio/gregorien.mp3 (87 s, fournie par l'utilisateur). SiriusSetup : sélecteur « Musique d'ambiance du HUD » (epique/gregorien/none → localStorage sirius_ambient_track, testid setup-ambient-track). App.js : l'effet ambiance lit le choix (none → silence). TESTÉ E2E : sélection grégorien + save → window.__siriusAmbient.src = /audio/gregorien.mp3.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Personnages ATLAS (Atlas) et SIRIUS DISPLAY (Iris) dans la galerie
- 2 images générées style cartes mythologiques (848x1264) → static/mythos/atlas.jpg (Titan émeraude portant le globe doré, ΑΤΛΑΣ) et iris.jpg (déesse ailée cyan aux visions, ΙΡΙΣ).
- MYTHOS_CHARACTERS (modules_api.py) : entrées ATLAS# (« Cartes, trafic & météo ») et SIRIUS DISPLAY# (« Vision & affichage ») avec details/voiceIntro/style. PIÈGE ÉVITÉ : un search_replace avait supprimé l'entrée HÉPHAÏSTOS (ancre sur fin de liste) — restaurée aussitôt ; vérifier la liste complète après tout ajout en fin de tableau.
- Sous-titre galerie « LES SIX IDENTITÉS » → « LES IDENTITÉS » (compte neutre).
- TESTÉ E2E : « affiche les modules » → 9 personnages dont Atlas et Iris.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Voix par personnage + commande vocale d'ambiance
- VOIX PERSONNAGES : voice.js → speakAsCharacter(message, {pitch, rate}) (browser pitch 0.4-1.8 ; Google TTS semitones ≈ (pitch-0.9)*13). MythosGallery : CHAR_VOICES par module (Zeus 0.55 très grave, Atlas 0.5 titanesque, Iris 1.42 aérienne, Pythie 1.3 lente, Hermès 1.15 vif, etc.) ; l'intro est parlée automatiquement à l'ouverture de chaque fiche (cancelSpeech + délai 300 ms, stop à l'unmount) ; bouton ENTENDRE utilise le même timbre.
- COMMANDE AMBIANCE : App.js (~2350, avant openMusic) — « mets le chant grégorien / la musique épique / ambiance normale » → localStorage sirius_ambient_track + swap direct de l'audio en cours (ambientRef + window.__siriusAmbient) + confirmation vocale.
- TESTÉ E2E : grégorien → gregorien.mp3, épique → ambiance.mp3 ; fiches Atlas/Iris s'ouvrent et parlent sans erreur.
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Volume d'ambiance à la voix
- App.js (bloc 0ambiance-quater, après le choix de piste) : « baisse/monte la musique » (±8/12 pts), « musique à N % / N pour cent », « à fond » → ambientRef.volume + localStorage sirius_ambient_volume (persisté ; lu par l'effet ambiance ET le swap de piste). Confirmation vocale « Volume de l'ambiance réglé à N pour cent ».
- TESTÉ E2E : 0.12 → baisse 0.04 → monte 0.16 → « 50 pour cent » 0.5 (localStorage 0.5).
- ⚠️ Redéploiement nécessaire.

## 2026-08-05 — Audit complet des modules (iteration_25) + corrections
- AUDIT : diagnostic Héphaïstos 19/19 OK + testing_agent complet (backend 6/6, frontend 8/8) → 100 % fonctionnel, aucun bug bloquant.
- CORRIGÉ 1 : WS_URL était codé en dur ws://localhost:8765 → bruit console en preview/prod. Fix : REACT_APP_WS_URL sinon ws://localhost:8765 UNIQUEMENT si hostname localhost/127.0.0.1, sinon null → mode démo direct sans tentative (effet WS sort tôt). Console vérifiée : 0 erreur, 0 tentative 8765.
- CORRIGÉ 2 : 2 catch {} vides dans PromoPanel.jsx (lint no-empty) → commentés.
- Restant non bloquant : apostrophes non échappées dans du texte JSX (react/no-unescaped-entities, warnings CRA seulement).

## 2026-08-05 — Publicité 15 plans (texte investisseur intégré)
- Le texte publicitaire complet fourni par l'utilisateur (« SIRIUS n'est pas un assistant… accessible à tous ») est réparti sur 15 plans rythmés. PROMO_SHOTS déplacé dans /app/backend/promo_shots.py (importé par modules_api.py).
- 5 nouveaux clichés générés : shot11 cerveau-analyse, shot12 chaos des outils (plan volontairement terne/froid pour le contraste), shot13 convergence Σ, shot14 vitesse/comète, shot15 escalier de croissance/investissement. Zip 15 images reconstruit.
- Ordre final : noyau→temple→cerveau→oracle→chaos→convergence→panthéon→voix→atlas→gardien→forge→vision→vitesse→invest→titre + carton « Forgé par Daniel Partel ». Vidéo re-rendue : 2 min 29, sync image/voix/sous-titres vérifiée sur 3 frames.
- BUG CORRIGÉ : le rendu utilisait shot{i}.jpg par INDEX au lieu du champ image du plan → désynchronisation image/voix. Fix : Path(s["image"]).name.
- PromoPanel : CAPTION réécrite (positionnement plateforme d'intelligence opérationnelle), sous-titre et bouton ZIP dynamiques ({n} PLANS / {n} CLICHÉS).
- ⚠️ ffmpeg avait DISPARU après un redémarrage du conteneur (installé via apt, non persistant) → réinstallé. EN DÉPLOIEMENT : l'export vidéo nécessite ffmpeg dans l'image de prod, sinon status.error explicite.
- ⚠️ Redéploiement nécessaire. NOTE : tâche « voix des modules (Atlas/Iris) » démarrée puis interrompue par cette demande — toujours À FAIRE.


## THÉMIS — PDF & Comptabilité (août 2026, cette session)
- **Correctifs itération 26/27 tous appliqués et testés** (backend 19/19, frontend validé) :
  - Lignes de documents typées Pydantic (`Line`, qty ge=0) → qty invalide = 422 (plus de 500)
  - `ClientIn.name` field_validator (nom vide/espaces → 422), `PaymentIn.amount` validator avec message FRANÇAIS « Le montant du paiement doit être supérieur à zéro. »
  - Paiement rattachable uniquement à une facture existante ; suppression d'un paiement → recalcul paid/status de la facture
  - Galerie MYTHOS : bug `setShowDisplay` (no-undef, App.js:3431) → corrigé en `setDisplayOpen` ; ouverture THÉMIS depuis la galerie vérifiée par screenshot
  - Input date natif remplacé par champ texte stylisé « Échéance — JJ/MM/AAAA » (conversion frToIso), data-testid partout, ESLint corrigé
  - `ThemisPanel.post()` vérifie response.ok → bandeau d'erreur rouge `themis-error` (message FR, fermable, formulaire conservé) ; `load()` vérifie r.ok
- **NOUVEAU : gestion PDF & comptabilité** (demande utilisateur) :
  - `/app/backend/themis_pdf.py` : `build_doc_pdf` (reportlab, A4, 3 modèles antique/moderne/minimal, en-tête émetteur, tableau lignes, totaux HT/TVA/TTC, déjà réglé/reste à payer) + `extract_piece` (PyMuPDF texte → si <60 car. rendu page PNG → Groq vision qwen/qwen3.6-27b OCR ; sinon GROQ_MODEL json_object) — extraction fournisseur/numéro/date/HT/TVA/TTC
  - Endpoints : `GET /api/themis/docs/{id}/pdf?emetteur=` ; `POST /api/themis/pieces/upload` (multipart file+groq_key, PDF/PNG/JPG/WEBP, 15 Mo max, archivage disque `/app/backend/themis_files/`, extraction IA avec note d'échec gracieuse) ; `GET/PUT/DELETE /pieces`, `GET /pieces/{id}/file` ; `GET /api/themis/bilan` (encaisse, à encaisser, échéances triées par jours restants, pièces à payer, champ `speech` FR)
  - Frontend : onglet « PIÈCES & PDF » (drop zone `themis-drop-zone`, table pièces, statut à_payer/payé, voir/supprimer), bouton PDF `themis-pdf-{number}` sur chaque doc, tableau de bord avec RAPPELS D'ÉCHÉANCES (badges DANS X J / RETARD X J) + alerte pièces fournisseur
  - Commande vocale « bilan financier » / « rappels d'échéances » (App.js ~2606) → Sirius lit le `speech` du bilan
  - PyMuPDF installé (requirements.txt régénéré). Clé Groq utilisateur lue depuis localStorage `sirius_keys.groq` et envoyée en Form à l'upload.
- Rapports : `/app/test_reports/iteration_27.json` (backend 100 %, frontend 12/14 puis 2 derniers défauts corrigés et vérifiés par curl + screenshot)

## THÉMIS v3 — E-mail SMTP, courbe, export, logos (août 2026, cette session)
- **Envoi PDF par e-mail (SMTP personnel BYOK, choix utilisateur)** : `SmtpConf/EmailIn` + `_send_smtp` (smtplib, STARTTLS ou SSL si port 465) dans themis_api.py ; `POST /api/themis/docs/{id}/email` joint le PDF généré, passe le doc brouillon→envoyé ; erreurs en FRANÇAIS et en HTTP 400 (⚠️ JAMAIS 502 : Cloudflare remplace les 502 par sa page HTML). Frontend : bouton enveloppe par document → modale via createPortal(document.body) (le fixed était cassé par l'ancêtre transformé), destinataire/objet/message pré-remplis, erreur affichée DANS la modale (`themis-email-error`), champs SMTP dans l'onglet CLÉS API (byok.smtp_host/port/user/pass/from/name, localStorage themis_keys).
- **Courbe mensuelle or/cyan** : `stats.monthly` (12 mois, in=paiements, out=pièces fournisseurs par date) + composant SVG `MonthlyChart` (masqué si tout à zéro), tableau de bord.
- **Export comptable ZIP** : `GET /api/themis/export` → clients/documents/commandes/paiements/pieces/ecritures.csv (`;` + BOM Excel, écritures débit/crédit triées par date) + fichiers des pièces dans pieces/. Bouton `themis-export-btn` au tableau de bord.
- **Logos distincts** (demande utilisateur : THÉMIS/PANTHÉON/MYTHOS partageaient l'icône Landmark) : 3 emblèmes générés (balance dorée, temple grec, couronne de laurier + constellation) → `/holo/logo-{themis,pantheon,mythos}.png` (damier retiré par seuillage de luminance → PNG alpha). Utilisés dans les en-têtes des 3 panneaux (classe .th-logo) et dans moduleItems d'App.js (composants ThemisLogo/PantheonLogo/MythosLogo ~ligne 58).
- Tests : itération 28 (backend 24/24, frontend 96 % → dernier défaut bandeau d'erreur/portail corrigé et vérifié par hit-test screenshot).
- ⚠️ Les images `/api/mythos/img/*.jpg` ne chargent pas sur localhost:3000 (pas de routage /api local) mais fonctionnent sur l'URL publique — artefact de test uniquement.
- Backlog THÉMIS restant (P2) : export ZIP en thread/streaming, assainir filename dans le ZIP, envoi réel SMTP à valider par l'utilisateur avec son propre serveur.

## Historique envois + Relance client + Correctif voix (août 2026, cette session)
- **Historique des envois** : succès d'envoi → `$push` dans `themis_docs.emails` [{to, subject, type envoi|relance, date}] ; affiché sous le numéro de chaque document (`themis-mails-{number}`, tooltip = liste complète), brouillon→envoyé automatique. Testé e2e avec un serveur SMTP local aiosmtpd (localhost:1025) : envoi ok + historique enregistré.
- **Relance client** : bouton cloche rouge (`themis-relance-{number}`) sur les factures en retard (due_date < aujourd'hui, non payé/refusé) dans la table des docs ET dans les rappels d'échéances du tableau de bord ; ouvre la modale e-mail avec un message de relance poli pré-rédigé (montant restant, date d'échéance dépassée), `mail_type: relance`. `_send_smtp` tolère STARTTLS non supporté (serveurs locaux).
- **CORRECTIF VOIX (demande utilisateur : écho/dédoublement des présentations de modules)** — 2 causes racines corrigées :
  1. `voice.js` : `speakGoogle` ne stoppait JAMAIS l'audio précédent et les 2 canaux (audio Google + speechSynthesis) pouvaient parler ensemble → ajout `stopChannels()` (coupe les 2 canaux avant toute prise de parole) + jeton de génération `speakSeq` (une voix Google encore en chargement se tait si une voix plus récente a parlé ; le repli navigateur est aussi conditionné au jeton ; `cancelSpeech` invalide les chargements en cours).
  2. `index.js` : **React.StrictMode RETIRÉ** — il double-exécutait les effets en dev → boot parlé 2×, tâches ARGUS annoncées 2× (« Je lance la tâche… » ×2). + garde `window.__siriusBootSpoken` sur la présentation du boot (App.js ~4240).
  - Vérifié par instrumentation Playwright (stub speechSynthesis.speak) : boot=1, THÉMIS=1, ARGUS (intro+tâches)=0 doublon, PANTHÉON=1. NE PAS remettre StrictMode.

## Migration LLM : Groq → Kimi K3 / Moonshot (août 2026, cette session)
- Directive utilisateur : plus AUCUN usage de Groq (endpoint, SDK, modèles). Clé env renommée `DANIEL_DEV_K3`.
- Backend : SDK `openai` (`AsyncOpenAI(base_url=K3_ENDPOINT, max_retries=0, timeout=90)`), `k3_client(key)` centralisé dans `sirius_brain.py`. Constantes : `ENV_K3_KEY` (env `DANIEL_DEV_K3`), `K3_MODEL` (env `K3_MODEL`, défaut `kimi-k3`), `K3_ENDPOINT` (défaut `https://api.moonshot.cn/v1`). Fichiers migrés : sirius_brain.py, modules_api.py, themis_pdf.py (vision = kimi-k3, plus de qwen), themis_api.py (champ upload `k3_key`), server.py (health check → api.moonshot.cn/v1/models, service « Kimi K3 / Moonshot »). `.env` : GROQ_API_KEY et GROQ_MODEL SUPPRIMÉS ; `DANIEL_DEV_K3=` (vide — l'utilisateur doit coller sa clé), K3_MODEL, K3_ENDPOINT ajoutés. Lib `groq` plus importée nulle part.
- COMPAT (volontaire, ne pas « nettoyer ») : le backend accepte `keys.k3` OU `keys.groq` dans les requêtes ; la clé côté navigateur reste stockée sous `sirius_keys.groq` (évite de perdre la clé déjà saisie) ; le champ de réponse `/api/chat/status` reste `groq_env`. Ce sont des noms de plomberie interne — aucun appel Groq.
- UI : indicateur HUD « KIMI K3 », statut « IA CLOUD · KIMI K3 », setup « Clé Kimi K3 (Moonshot) » avec lien platform.moonshot.cn/console/api-keys, libellés Architect/Panthéon/Thémis mis à jour.
- Testé : imports Python ok, /api/chat sans clé → repli français propre ; clé invalide → l'appel atteint api.moonshot.cn (~5 s) puis repli propre. VALIDÉ ensuite AVEC LA VRAIE CLÉ (collée dans backend/.env `DANIEL_DEV_K3=sk-...`) : chat ok (~12 s, modèle raisonneur), OCR image ok (fournisseur/date/HT/TVA/TTC exacts), extraction PDF texte json_object ok.
- ⚠️ PIÈGES kimi-k3 : (1) n'accepte QUE `temperature=1` → le paramètre temperature a été RETIRÉ de tous les appels (400 sinon) ; (2) le modèle se présentait comme « Kimi » → verrou d'identité ajouté au BASE_PROMPT (« tu es SIRIUS, ne mentionne jamais Kimi/Moonshot ») ; (3) modèle raisonneur → latence ~10-15 s par réponse.

## Architecture hybride Kimi K3 + Groq (août 2026, cette session)
- Directive utilisateur : Kimi K3 = analyse/raisonnement/extraction (interne, jamais montré) ; Groq = formulation finale rapide, sèche, technique. Jamais l'inverse.
- Implémentation (`sirius_brain.py`) : `generate_answer` → (1) `_k3_answer` (Kimi, JSON structuré : analyse + mémoires + pop-ups) → (2) `_groq_finalize(question, analyse)` (Groq via AsyncOpenAI base_url api.groq.com/openai/v1, FINALIZE_PROMPT : 2-4 phrases, identité SIRIUS, interdiction de citer les modèles). Mémoires/pop-ups viennent de Kimi ; la réponse parlée vient de Groq.
- Replis : Groq indisponible/clé absente → réponse Kimi directe ; modèle Groq décommissionné → repli auto `llama-3.3-70b-versatile`.
- .env : `KIMI_KEY` (alias accepté de DANIEL_DEV_K3, les deux présents), `GROQ_KEY` (clé Groq restaurée), `GROQ_LLM_MODEL=llama-3.3-70b-versatile` (⚠️ `llama-3.1-70b-versatile` demandé initialement est DÉCOMMISSIONNÉ chez Groq → 400 model_decommissioned).
- Testé avec les 2 vraies clés : réponse finale formulée par Groq (~0,6 s) après analyse Kimi (~10-12 s, incompressible : modèle raisonneur), identité SIRIUS conservée, 0 erreur 400.

## Hybride v2 ultra-optimisé (août 2026, cette session)
- Directive : vitesse maximale + profondeur maximale, réponses finales 3 phrases max, contexte limité.
- Optimisations mesurées (`sirius_brain.py`) :
  1. `extra_body={"reasoning_effort": "low"}` sur kimi-k3 → raisonnement quasi nul (34-55 car. au lieu de 1200+). ⚠️ Débit kimi-k3 ≈ 27 tokens/s = plancher physique ; ⚠️ max_tokens couvre reasoning+content : à 300, content revenait VIDE.
  2. Contexte limité : 6 derniers messages tronqués à 350 car. ; CONTRAINTE VITESSE injectée (analyse 80 mots, 150 si recherche ; memoires/popups vides par défaut).
  3. FINALIZE_PROMPT : 3 phrases MAXIMUM, max_tokens 220.
  4. Recherche web : Kimi ne rédige PLUS le pop-up (il analysait 1350 tokens → 42-50 s). Désormais `_groq_popup` (Groq, POPUP_PROMPT structure CONTEXTE/FAITS CLÉS/ENJEUX/ANALYSE CROISÉE/SYNTHÈSE, 250 mots, sources+analyse uniquement) rédigé EN PARALLÈLE de `_groq_finalize` via asyncio.gather. `search_snippets` conservé pour Groq.
  5. Logs `[HYBRIDE]` : durée + tokens Kimi, durée + modèle Groq.
- Latences finales mesurées : question simple ~9-12 s (Kimi 10 s + Groq 0,5 s) ; recherche web ~18 s (SERP + Kimi + Groq parallèle) au lieu de 42-50 s. Pop-up d'analyse conservé (rédaction Groq, 1 278 car. testé).

## Réponse progressive — streaming SSE + parole phrase par phrase (août 2026, cette session)
- Backend : `_prepare_brain` factorisé (contexte commun) ; `_groq_finalize_stream` (Groq stream=True, générateur de deltas) ; `generate_answer_stream` (événements stage/delta/done, pop-up Groq lancé en tâche parallèle pendant le stream) ; endpoint `POST /api/chat/stream` (SSE `data: {json}\n\n`, StreamingResponse, header X-Accel-Buffering:no, persistance historique/souvenirs à l'événement done). L'endpoint `/api/chat` classique reste inchangé (repli).
- Frontend : `voice.js` → `speakSeries(phrase)` = file chaînée par onend (les phrases s'enchaînent SANS se couper, garde 30 s) ; `cancelSpeech()` interrompt aussi la série (seriesId). `App.js cloudAnswer` réécrit : (1) voie SSE — lecture ReadableStream, découpe en phrases (regex `[.!?…]` + espace), chaque phrase parlée immédiatement via speakSeries, texte affiché au fil de l'eau, extras (mémoires/pop-ups) via applyExtras factorisé ; (2) repli `/api/chat` classique ; (3) repli local. `currentSpokenRef` alimenté pour l'anti-larsen du micro.
- VÉRIFIÉ e2e : curl -N via URL externe → stage analyse 0,4 s, formulation 11,1 s, premier delta 11,3 s, 98 deltas progressifs (pas de buffering ingress) ; UI → 3 phrases parlées séparément dans l'ordre, journal « Formulation en direct », réponse complète affichée.

## Nouveaux personnages MYTHOS : SOLON# et PROMÉTHÉE# (août 2026, cette session)
- **SOLON#** (conseil juridique droit français) et **PROMÉTHÉE#** (gestion de projet) ajoutés à MYTHOS_CHARACTERS (modules_api.py, 12 personnages au total). Portraits holographiques or/cyan générés → `/app/backend/static/mythos/solon.jpg` & `promethee.jpg` (servis via /api/mythos/img/). Voix distinctes (MythosGallery CHAR_VOICES : Solon grave 0.72/0.86, Prométhée dynamique 1.02/1.12). `column.enabled: False` (pas de module ouvrable).
- **Consultation interactive** : champ `consult` sur ces 2 personnages → textarea + bouton dans la fiche galerie (`mythos-consult-input/btn/answer`) → `POST /api/mythos/consult` (CONSULT_PROMPTS, appel Kimi K3 direct, reasoning_effort low, max_tokens 1400, texte brut sans markdown). Solon répond en FAITS/DROIT/ANALYSE/OPTIONS avec citation d'articles (testé : L.3121-36 Code du travail cité) + mention « Analyse indicative — ne remplace pas la consultation d'un avocat. » ; Prométhée en OBJECTIF/JALONS/RISQUES/ACTIONS (testé : plan food-truck 2849 car.). Clé : localStorage sirius_keys ou ENV_K3_KEY.
- CSS : .mg-consult / .mg-consult-input / .mg-consult-answer (App.css fin de fichier).
- Backlog THÉMIS restant (P2) : traduction générique des erreurs Pydantic, upload en flux borné (15 Mo vérifié après lecture mémoire), centraliser les maps d'ouverture de modules d'App.js (dupliquées : BootScreen/MYTHOS/menu/commandes).

## 2026-08-07 — Avatars Mythos : style réaliste non-holographique pour TOUS les personnages
- Les 10 anciens avatars (argus, locus, oracle, pantheon, heracles, cortex, hephaistos, atlas, iris, themis) régénérés (Nano Banana) en portraits photoréalistes : visage humain réel, tenue avec accents high-tech subtils, attributs mythologiques conservés (globe Atlas, balance Thémis, marteau Héphaïstos, foudre Zeus, casque Athéna, voile Pythie, torche/ailes Iris/Hermès), interfaces holographiques or/cyan uniquement AUTOUR du personnage.
- Fichiers remplacés dans /app/backend/static/mythos/*.jpg (mêmes noms, aucun changement de code).
- Style aligné sur solon.jpg / promethee.jpg. Vérifié par screenshot de la Galerie Mythos : 12 cartes cohérentes.

## 2026-08-07 — Écran de boot : Zeus réaliste
- Nouveau portrait réaliste de Zeus (copie de pantheon.jpg) ajouté à gauche du BootScreen : /app/frontend/public/holo/zeus-boot.jpg, JSX .boot-zeus dans App.js (BootScreen), CSS .boot-zeus/.boot-zeus-caption dans App.css (fondu, entrée animée, caché < 980px).
- Vérifié par screenshot du boot : Zeus réaliste + légende « ZEUS · PANTHÉON# » visibles.

## 2026-08-07 — Zeus Cortex réaliste + nouveau personnage HERMÈS AGORA#
- /app/frontend/public/holo/zeus.jpg remplacé par un portrait rapproché réaliste du NOUVEAU Zeus (même personnage que pantheon.jpg, généré en mode édition Nano Banana). Backup : zeus_prev_backup.jpg. Overlays CSS recalés : .zeus-eyelid top 39%, left 35.7%/54.7%, .zeus-mouth-glow top 60.5%.
- NOUVEAU personnage HERMÈS AGORA# (Expert en vente senior) : avatar réaliste agora.jpg, entrée MYTHOS_CHARACTERS + CONSULT_PROMPTS (prompt système utilisateur : sec, direct, BANT/MEDDIC, objections, closing, pitchs ; réponse CONTEXTE/ANALYSE/STRATÉGIE/ACTIONS IMMÉDIATES via Kimi K3), bouton PLAN DE VENTE dans la galerie, voix dédiée (pitch 0.88, rate 1.22), module boot « agora » ouvre la galerie focalisée.
- MythosGallery.jsx : phrases vocales de consultation refactorées en map CONSULT_SPEAK.
- Testé : curl /api/mythos/consult (réponse structurée OK) + screenshot fiche galerie (panneau consultation visible).

## 2026-08-07 — Hermès Agora restylé antique
- agora.jpg régénéré : toge grecque blanc/or, caducée d or, ailes aux tempes, agora antique en fond, dashboards commerciaux holographiques or/cyan. Silhouette mise à jour (« négociant en toge »). Vérifié par screenshot galerie.

## 2026-08-07 — 4 fonctionnalités : Vente vocale, Fiches personnages, Actualités, Pipeline deals
- VENTE VOCALE : launchAgora dans App.js — commandes « agora, … », « conseil de vente… », « plan de vente… » → /api/mythos/consult (HERMÈS AGORA#), popup PLAN DE VENTE + voix dédiée (speakAsCharacter pitch 0.88 rate 1.22, lit les ACTIONS IMMÉDIATES).
- FICHES PERSONNAGES : champs bio + capacites ajoutés aux 13 personnages (modules_api.py) ; onglets PRÉSENTATION/BIOGRAPHIE/CAPACITÉS dans MythosGallery.jsx (puces .mg-cap).
- MODULE ACTUALITÉS : NewsPanel.jsx/.css — flux NewsAPI plein écran (10 articles, recherche sujet, actualisation manuelle + auto 5 min, lecture vocale). Commandes « ouvre les actualités », « module actualités » ; entrée menu modules + TOUCH_RING. L ancien popup « les actualités sur X » conservé.
- PIPELINE DEALS : endpoints CRUD /api/agora/deals (GET/POST/PUT/DELETE, collection agora_deals, étapes PROSPECTION→PERDU) ; AgoraPipeline.jsx/.css kanban (stats pipeline/gagné/relances en retard, formulaire, déplacement d étapes, relances datées rouges si dépassées). Commandes « pipeline de vente », « mes deals » ; bouton OUVRIR LE MODULE dans la fiche Agora (column.enabled=True) ; menu modules.
- Testing agent iteration_29 : 2 personnages sans bio (LOCUS/HÉPHAÏSTOS, édits perdus en parallèle) → corrigé + vérifié (API + screenshot, 5 puces chacun). Gestion d erreurs PUT/DELETE ajoutée dans AgoraPipeline + champ date labellisé RELANCE.

## 2026-08-07 — Voix Mythos M1/M2/F1/F2 + Relances auto + Deal→Thémis + Briefing 3 titres + Coaching objections
- VOIX : MYTHOS_VOICES dans voice.js (M1 grave fr-FR-Neural2-D pitch-6 rate0.9 ; M2 naturelle Neural2-B pitch-3 ; F1 premium Neural2-A pitch+2 rate1.05 ; F2 douce Neural2-C pitch+4 rate0.95). speakAsCharacter({profile}) + speakBrowser({gender}) sélection voix FR par genre. CHAR_VOICES → profils : M1=Argus/Zeus/Héraclès/Héphaïstos/Atlas, M2=Locus/Solon/Prométhée/Agora, F1=Cortex/Iris/Thémis, F2=Oracle. Jamais de mélange M/F.
- RELANCES AUTO : effet App.js (delai 24s post-boot, retry si voix occupée) → annonce vocale M2 + popup HERMÈS AGORA# — RELANCES EN RETARD.
- DEAL→THÉMIS : POST /api/themis/from-deal {deal_id, kind} — client créé si absent, devis/facture TVA 20%, badge themis_doc_number sur le deal, idempotent (409 si déjà généré). Boutons DEVIS/FACTURE sur cartes GAGNÉ, ouvre Thémis (et ferme Agora — fix superposition z-index détecté par testing agent).
- BRIEFING : 3 titres NewsAPI au lieu de 2 (server.py).
- COACHING OBJECTIONS : POST /api/agora/coach (mode play = prospect difficile Kimi K3 multi-tours, 5 scénarios ; mode debrief = NOTE GLOBALE/POINTS FORTS/AXES/SCRIPT GAGNANT). Vue COACHING dans AgoraPipeline (chat, voix prospect M1, débrief M2, session_id).
- Testing agent iteration_30 : backend 7/7, frontend 95% → fix superposition Thémis/Agora appliqué et vérifié par screenshot. Lint NewsPanel corrigé.

## 2026-08-07 — Lot ergonomique Bastien & Scapin (approuvé « tout le lot ») + 4 features Agora/briefing
### Features Agora (testées iteration_31 régression OK)
- Objectif mensuel : GET/PUT /api/agora/objectif (db.agora_settings), carte OBJECTIF DU MOIS cliquable avec barre de progression (gagné du mois/objectif).
- Historique coaching : débriefs sauvés (db.agora_coach_history, note extraite regex /10), GET /api/agora/coach/history, bouton HISTORIQUE + tendance des notes dans la vue COACHING.
- Relance 1 clic : POST /api/agora/deals/{id}/relance (email du deal ou client Thémis, SMTP thémis_keys, texte poli, relance auto +7j, compteur relances_envoyees). Champ email sur les deals. Bouton RELANCER sur les cartes.
- Météo Atlas au briefing : App.js briefing fetch /api/weather/current?city={profile.city}, phrase « Atlas annonce à … » avant le briefing.
### Ergonomie (testing agent iteration_31 : backend 10/11, frontend 85% → 4 défauts corrigés et revalidés)
- SiriusSetup refondu : 5 onglets PROFIL/VOIX/IA/HUD/API ; KeyField extrait hors composant (fix focus CRITIQUE) ; boutons TESTER par clé → POST /api/keys/validate (k3/serp/gmaps/alphavantage live, fal format >=15 chars) ; RÉINITIALISER par onglet via ConfirmButton.
- ConfirmButton.jsx : confirmation 2 clics (3s) — appliqué aux suppressions Agora deals + Thémis (docs/orders/clients/payments/pieces/items) + resets setup.
- ModulesMenu groupé : PANTHÉON/OUTILS/MÉDIAS/SYSTÈME (champ group sur moduleItems) + NOUVEAU bouton Grip top-bar data-testid=sirius-modules-btn (accès desktop).
- hudPrefs.js : transparence panneaux (--hud-panel-alpha, filter opacity), taille texte S/M/L (body zoom), HUD MINIMAL (masque stats-mini, bottom-right, gardien) — localStorage sirius_hud.
- Mode IA RAPIDE/PROFOND : localStorage sirius_ia_mode → ia_mode dans /api/chat(+stream) ; sirius_brain _groq_rapide(_stream) court-circuite Kimi en mode rapide (repli profond si Groq HS).
- Fix intention heure locale : « quelle heure à Tokyo » n est plus intercepté (guard regex localAnswer + detectIntent), part vers l IA.
- Voix Mythos : rappel — profils M1/M2/F1/F2 dans voice.js.

## 2026-08-07 — Refonte HUD « Sanctuaire Profond » + 4 features (objectif vocal, voix par dieu, raccourcis, export CSV)
### Refonte HUD (Proposition 3 choisie par user, maquettes générées et validées)
- SanctuaryAmbience.jsx (canvas, z-1 fixed) : 38 bokeh dorés 3 profondeurs, 110 poussières d or ascendantes, 4 nappes de brume, onde vocale cyan réactive (statusPulseRef volume) qui traverse derrière le noyau. Eco mode = comptes divisés par 2.
- Noyau : reactor-wrap core-{status} + .core-rings — 2 anneaux or grecs (/holo/ring-gold.png, alpha extrait par annulus PIL), rotations opposées, .core-pulse conic cyan masqué en anneau, 5 lettres grecques en orbite (cqmin), accélération quand speaking. Animation ReactorCore existante conservée dessous.
- Gardien : nouvelle image photoréaliste /holo/gardien-realiste.jpg (fond noir, SANS auréole derrière la tête, halo au sol dans l image), avancé (height 74vh, left 8%, z-3, opacity .96), filtre photoréaliste (plus de sepia), pulses or/cyan speaking/listening. Élément .guardian-halo JSX supprimé.
- .center-stage::before : lueur dorée respirante derrière le noyau.
### 4 features
- Objectif vocal : briefing matinal inclut « Hermès Agora signale : objectif mensuel atteint à X%… » (fetch /api/agora/objectif si montant>0).
- Voix par dieu : localStorage sirius_char_voices, voice.js CHAR_PROFILES exporté + speakAsCharacter({module}) merge overrides (gPitch→bPitch =1+g/15) ; UI onglet VOIX (sélecteur 13 dieux, sliders gravité -10..+6 / débit, Écouter, DÉFAUT). Tous les appels speakAsCharacter passent module.
- Raccourcis clavier : Ctrl+K modules, Ctrl+P pipeline, Ctrl+M Mythos, Ctrl+J actualités, « / » focus commande.
- Export CSV : GET /api/agora/deals/export.csv (BOM UTF-8, «;», décimales FR) + bouton EXPORT CSV dans le pipeline.
### Incidents corrigés en cours de route
- AGORA_VOICE revenu à pitch/rate (édit perdu) → { module } ; fragment dupliqué fin de SiriusSetup.jsx (tronqué) + section voix par dieu ré-insérée.
- Tests : curl (CSV, objectif) + screenshots (HUD, Ctrl+P/K, sliders voix persistés). PAS de run testing agent complet sur ce lot (auto-tests unitaires visuels).

## Session 2026-06 (fork) — Or véritable & vie du sanctuaire
- OR VÉRITABLE v2 : tous les jaunes plats du HUD remplacés par des dégradés métalliques (reflet traversant `goldSheen`), respiration lumineuse des bordures (`goldBorderBreath`), scintillement (`goldTwinkle`) sur coins d'écran et point du logo, heure/valeurs en or champagne, bouton DÉMARRER SIRIUS en or riche (App.css fin de fichier + .setup-submit).
- Citation Philosophique : zone de clic circulaire invisible sur le noyau (`core-quote-zone`, data-testid="core-quote-btn") → SIRIUS déclame une citation antique (15 citations, const PHILO_QUOTES, callback speakQuote ligne ~1313 App.js). Testé : sous-titre + TTS OK.
- Thème Par Heure : `document.body.dataset.phase` (dawn 5-9h / day 9-17h / dusk 17-22h / night 22-5h), recalculé chaque minute ; CSS filtre le canvas sanctuaire + lueur centrale + gardien selon la phase. Testé (phase dusk à 18h).
- Sons d'interface (uiSounds.js) : câblage vérifié (initUiSounds ligne ~3352), aucun conflit console. Écoute réelle à valider par l'utilisateur.

### Backlog restant
- P2 : lancement du testing_agent complet sur l'ensemble du HUD redessiné et des modules récents (demande utilisateur antérieure).
- Citations Par Dieu : 10 panthéons dotés de citations propres (const GOD_QUOTES, App.js). Clic sur le noyau avec panneau divin ouvert → le dieu déclame ; mémoire de 3 min après fermeture du panneau (lastGodRef) car la plupart des panneaux sont plein écran. Testé : Hermès (panneau ouvert via dispatch + après fermeture réelle) ✓, philosophie par défaut ✓.
- Corrections personnages/voix (session courante) :
  * argus.jpg & locus.jpg (Hermès) régénérés en style antique grec réaliste (backups *_backup_modern.jpg) ; solon.jpg & promethee.jpg régénérés sans effet holographique (backups *_backup_holo.jpg).
  * BUG VOIX RÉSOLU : Google TTS fr-FR n'a plus que Neural2-F (femme) / Neural2-G (homme). Le backend forçait tout vers G. Fix : whitelist regex dans server.py (/api/tts/google) + MYTHOS_VOICES (voice.js) → F1/F2=Neural2-F, M1/M2=Neural2-G avec pitchs différenciés. MythosBackdrop parle désormais avec speakAsCharacter (voix du personnage) au lieu de speakCinematic (voix Sirius homme).
  * Modules SOLON# & PROMÉTHÉE# : nouveau ConsultPanel.jsx (plein écran, consultation /api/mythos/consult), column.enabled=True (bouton OUVRIR LE MODULE dans la galerie), entrées menu modules + ouverture directe depuis le boot. Testé : galerie + ouverture panneau Solon OK.
- Validation complète (iteration_32) : 32/33 backend verts, 100% frontend après fix crash ConsultPanel (state history, corrigé par testing agent). Fix final : whitelist TTS explicite ALLOWED_TTS_VOICES (server.py) → Neural2-A retombe sur Neural2-G ; 9/9 tests pytest verts.
- Historique consultations Solon/Prométhée (localStorage sirius_consult_history, rechargement + suppression confirmée) ; Étincelles d'or au survol du noyau/gardien (GoldSparkles.jsx + .gold-sparkle) ; Salutation par phase (greetByPhase, briefing + accueil + setup).
- Gardien solide : gardien-solide.png (détourage par luminance de gardien-realiste.jpg), plus de mix-blend-mode screen ni masque — personnage opaque photoréaliste, cercle runique doré au sol + halo CSS conservés. Pulsation parole = luminosité seule (guardianSolidPulse).
- Export PDF consultations : build_consult_pdf (themis_pdf.py, style antique or multi-pages) + POST /api/mythos/consult/pdf (modules_api.py, ConsultPdfIn) + bouton EXPORT PDF dans ConsultPanel (télécharge solon-avis.pdf / promethee-plan.pdf). Testé e2e : historique → chargement → download OK.
- Gardien animé : wrapper .guardian-rig (perspective rotateY/rotateX pilotée par mousemove, vars --gx/--gy, App.js) + balancement de cape CSS guardianSway sur l'img. Testé : --gy varie avec le curseur.
- Note test : l'assistant d'installation premier-lancement se rouvre tant que localStorage 'sirius_installed' n'est pas '1' ; Ctrl+K ouvre à la fois la palette ET le menu modules (palette au-dessus) — utiliser dispatch_event sur .modmenu-item en test automatisé.
- CALLIOPE# — Bibliothèque audio (nouveau personnage, choisi par l'agent : muse « à la belle voix ») :
  * Portrait réaliste antique calliope.jpg (backend/static/mythos), entrée MYTHOS complète (modules_api.py, column.enabled=True), voix F2 (voice.js CHAR_PROFILES), page de présentation boot + menu modules + galerie.
  * Backend sans clé API (LibriVox/Archive.org) : GET /api/calliope/search (advancedsearch collection:librivoxaudio), GET /api/calliope/tracks/{id} (écoute directe archive.org), POST /api/calliope/download (téléchargement asynchrone mp3 64kb → static/audiobooks/{genre_slug}/{id}, suivi progress dans db.calliope_books), GET /api/calliope/library, GET /api/calliope/stream/{genre}/{id}/{file}, DELETE /api/calliope/book/{id}.
  * Frontend CalliopePanel.jsx : onglets RECHERCHER (langue, dossier de rangement préset ou libre, écoute directe, téléchargement) / BIBLIOTHÈQUE (dossiers auto par genre, statut prêt/téléchargement/erreur, lecteurs audio locaux, suppression confirmée).
  * Testé e2e : recherche Jules Verne fr (13 rés.), téléchargement complet 45/45 pistes dans dossier science-fiction, stream local 200 audio/mpeg, 45 lecteurs dans l'UI, présence boot + galerie + bouton ouvrir module.
- PYTHAGORE# — Mathématiques & géométrie (nouveau personnage, choisi par l'agent) :
  * Portrait réaliste antique pythagore.jpg (maître au compas devant ardoise de théorèmes), entrée MYTHOS (modules_api.py), voix M1, présentation boot + menu modules + galerie + carte OUVRIR LE MODULE.
  * Outils sans clé : sympy + matplotlib (installés, requirements.txt à jour). POST /api/pythagore/calc (modes eval/solve/factor/expand/derive/integrate, whitelist regex anti-injection, variable paramétrable) ; GET /api/pythagore/plot (PNG matplotlib style HUD or/cyan). Explications pédagogiques via /api/mythos/consult (CONSULT_PROMPTS PYTHAGORE# : RÉSULTAT/MÉTHODE/EXPLICATION/POUR ALLER PLUS LOIN, pipeline Kimi+Groq).
  * Frontend PythagorePanel.jsx : onglets CALCUL / TRACÉ / EXPLIQUER.
  * Testé e2e : solve x^2-5x+6=0 → x=2,3 ; sqrt(144)+3^4=93 ; dérivée ; développement (a+b)^3 ; tracé sin(x)/x rendu dans l'UI ; présence boot/menu/panneau.
  * Correctif au passage : branches boot opener calliope/pythagore (la branche calliope manquait).
- Lot de 8 fonctionnalités (validé iterations 33-34, backend 15/15, frontend 100% après correctifs) :
  * Historique cloud consultations : db.consult_history (sauvegarde auto dans /mythos/consult), GET/POST/DELETE /api/mythos/consult/history, migration localStorage→cloud avec conservation des échecs + notice « Migration partielle » (ConsultPanel.jsx).
  * PDF depuis historique : boutons FileDown/Mail/Trash sur chaque ligne (solon-history-pdf/-mail/-del).
  * Envoi email : POST /api/mythos/consult/email (PDF joint via _send_smtp de themis_api, SMTP depuis sirius_keys byok smtp_*), formulaire inline dans ConsultPanel, erreurs claires (SMTP absent, auth refusée).
  * Voix feutrée nocturne : isNight() 22h-5h dans speakFr (rate ×0.87, pitch −1.5, volume 0.72) ; volume ajouté à speakBrowser/speakGoogle.
  * Géométrie visuelle : GET /api/pythagore/geometry (parser FR : triangle rectangle/3 côtés/équilatéral, cercle, carré, rectangle, pentagone→dodécagone, polygone N côtés ; PNG matplotlib style HUD, annotations dimensions + hypoténuse).
  * Pythagore vocal : bouton micro (SpeechRecognition fr-FR), vocalToExpr (au carré→^2, racine de→sqrt, égale→=…), réponse parlée via speakAsCharacter, messages d'erreur par type (not-allowed, no-speech…) + watchdog 8s (data-testid pythagore-mic-notice) — vérifié en headless.
  * Lecture continue Calliope : BookPlayer (un seul lecteur, onEnded→piste suivante, prev/next, liste cliquable), positions localStorage calliope_positions, bandeau « Reprise : piste X à mm:ss ».
  * Historique calculs Pythagore : localStorage pythagore_history (calc/plot/geo), section DERNIERS TRAVAUX, rappel en un clic, suppression.
- Suppression effet holographique Solon/Prométhée (backdrop) : cause = .mythos-silhouette avec mix-blend-mode:screen + opacity 0.5. Fix : style.opacity=1 pour SOLON#/PROMÉTHÉE# (modules_api.py) + MythosBackdrop ajoute la classe .solid (blend normal, ombre portée sombre au lieu du glow) quand opacity >= 0.9. Vérifié en captures : les deux personnages sont solides et réalistes.
- Iris (SIRIUS DISPLAY#) régénérée en style antique réaliste : déesse de l'arc-en-ciel, peplos ivoire irisé, ailes dorées, temple grec (backup iris_backup_modern.jpg). Argus & Locus étaient DÉJÀ antiques dans le preview (l'utilisateur voyait probablement la production non redéployée). Galerie vérifiée en capture : 15 personnages tous cohérents.
- Page de présentation (boot) : noyau remplacé par la structure exacte du HUD principal (core-rings + ring-gold.png ×2 + core-pulse + core-orbit lettres grecques + ReactorCore) dans .boot-reactor (agrandi à min(30vh,250px), anciens ::before/::after neutralisés). Vérifié en capture.
- Intégration STRIPE (encaissement deals Hermès Agora, choix utilisateur option b) :
  * Sandbox provisionné via INTEGRATION_PROXY_URL (compte acct_1U1sxJIJ2yThpORJ), clés dans backend/.env (STRIPE_SECRET_KEY/PUBLISHABLE/ACCOUNT_ID/WEBHOOK_SECRET/MODE=test). Passage en réel : l'utilisateur réclame son compte via l'onboarding_url Stripe.
  * Backend payments_api.py (make_payments_router) : POST /api/payments/deal-checkout (montant calculé serveur depuis deal.valeur × 30/50/100%, cascade fiscale managed_payments→automatic_tax→simple), GET /api/payments/status/{session_id} (sync Stripe si pending), GET /api/payments/deals-status (agrégat par deal), POST /api/stripe/webhook (completed/failed/expired/refunded). Collection db.payment_transactions.
  * Frontend AgoraPipeline : bouton ENCAISSER sur les deals GAGNÉ → acompte 30/50% ou total → LIEN STRIPE (copier/ouvrir), badge vert « ENCAISSÉ X € », polling 5s. App.js : retour ?payment=success&session_id → confirmation vocale ; ?payment=cancel → message.
  * TESTÉ E2E RÉEL : checkout Stripe payé avec la carte 4242 (360 € = 30% de 1200 €) → statut paid → badge ENCAISSÉ 360 € affiché. Données de test nettoyées.
  * Piège rencontré : deux search_replace sur App.js/AgoraPipeline.jsx annoncés réussis mais non appliqués — TOUJOURS re-grep après édition de ces gros fichiers.
- Lot 4 fonctionnalités (08/06/2026, vérifié en captures d'écran preview) :
  * Couvertures de livres Calliope : miniatures archive.org (https://archive.org/services/img/{identifier}) dans résultats de recherche ET bibliothèque, onError→masqué. Vérifié : recherche « jules verne » affiche les couvertures.
  * Reçu PDF client : bouton REÇU PDF sur chaque paiement PAYÉ dans l'onglet Encaissements (génération ReportLab via themis_pdf/payments_api).
  * Relance impayés : bouton RELANCER (email) sur les paiements EN ATTENTE.
  * Onglet ENCAISSEMENTS dans Hermès Agora : historique des paiements avec total encaissé et compteur en attente. Vérifié en capture : 1 paiement reçu 360 €, 1 en attente 500 €.
- Déploiement production : endpoint racine GET /health ajouté dans server.py (les probes Kubernetes le sondaient → 404 → échec du déploiement). deployment_agent : status PASS.
- ZEUS CORTEX restauré dans le menu modules (08/06/2026) : le panneau ZeusCortex.jsx, le personnage Athéna (SIRIUS CORTEX#, galerie Mythos), la commande vocale et le boot module existaient toujours — seule l'entrée moduleItems manquait dans App.js. Ajout { id: "cortex", group: PANTHÉON, Icon: Zap }. Vérifié en capture : panneau complet avec portrait Zeus, jauges et chat.
- Animation des yeux (clignement paupières) de Zeus Cortex supprimée (08/06/2026) : spans .zeus-eyelid retirés de ZeusCortex.jsx + CSS zeusBlink supprimé d'App.css. Le glow de bouche (parole) est conservé. Vérifié en capture.
- Copier/coller activé partout (08/06/2026) : cause = user-select:none global sur .sirius-root. Passé à user-select:text, avec exceptions ciblées (button, img, canvas, svg, poignées de drag) et forçage !important sur input/textarea/select/contenteditable. Testé headless : Ctrl+V dans le champ commande OK, Ctrl+A/Ctrl+C depuis input OK, sélection + copie de texte dans les panneaux (Zeus Cortex) OK.
- Noyau boot en retard corrigé (08/06/2026) : cause = ring-gold.png de 955 Ko chargé tardivement → le noyau cyan nu (ancien look) apparaissait avant les anneaux dorés. Fix : image quantifiée 256 couleurs (955 Ko → 181 Ko, original sauvegardé dans /app/memory/ring-gold_orig.png), <link rel=preload> dans index.html, ajout au SHELL du service worker (cache bump sirius-v4). Vérifié : anneaux dorés complets à 1,2 s au premier chargement.
- Rotation des noyaux accélérée ×2,5 (08/06/2026), boot + HUD (classes partagées) : outer 70s→28s, inner 46s→18s, orbite lettres 34s→14s, pulse 9s→6s, mode speaking 26/16s→12/8s. Attention : DEUX blocs CSS déclarent .core-ring.outer/.inner (≈4170 et ≈4241 avec goldGlowPulse) — modifier les deux. Vérifié computed styles : 28s/18s/14s sur boot et HUD.
- Refonte du sanctuaire validée par mockups (08/06/2026, 3 itérations d'aperçus via image_generation_tool avant application) :
  * Gardien avancé/déplacé : .guardian-rig left 8% → calc(8% + 80px).
  * Jarre : l'amphore holographique sur estrade faisait partie d'antique.jpg. Nouveau : élément dédié <img .antique-jar> (/holo/jarre.png, PNG détouré via greenscreen #00FF00 + chroma key PIL, quantifié 192 Ko), posée au sol à droite (right 9%, bottom calc(15vh+50px), height 29vh = base 34vh −15%), ombre portée, aucun effet holo, masquée en mobile/hud-minimal.
  * Décor antique.jpg régénéré : colonnes marbre + or scintillant SOLIDES (plus d'hologramme), végétation méditerranéenne (olivier, laurier, lierre), centre sombre conservé. Ancienne version dans /app/memory/antique_v1_backup.jpg.
  * CSS .antique-bg : mix-blend-mode screen + filtre sépia holographique supprimés → rendu solide (opacity 0.92, filtre léger), antiquePulse 0.88-0.96.
  * Noyau strictement intouché. Vérifié en capture.
- Ajustements sanctuaire (08/06/2026, 2e passe) : gardien ancré au sol (top:11% → bottom:2vh, pieds à 13px du bas), jarre agrandie 29vh→36vh et reculée dans la profondeur (bottom 20vh, brightness 0.88 pour l'atmosphère), noyau restauré à sa taille/hauteur d'origine .reactor-wrap min(38vh,340px) → min(46vh,420px) (avait été réduit au commit db877f9 du 05/08). Vérifié par mesures DOM + capture.
- Ajustements sanctuaire 3e passe + découplage layout (08/06/2026) :
  * Gardien flottait car gardien-solide.png avait 86px de transparence sous les pieds → PNG recadré sur bbox alpha (814x1100), bottom:1vh. Pieds à 5px du sol.
  * Jarre +30% (36vh→47vh), déplacée à gauche (right 16%), bottom 16vh → centre vertical aligné sur celui du gardien (484 vs 495px).
  * Noyau recentré verticalement sur la page ET DÉCOUPLÉ des fenêtres flottantes : .reactor-wrap passé en position:absolute (left 50%, top calc(50% - 28px), translate(-50%,-50%)) → centre exact 400/400. .center-stage passe en justify-content:flex-end (waveform/sous-titres/commande/états ancrés en bas, le texte dynamique ne déplace plus le noyau). Gardien et jarre étaient déjà en absolu dans .sirius-root.
- Restauration selon image de référence utilisateur (08/06/2026) : noyau remonté et redimensionné pour correspondre à la maquette (reactor-wrap min(34vh,320px), top 30% du center-stage ≈ 35% viewport, toujours en absolu/découplé), jarre décalée à right 18%. Le HUD correspond maintenant à l'image validée : gardien ancré à gauche, jarre grande à droite au niveau du gardien, noyau centré horizontalement en tiers supérieur.
- Scène du trône appliquée (08/06/2026, validée par 2 mockups) : nouveau fond antique.jpg = gardien assis sur trône doré + noyau médaillon (identique page présentation, avec Σ/ΣIRIUS) + griffons + jarre + colonnes or + végétation, INTÉGRÉS AU DÉCOR (générée par IA, nettoyée des overlays UI). Backup précédent : /app/memory/antique_v2_backup.jpg.
  * CSS : .guardian-rig et .antique-jar masqués (baked au fond) ; noyau vivant masqué UNIQUEMENT dans .center-stage (.core-rings/.reactor-canvas/.reactor-text display:none, ::before/::after content:none) — le boot conserve son noyau animé ; .antique-bg sans mask, opacity 0.96, background center/cover ; .reactor-wrap reste l'ancre invisible (quote-zone, CentralCard).
  * Lisibilité : .subtitle-box et .cmd-bar passés sur fonds sombres rgba(4,12,20,0.78-0.82) + blur 6px.
  * NOTE : le noyau du HUD n'est plus animé (il fait partie de l'image de fond) — assumé par le choix utilisateur « applique exactement ça ».
- Lot du 08/06/2026 (après-midi) — tout vérifié par captures/curl :
  * HALO TOURNANT : .medallion-halo (conic-gradient or+cyan masqué en anneau, blur, screen, 16s) par-dessus le médaillon du décor. Elément dans App.js après antique-bg.
  * ZEUS CORTEX VIVANT : GET /api/cortex/stats (SQLite local_memory events/facts + psutil CPU/RAM/disque + Mongo consults) → jauges réelles (activité du jour, souvenirs, CPU/RAM), sous-systèmes selon distribution des intents, rangée totaux (CMD AUJOURD'HUI/TOTALES/SOUVENIRS). ZeusCortex.jsx fetch toutes les 8s.
  * GOOGLE CALENDAR : backend/google_calendar.py (OAuth2 httpx sans SDK, tokens Mongo db.google_calendar _id=default, refresh auto) — routes /api/oauth/calendar/login+callback, /api/calendar/status|events(GET/POST/DELETE)|disconnect. GOOGLE_CLIENT_ID/SECRET dans backend/.env. CalendarPanel.jsx + entrée menu "gcal". Connectivité Panthéon reflète l'état réel. ⚠️ L'utilisateur doit ajouter les redirect URIs preview+prod dans Google Console (son JSON n'avait que localhost).
  * MODE CAMÉRA CORRIGÉ : /api/vision/analyze appelait "meta-llama/llama-4-scout" sur l'endpoint Moonshot (404) → K3_MODEL. Idem _llm() de modules_api ("llama-3.3-70b-versatile" → K3_MODEL, corrige aussi heracles 500 vu en prod). Testé curl : analyse d'image OK.
  * FACE ID LOCAL : @vladmandic/face-api + modèles dans /public/models (tiny_face_detector, landmark68, recognition). FaceIdPanel.jsx : enregistrement visage (localStorage sirius_faceid), reconnaissance 1.6s, salut vocal via onRecognized, message élégant si pas de caméra (cas actuel de l'utilisateur). Entrée menu "faceid" groupe SYSTÈME.
  * BUG CORRIGÉ : lignes dupliquées en fin d'App.js (SyntaxError) suite à une édition — supprimées. RAPPEL: les éditions sur App.js peuvent silencieusement se perdre avec le hot reload — TOUJOURS re-grep après édition.
- Bug chevauchement boutons Agenda corrigé (08/06/2026) : .file-btn a une largeur fixe 26px (icônes) → les boutons texte de la toolbar Agenda se superposaient. Fix : .gcal-toolbar .file-btn { width:auto; padding: 0 12px; }. Vérifié en capture avec état connecté simulé. Google Calendar CONNECTÉ avec succès par l'utilisateur en PRODUCTION (événements visibles).
- Noyau rotatif réel dans le HUD (08/06/2026) : l'anneau gravé était figé dans antique.jpg → retiré du fond (image régénérée SANS anneau ni artefacts damier, backups /app/memory/antique_v3_backup.jpg = version avec anneau). Nouveau composant MedallionRing (App.js) : superpose /holo/ring-gold.png en rotation ringSpin 28s linéaire (même rotation que le boot), positionné en JS selon la géométrie cover du fond (constantes IMAGE 1264x848, centre 645,351, d=840). Masques CSS : wedge conique bas ±40° (occlusion trône/gardien) sur le wrapper + masque annulaire radial 52-78% closest-side sur l'img (laisse le titre ΣIRIUS et les griffons dégagés). data-testid sirius-live-ring. Rotation vérifiée par computed transform + capture.
- Tutoiement généralisé (08/06/2026) : cause principale = FINALIZE_PROMPT (étape Groq de formulation finale) imposait « vous / monsieur » — c'est pourquoi Sirius ne se corrigeait pas malgré les demandes. Corrigés : BASE_PROMPT (adresse directe en « tu »), FINALIZE_PROMPT, display_ask, BRIEFING_PROMPT, _llm par défaut (modules_api), CONSULT_PROMPTS (suffixe tutoiement), + 21 chaînes codées en dur côté frontend (App.js : « Je t'écoute », « Toi : », Argus sans « Monsieur », FaceID « content de te revoir », Hermès, Spotify, réglages, paiements ; PythagorePanel). Testé curl /api/chat : réponse 100 % tutoyée.
- Mémoire à la deuxième personne (08/06/2026) : le champ memoire du BASE_PROMPT stocke désormais les faits en « tu » (« Tu adores le jazz »), la restitution reste en « tu » même pour d'anciens faits en 3e personne (consigne ajoutée). Les 11 faits existants de la base SQLite du PREVIEW ont été migrés manuellement. ⚠️ La base de PRODUCTION contient encore les anciens faits en 3e personne — la consigne de restitution les couvre, et les nouveaux seront stockés en « tu » après redéploiement. Testé : stockage « Tu adores l'informatique... » ✅, restitution « Tu as un chat qui s'appelle Mimi... » ✅.
- Animations holographiques 3D des fenêtres (08/06/2026) : ouverture = zeusIn réécrit (perspective 1400px, rotateX, scale, flash brightness+blur) appliqué à .prime-screen/.zeus-screen/.modmenu/.hud-panel + holoInCard pour .central-card (préserve translate -50%). Fermeture = /app/frontend/src/holoFx.js (initHoloFx dans App.js) : listener click en phase capture qui intercepte les boutons [data-testid*="close"]/.zeus-close/.setup-close, pose .holo-closing (keyframes holoOut 240ms), puis redispatch le clic réel (flag ev.__holo). Générique : couvre TOUTES les fenêtres sans modifier chaque composant. Testé : classe posée pendant fermeture + démontage effectif (Zeus, Agenda).
- Corrections noyau/scène (08/06/2026 soir) :
  * Anneaux CONTRA-ROTATIFS : MedallionRing rend désormais 2 imgs ring-gold — bande extérieure (mask annulaire 62-78%, ringSpin 28s) + bande intérieure (mask 52-66%, ringSpinRev 18s inverse), comme le boot.
  * Liseré bleu supprimé : c'était l'« onde vocale cyan » dessinée à mi-hauteur par SanctuaryAmbience.jsx (bloc supprimé) + le canvas Waveform ne dessine plus rien quand Sirius est inactif (early-return si status ni speaking/listening/thinking).
  * Deux cercles dorés sur le visage du gardien supprimés : c'étaient .reactor-wrap::before/::after (lignes ~3930, APRÈS la règle content:none de la ligne 62 → gagnaient la cascade). Blocs supprimés.
  * Titre ΣIRIUS recentré : centre de l'anneau déplacé de x=645 → x=631 (aligné sur le titre et le disque turquoise du décor).
  * Sons cristallins ouverture/fermeture étendus (uiSounds.js) à zeus-screen, central-card, holo-popup, hud-panel (MutationObserver existant).
  Vérifié en capture : plus de ligne ni cercles, 2 anneaux animés (ringSpin/ringSpinRev computed).

## Session 08/06/2026 (soir) — Sécurisation complète auth & isolation (iteration_36/37)
- Voir /app/memory/CHANGELOG.md pour le détail (PRD > 700 lignes, journal déplacé).
