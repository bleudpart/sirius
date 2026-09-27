# SIRIUS Entreprise

SIRIUS Entreprise regroupe les fonctions HACCP, la mémoire documentaire,
l'audit et les intégrations de productivité dans un espace de travail isolé.
Cette version est conçue pour une petite équipe et doit être utilisée avec des
données de test avant toute mise en production réglementaire.

## Mise en route

1. Installer la version Windows depuis la [release SIRIUS](https://github.com/bleudpart/sirius/releases).
2. Créer le premier compte administrateur.
3. Ouvrir le contexte **Entreprise** et créer l'entreprise.
4. Ajouter les membres de l'équipe et attribuer leurs rôles.
5. Configurer Outlook, Google Agenda ou les autres services depuis leurs
   mécanismes OAuth officiels.
6. Créer une première sauvegarde avant d'importer des données réelles.

## Rôles

| Rôle | Droits principaux |
|---|---|
| `admin` | Entreprise, membres, sauvegardes, restauration, audit et modules |
| `manager` | Gestion opérationnelle, sauvegardes et consultation de l'audit |
| `operator` | Saisie HACCP, documents et opérations autorisées |
| `viewer` | Consultation sans modification |

Le propriétaire de l'entreprise reste administrateur et ne peut pas être
retiré par un autre membre.

## Administration multi-sites

Depuis l'espace **Entreprise**, un administrateur ou un manager peut créer
plusieurs établissements avec leur nom et leur adresse. Les établissements
actifs apparaissent dans le tableau de bord et peuvent ensuite servir de
périmètre de travail pour les procédures HACCP.

Le tableau de bord affiche le nombre de membres, d'établissements actifs, de
documents, d'événements d'audit et de non-conformités ouvertes. L'état de la
licence et le contact support sont également visibles. La facturation en ligne
n'est pas encore activée dans cette version : aucun paiement ne doit être
considéré comme traité depuis ce panneau.

## HACCP professionnel

Le module couvre les réceptions et DLC, équipements et températures, PMS,
non-conformités, nettoyage, allergènes, documents obligatoires et rapport
d'audit PDF. Les sessions authentifiées isolent les données par entreprise;
les anciennes sessions locales non authentifiées restent compatibles pour les
tests et le mode historique.

Chaque réception, température, non-conformité, document et rapport généré peut
laisser une trace dans le journal d'audit de l'entreprise. Le rapport PDF est
un outil de préparation d'audit interne et ne constitue pas une certification
officielle.

### Workflow d'une fiche de contrôle

1. Ouvrir **HACCP → Contrôles** et choisir le type de contrôle.
2. Saisir ou dicter l'objet, le résultat, l'anomalie et l'action corrective.
3. Enregistrer la fiche : elle apparaît dans l'historique avec le statut
   **à valider**.
4. Faire vérifier la fiche par le responsable, puis cliquer sur **Valider**.
5. Générer le **Rapport d'audit PDF** en incluant les fiches de contrôle.
6. Conserver le PDF et la sauvegarde Entreprise pour retrouver l'historique
   lors d'un contrôle.

La validation identifie le compte qui a validé la fiche et la date de validation.
La signature manuscrite ou la signature électronique qualifiée n'est pas
remplacée par ce bouton de validation interne.

## Documents

Le coffre documentaire accepte les PDF, images JPEG/PNG, texte, CSV et XLSX,
avec une limite de 20 Mo par fichier. Les fichiers sont stockés localement,
les noms et chemins sont contrôlés, la suppression est logique et les actions
de l'équipe sont journalisées.

Routes principales :

- `POST /api/files/upload`
- `GET /api/files`
- `GET /api/files/{id}`
- `GET /api/files/{id}/content`
- `DELETE /api/files/{id}`

## Sécurité et droits

Les comptes utilisent des mots de passe hachés, des sessions à durée limitée,
des protections contre les tentatives répétées et des permissions explicites
par membre. Les jetons OAuth des services tiers sont chiffrés avant stockage.
Les sauvegardes sont limitées à l'entreprise concernée et les actions sensibles
sont inscrites au journal d'audit.

Depuis **Mon profil**, un utilisateur peut exporter ses données personnelles au
format ZIP ou demander la suppression de son compte. La suppression exige une
confirmation; le compte administrateur principal doit être désactivé ou traité
par un autre administrateur pour éviter de perdre l'accès à l'entreprise.

Le MFA/TOTP est disponible dans cette version. Pour l'activer, ouvrir
**Mon profil → Activer le MFA**, scanner le QR avec une
application d'authentification et confirmer avec le code à 6 chiffres. Le code
sera demandé à chaque connexion. Pour le désactiver, un code MFA valide est
requis.

Protéger également le compte Windows, le disque et les sauvegardes avec les
mécanismes de chiffrement de l'organisation.

## Sauvegardes

Les sauvegardes Entreprise sont créées par l'administrateur ou le manager et
contiennent un manifeste, les collections métier de l'entreprise, les
métadonnées documentaires, la mémoire SQLite locale lorsqu'elle existe et les
fichiers de cette entreprise. Une restauration remet les données et les
fichiers de l'entreprise; elle est réservée à l'administrateur et exige une
confirmation explicite.

Routes principales :

- `POST /api/enterprise/backups`
- `GET /api/enterprise/backups`
- `POST /api/enterprise/backups/restore?confirm=true`

Conserver au moins une sauvegarde hors du PC principal et tester régulièrement
une restauration sur une machine de test.

## Outlook et calendrier

Les connexions Microsoft Graph et Google Agenda utilisent OAuth. Les mots de
passe ne sont jamais demandés à SIRIUS. Avant une mise en production, vérifier
les permissions accordées, le fuseau horaire, la lecture des événements et la
confirmation humaine avant l'envoi d'un e-mail ou la création d'un rendez-vous.

## Intégrations disponibles

Le panneau **Entreprise → Intégrations** indique si chaque connecteur est
connecté, configuré ou à configurer :

- **Outlook / Microsoft 365** : OAuth Microsoft Graph pour mails, calendrier
   et contacts ;
- **Google Calendar / Gmail** : OAuth Google pour l'agenda et les services
   autorisés ;
- **Home Assistant** : URL et jeton configurés dans KERAUNOS# ;
- **Stockage documentaire** : stockage local contrôlé, avec sauvegardes
   Entreprise ;
- **THÉMIS / contacts CRM** : suivi commercial et comptable interne, exports
   disponibles ;
- **Exports** : PDF, CSV et DXF selon le module utilisé (HACCP, THÉMIS ou
   PLANS#).

Les états affichés sont issus de la configuration et des jetons locaux. Ils ne
remplacent pas un test métier : après connexion, vérifier la lecture d'un
message, la création d'un événement et l'export d'un document de test.
## Contrôle avant diffusion

- vérifier les rôles avec un compte de chaque niveau ;
- vérifier qu'une entreprise ne voit pas les données d'une autre ;
- générer et ouvrir un rapport HACCP PDF ;
- créer puis restaurer une sauvegarde de test ;
- tester upload, téléchargement et suppression d'un document ;
- vérifier les connexions Outlook/Google sans stocker de secrets dans le dépôt ;
- exécuter les tests backend et le build frontend avant publication.

SIRIUS facilite le suivi et la préparation documentaire. Les décisions
sanitaires, comptables, juridiques et réglementaires doivent rester validées
par une personne compétente.

© 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.