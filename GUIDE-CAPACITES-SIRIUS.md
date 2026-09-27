# ΣIRIUS Assistant
## Inventaire complet des capacités

**Version de référence : 1.0.24**  
**Éditeur : Daniel Partel**  
**Site : https://sirius-assistant.fr**

## Lire ce document

- **LOCAL** : fonctionne dans l'application Windows avec les données du poste.
- **CONFIGURABLE** : nécessite une clé API, un compte ou une URL fournie par l'utilisateur.
- **OPTIONNEL** : dépend d'un service externe ou d'un matériel disponible.
- **PRÉPARATION** : interface ou moteur présent, mais intégration à finaliser.
- **LIMITE** : ne remplace pas une certification, un professionnel ou une décision humaine.

## 1. Identité et cœur de ΣIRIUS

ΣIRIUS est une application Windows et web composée d'une interface React, d'un backend Python/FastAPI et d'un moteur conversationnel configurable.

Le produit peut :

- répondre par texte en français ;
- recevoir des commandes vocales en français ;
- utiliser une voix de synthèse française ;
- fonctionner en application Windows installée ou portable ;
- démarrer son backend local automatiquement ;
- fonctionner avec un stockage SQLite local lorsqu'aucun MongoDB n'est disponible ;
- afficher l'état des services, la mémoire, le réseau et les ressources système ;
- fonctionner selon plusieurs modes : normal, frugal et secours ;
- afficher une fenêtre de progression et un journal des tâches ;
- recevoir des mises à jour automatiques via les releases GitHub ;
- fonctionner comme PWA et être préparé pour Android/iOS via Capacitor.

**Statut : LOCAL pour l'application et le backend ; CONFIGURABLE pour le moteur IA et les services externes.**

## 2. Interface HUD et expérience

Le HUD ΣIRIUS fournit :

- réacteur central animé ;
- statut écoute, réflexion et réponse ;
- visualisation de l'onde vocale ;
- horloge, date, météo et statistiques CPU/RAM ;
- navigation par palette de commandes ;
- fenêtres de travail déplaçables et redimensionnables ;
- raccourcis clavier et commandes vocales ;
- mode plein écran ;
- mode overlay Electron avec raccourci global ;
- animations de démarrage et présentation vocale ;
- mains holographiques 3D et cortex visuel ;
- écran de présentation et séquence d'activation ;
- affichage média et fenêtres web ;
- adaptation mobile et navigation compacte ;
- respect du mode de mouvement réduit du système.

Le HUD est la signature visuelle. Les écrans métier restent séparés en panneaux lisibles, avec formulaires, tableaux, filtres, recherche et impression.

## 3. Voix, langage et conversation

ΣIRIUS peut :

- écouter avec la reconnaissance vocale du navigateur ;
- utiliser la touche Espace comme talkie-walkie ;
- convertir une commande orale en intention ;
- corriger certaines erreurs phonétiques fréquentes ;
- prononcer correctement « ΣIRIUS » et les termes spécialisés ;
- interrompre une réponse vocale avec une nouvelle commande ;
- éviter les faux déclenchements liés à l'écho ;
- parler avec une voix française navigateur ou un service TTS configuré ;
- adapter le débit et la gravité de la voix ;
- lire les réponses longues à la demande ;
- ouvrir un module à la voix ;
- lancer des médias, notes, tâches, documents et recherches vocalement ;
- proposer des réactions visuelles pendant l'écoute et la réponse.

**Limite :** la reconnaissance vocale dépend du navigateur, du microphone et des autorisations Windows.

## 4. Intelligence artificielle et réponses fiables

Le moteur IA peut :

- répondre en français ;
- analyser une demande et détecter une intention ;
- rechercher des informations web lorsque la clé de recherche est configurée ;
- synthétiser un briefing ou un document ;
- produire des réponses structurées ;
- générer des diagrammes d'architecture ;
- proposer des actions correctives ;
- analyser du code sans l'exécuter ;
- générer des plans à partir d'une description ;
- utiliser un mode brainstorming ;
- conserver le contexte de la conversation ;
- afficher les erreurs de service plutôt que masquer silencieusement un échec.

**Règle professionnelle :** les décisions sanitaires, comptables, juridiques, médicales, financières ou de sécurité doivent être vérifiées par une personne compétente.

## 5. Mémoire et apprentissage local

Le système de mémoire propose :

- souvenirs personnels enregistrés à la demande ou automatiquement ;
- panneau « ce que ΣIRIUS sait sur moi » ;
- mémoire longue durée datée ;
- catégories préférences, projets et souvenirs ;
- mémoire locale SQLite ;
- rappel par mots-clés ;
- rappel sémantique hors ligne avec embeddings multilingues ;
- journal d'événements et habitudes ;
- score de confiance et suggestions ;
- édition et suppression des souvenirs ;
- export et sauvegarde de la mémoire ;
- séparation des données par utilisateur lorsque l'authentification est active.

**Confidentialité :** les clés et données personnelles ne doivent pas être ajoutées aux rapports ou au dépôt de code.

## 6. SIRIUS Entreprise

Le module Entreprise fournit un espace de travail pour petite équipe :

- création d'une entreprise ;
- plusieurs établissements avec nom, adresse et statut ;
- membres d'équipe ;
- rôles administrateur, manager, opérateur et lecteur ;
- permissions par module : HACCP, documents, audit, sites, membres, sauvegardes, THÉMIS et intégrations ;
- ajout d'un compte existant par e-mail ;
- changement de rôle contrôlé ;
- protection du propriétaire administrateur ;
- tableau de bord : membres, sites, documents, audits et non-conformités ;
- état des licences et du support ;
- recherche globale dans membres et journal ;
- filtre des actions d'audit ;
- impression du journal ;
- affichage mobile ;
- fonctionnement multi-établissements préparé pour les workflows métier.

La facturation en ligne et la gestion automatique des abonnements doivent encore être reliées à un fournisseur de paiement pour être considérées comme opérationnelles.

## 7. Utilisateurs, sécurité et RGPD

ΣIRIUS propose :

- comptes par e-mail et mot de passe ;
- session locale réservée à la machine autorisée ;
- tokens d'accès signés ;
- cookies HttpOnly, Secure et SameSite Strict ;
- rafraîchissement de session ;
- verrouillage après plusieurs échecs de connexion ;
- réinitialisation de mot de passe par code e-mail configuré ;
- mots de passe hachés avec bcrypt ;
- MFA/TOTP avec QR code ;
- secret MFA chiffré avant stockage ;
- code MFA à chaque connexion après activation ;
- index utilisateurs uniques et migration des anciens index ;
- permissions par module ;
- séparation des données par utilisateur ou entreprise ;
- export RGPD des données personnelles en ZIP ;
- demande de suppression de compte avec confirmation ;
- impossibilité de supprimer directement le compte administrateur principal ;
- journal d'audit des actions sensibles ;
- contrôle des chemins et des types de fichiers ;
- limitation de taille des uploads ;
- détection des secrets dans l'audit de release.

**À compléter selon le contexte :** analyse juridique RGPD, registre de traitement, politique de rétention, chiffrement du disque Windows, sauvegarde chiffrée et procédure de restauration testée.

## 8. HACCP et sécurité alimentaire

Le module HACCP gère :

- traçabilité des réceptions ;
- produit, lot, fournisseur, quantité et DLC ;
- température à réception ;
- équipements froid positif, congélateur et liaison chaude ;
- relevés de températures avec seuils ;
- détection des relevés non conformes ;
- historique des relevés ;
- plan de maîtrise sanitaire ;
- statuts des procédures PMS ;
- non-conformités ;
- gravité mineure, majeure et critique ;
- description d'anomalie ;
- action corrective ;
- clôture confirmée d'une non-conformité ;
- plan de nettoyage et désinfection ;
- zones, produits, fréquences et responsables ;
- validation des tâches de nettoyage ;
- référentiel des 14 allergènes UE ;
- fiches allergènes par plat ;
- registre des documents obligatoires ;
- dates d'émission et d'expiration ;
- fiches de contrôle persistantes ;
- dictée vocale d'une fiche ;
- résultat conforme, non conforme ou sans objet ;
- validation humaine avec identité et date ;
- historique des contrôles ;
- feuilles HACCP vierges imprimables ;
- feuilles HACCP pré-remplies ;
- étiquettes produits imprimables ;
- rapport PDF d'audit avec période, sources, contrôles et validations ;
- sauvegarde des données HACCP ;
- permissions d'accès HACCP ;
- journal des créations, validations et rapports.

**Limite :** le rapport est un outil de préparation et de traçabilité interne, pas une certification officielle.

## 9. THÉMIS : entreprise, ventes et finance

THÉMIS peut gérer :

- fiches clients ;
- nom, entreprise, e-mail, téléphone et adresse ;
- devis ;
- factures ;
- lignes, quantités et prix unitaires ;
- calcul HT, TVA et TTC ;
- numérotation des documents ;
- statuts brouillon, envoyé, accepté, payé et refusé ;
- dates d'échéance ;
- paiements et moyens de paiement ;
- relances de clients ;
- commandes ;
- suivi des commandes ;
- modèles de documents ;
- modèles antique, moderne et minimal ;
- génération PDF ;
- envoi d'un document par e-mail lorsque SMTP est configuré ;
- pièces fournisseurs PDF, PNG, JPG et WEBP ;
- lecture OCR/IA des pièces ;
- journal comptable ;
- synthèse TVA ;
- rapprochement bancaire ;
- prévisionnel de trésorerie ;
- exports comptables et CSV ;
- stocks et articles ;
- référence, prix, stock initial et seuil d'alerte ;
- alertes de stock bas ;
- mouvements d'entrée et de sortie ;
- motif du mouvement ;
- stock avant et après ;
- historique des mouvements par article.

**Limite :** THÉMIS est un outil de suivi et de pilotage. Il ne remplace pas une comptabilité légale certifiée ni un expert-comptable.

## 10. CRM et commercial

Les briques commerciales comprennent :

- contacts et carnet d'adresses ;
- clients et entreprises ;
- pipeline de ventes HERMÈS AGORA ;
- prospects et opportunités ;
- étapes de vente ;
- montants et commissions à compléter selon le paramétrage ;
- objectifs commerciaux ;
- coaching d'objections ;
- historique des échanges ;
- relances ;
- transformation d'un deal gagné en devis ou facture THÉMIS ;
- export des données commerciales ;
- journalisation des actions principales.

## 11. Productivité et gestion de projet

Les outils de productivité proposent :

- notes et SmartNotes ;
- tâches et TaskMaster ;
- échéances ;
- états de tâches ;
- fenêtres de suivi ;
- progression des opérations longues ;
- rapports et ReportBuilder ;
- analyse locale de documents ;
- analyse de code ;
- revue technique par le Compagnon Dev ;
- projets et mémoire associée ;
- diagrammes d'architecture ;
- export et affichage spectateur/casting pour les diagrammes.

**Préparation :** diagrammes de Gantt, feuilles de temps détaillées, allocation de charges et budget projet nécessitent encore un module dédié complet.

## 12. Documents, médias et stockage

ΣIRIUS propose :

- médiathèque de fichiers ;
- upload, liste, téléchargement et suppression logique ;
- images, audio, PDF, texte, CSV et XLSX selon les routes ;
- analyse de documents ;
- lecteur audio intégré ;
- miniatures d'images ;
- coffre documentaire Entreprise ;
- permissions par module ;
- stockage local Windows ;
- repli local lorsque le cloud n'est pas configuré ;
- sauvegarde des métadonnées et fichiers d'entreprise ;
- suppression des chemins dangereux ;
- limite de taille et types contrôlés ;
- export PDF, CSV, XLSX selon les modules ;
- export DXF et SVG pour PLANS# ;
- impression directe des feuilles métier.

**Préparation :** synchronisation cloud externe type NAS, OneDrive, Google Drive ou S3 à connecter selon le besoin de l'entreprise.

## 13. Outlook, Gmail, calendrier et contacts

### Microsoft 365

Avec OAuth Microsoft configuré, ΣIRIUS peut accéder selon les autorisations :

- boîte Outlook ;
- recherche d'e-mails ;
- lecture et classement d'e-mails ;
- messages importants ;
- envoi d'e-mails après validation ;
- suppression d'e-mails sensibles avec contrôle ;
- calendrier Microsoft ;
- événements du jour ;
- création et modification d'événements selon les scopes ;
- contacts Outlook ;
- dossiers de contacts ;
- rafraîchissement des tokens ;
- reconnexion si l'autorisation expire.

### Google

Avec OAuth Google configuré, les services autorisés peuvent fournir :

- Google Calendar ;
- création et lecture d'événements ;
- rappels d'agenda ;
- Gmail selon les scopes ;
- lecture de messages pour le briefing et les actions autorisées.

Aucun mot de passe Google ou Microsoft ne doit être transmis à ΣIRIUS.

## 14. Home Assistant et équipements

KERAUNOS# permet, avec une URL et un jeton Home Assistant :

- connexion REST à Home Assistant ;
- lecture des états d'entités ;
- commandes vocales ;
- contrôle des appareils autorisés ;
- retour d'erreur si le service est indisponible ;
- conservation locale de la configuration selon le mode choisi.

La connexion à des équipements professionnels dépend de leur API ou de leur compatibilité Home Assistant.

## 15. PLANS# et géométrie

PLANS# peut :

- transformer une description naturelle en plan ;
- créer des pièces et surfaces ;
- calculer surfaces et périmètres ;
- afficher une vue 2D couleur ;
- afficher une vue 3D isométrique ;
- calculer des dimensions et cotes ;
- produire un export DXF ;
- produire un export SVG ;
- ouvrir le résultat dans AutoCAD, LibreCAD ou QCAD ;
- utiliser la commande vocale : « dessine-moi le plan d'un garage de 6 sur 4 ».

## 16. Vision, OCR et multimédia

ΣIRIUS peut proposer :

- capture caméra ;
- capture d'écran Electron ;
- OCR et résumé d'écran avec vision IA configurée ;
- analyse d'images ;
- mains holographiques 3D ;
- cortex visuel ;
- galerie MYTHOS ;
- archives Europeana ;
- fiches pays ;
- actualités ;
- documentaires ;
- météo ;
- Spotify et morceau en cours ;
- YouTube, Twitch, TikTok et Deezer via leurs lecteurs officiels ;
- synchronisation de fenêtres média par WebSocket ;
- génération de clichés cinématiques TRAILER# ;
- PACKAGER# pour livrables multi-plateformes.

## 17. Supervision et maintenance

PANTHEON SYSTEM, NEXUS, ARGUS et HÉPHAÏSTOS fournissent :

- supervision des processus ;
- affichage CPU/RAM ;
- état du réseau ;
- tests de connectivité ;
- historique des services ;
- diagnostic local ;
- vérification des modules ;
- surveillance proactive ;
- modes normal, frugal et secours ;
- actions de maintenance protégées ;
- contrôle des fonctions d'auto-réparation ;
- sauvegardes locales avec manifeste et SHA-256 ;
- vérification d'intégrité ;
- restauration des données d'entreprise ;
- journal des opérations sensibles.

## 18. ORACLE DIVIN et SIRIUS PRIME

ORACLE DIVIN peut afficher :

- briefing du matin ;
- météo sur plusieurs jours ;
- cours crypto selon les APIs disponibles ;
- tendances de marché ;
- actualités et impact estimé ;
- phase lunaire et données astronomiques ;
- prédictions personnelles basées sur les habitudes enregistrées.

SIRIUS PRIME peut afficher :

- journal d'apprentissage ;
- habitudes par heure et jour ;
- intentions fréquentes ;
- score de confiance ;
- suggestions du jour ;
- gestion et modification de la mémoire.

**Limite :** les prévisions et estimations ne sont pas des garanties financières ou scientifiques.

## 19. Installateur, mises à jour et qualité

Le projet fournit :

- installateur Windows NSIS ;
- version portable Windows ;
- licence affichée dans l'installateur ;
- lancement automatique du backend local ;
- raccourci bureau et menu Démarrer ;
- conservation contrôlée des données lors de la désinstallation ;
- mise à jour automatique Electron ;
- blockmap pour les mises à jour différentielles ;
- releases GitHub ;
- audit de secrets ;
- tests backend et frontend ;
- tests de restauration ;
- tests de sécurité ;
- modèle de bug GitHub ;
- guide Entreprise ;
- procédure support et récupération ;
- vérification du bundle frontend embarqué ;
- détection des régressions de version.

## 20. Limites et responsabilités

ΣIRIUS est un assistant logiciel et une plateforme d'outils. Il ne constitue pas :

- un expert-comptable ;
- un avocat ;
- un service de paie certifié ;
- une certification HACCP ;
- un dispositif médical ;
- une autorité de sécurité ;
- une signature électronique qualifiée ;
- une garantie de résultat commercial ou financier ;
- un remplacement de la validation humaine.

Les données critiques doivent être vérifiées, sauvegardées et validées par une personne compétente. Les intégrations externes nécessitent leurs comptes, autorisations, clés et conditions d'utilisation propres.

## 21. Références et support

- Boutique : https://sirius-assistant.fr
- API : https://api.sirius-assistant.fr
- GitHub : https://github.com/bleudpart/sirius
- Support : danielpartel@hotmail.com
- Support secondaire : danielsirius.pro2026@gmail.com
- Téléphone : 06 60 66 74 36

© 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
