# Finance d’entreprise de ΣIRIUS

Tableau de gestion multisectoriel destiné au dirigeant et à son banquier :
formation du résultat, capacité de remboursement, point mort, trésorerie, bilan
et BFR, indicateurs métier. Ce module **n’est ni une comptabilité certifiée, ni
une déclaration de TVA, ni une prévision bancaire garantie**. Aucun chiffre n’est
produit par un modèle d’IA : tout est calculé de façon déterministe, en `Decimal`,
à partir des pièces enregistrées. Le portefeuille personnel de NUMMARIUS est un
registre distinct que ce module ne lit ni ne modifie.

Accès : **NUMMARIUS → Finance d’entreprise**, dans la même fenêtre et avec les
mêmes cartes bleu nuit et doré que les autres espaces financiers. Deux espaces :

- **Mon entreprise** : les vrais chiffres de l’entreprise rattachée au compte,
  réservés à ses administrateurs et gestionnaires ;
- **Démonstration fictive** : quatre entreprises inventées, en lecture seule,
  pour découvrir l’outil sans rien saisir.

Chaque espace propose deux vues : **Tableau de bord** et **Saisie & imports**.

## Démarrage pour un test bancaire

### 1. Parcourir la démonstration fictive

Toute session ouverte peut consulter la démonstration ; aucune donnée
d’entreprise réelle n’est lue ni écrite. Les pièces sont générées de façon
déterministe à partir d’un grand livre en partie double couvrant les exercices
2023 à 2025 (du 01/01/2023 au 31/12/2025). Un bandeau rappelle en permanence
que les entreprises sont entièrement fictives ; le rapport et son export portent
la mention « DONNÉES FICTIVES DE DÉMONSTRATION ».

| Entreprise fictive | Secteur | Ce qu’elle permet d’examiner |
|---|---|---|
| Brasserie Le Grand Comptoir | Restauration | Food Cost, Beverage Cost et Prime Cost ; prêt d’acquisition du fonds (2021) puis matériel de cuisine financé à crédit en mars 2024 : annuités, couverture et capacité de remboursement ; fermeture annuelle de janvier dans l’évolution mensuelle. |
| Durand Rénovation | BTP | Déboursé sec et marge par chantier, facturation en situations mensuelles ; chantier déficitaire en 2024 (désamiantage imprévu) signalé par un point d’attention ; TVA sur les encaissements. |
| Maison Lumière — décoration | Commerce | Saisonnalité de Noël et soldes, rotation des stocks, panier moyen, BFR et délais ; crédit de campagne pour le stock de Noël 2024 ; distribution de dividendes. |
| Altitude Conseil | Services | Taux journalier moyen réel (indexé de 3 % par an), délais clients de 45 à 75 jours, poids des charges de structure. |

Raccourcis de période : Décembre 2025, Novembre 2025, T4 2025, Année 2025 (par
défaut), Année 2024 et 2023 → 2025 ; toute autre période comprise dans ces bornes
se choisit avec « Du » et « Au ».

Garanties vérifiées par les tests automatisés, pour chaque secteur et chaque
exercice :

- CA HT et EBE du tableau égaux à ceux du grand livre ;
- trésorerie d’ouverture et de clôture égale aux disponibilités des bilans ;
- bilans équilibrés ; variation des capitaux propres égale au résultat net moins
  les dividendes ;
- aucun point d’attention « à surveiller » ou « prioritaire », hormis le chantier
  déficitaire du BTP en 2024 ;
- marge d’EBE comprise entre 5 et 20 % ; couverture des annuités, trésorerie en
  jours, BFR, délais clients et fournisseurs, gearing et autonomie financière
  tous calculables ;
- commerce, sur les 36 mois : trésorerie de clôture de chaque mois de décembre
  égale aux disponibilités du bilan, somme des variations mensuelles de stocks
  égale à la variation de la période.

Le serveur prépare ces démonstrations 30 secondes après son démarrage ; sur le
poste de bureau, chaque entreprise est construite à son premier affichage
(quelques secondes), puis conservée en mémoire.

### 2. Tester avec de vrais chiffres

Prérequis : un compte rattaché à l’entreprise (module Entreprise) avec le rôle
**admin** ou **manager**. Dans **Saisie & imports** :

1. **Créer le profil financier** : nom, secteur et devise. La devise est
   verrouillée dès qu’une pièce existe.
2. **Solde de trésorerie** daté du premier jour de la période testée : c’est le
   solde au début de ce jour, donc le solde de fin de journée de la veille
   (l’« ancien solde » du relevé).
3. **Importer le relevé bancaire** de la période (CSV, OFX ou QFX) : il alimente
   encaissements, décaissements et trésorerie de clôture.
4. **Recettes** : HT, taux de TVA, ventilation aliments/boissons/marchandises,
   nombre de tickets, heures ou jours réalisés selon le secteur.
5. **Achats** : catégorie, TVA déductible ou non, ventilation des matières et
   marchandises, référence de chantier.
6. **Charges récurrentes** : loyer, salaires bruts et charges patronales,
   emprunts (mensualité **et** part de capital), assurances, autres.
7. **Bilan** le plus récent, arrêté au plus tard à la fin de la période.
8. **Inventaires** au premier jour de la période et au lendemain du dernier jour
   (restauration et commerce ; aussi chaque premier du mois pour la variation de
   stocks mensuelle).

| Bloc du tableau de bord | Pièces nécessaires |
|---|---|
| Formation du résultat (VA, EBE, CAF) | Recettes, achats, charges récurrentes |
| Endettement et capacité de remboursement | Charges récurrentes « Emprunt » avec leur capital ; bilan pour dettes financières, gearing et capacité de remboursement |
| Point mort et marge de sécurité | Recettes, achats, charges récurrentes |
| Trésorerie | Solde de trésorerie au début + mouvements bancaires |
| Bilan, BFR et délais de paiement | Bilan, et l’activité de la période (recettes, achats) |
| TVA et engagements récurrents | Recettes, achats, charges récurrentes |
| Indicateurs métier | Restauration : inventaires aliments et boissons, recettes et achats ventilés. BTP : références devis/chantier. Commerce : inventaires de marchandises, nombre de tickets. Services : heures et jours réalisés. |

Exemple de relevé CSV accepté (le bouton « Modèle CSV vierge » fournit l’en-tête) :

```csv
Date;Libellé;Débit;Crédit;Référence
02/01/2026;VIR CLIENT DUPONT;;1 200,00;F2026-001
05/01/2026;PRLV LOYER JANVIER;950,00;;
```

### 3. Grille de recette pour le banquier

- **Formation du résultat** : CA − consommations de tiers = valeur ajoutée −
  frais de personnel = EBE − intérêts = CAF − capital remboursé =
  autofinancement après annuités, chaque ligne avec son pourcentage du CA.
- **Trésorerie** : la trésorerie de clôture doit égaler le solde du relevé à la
  même date (solde initial + mouvements importés).
- **Bilan** : capitaux propres, dettes financières, endettement net, gearing,
  autonomie financière ; la date du bilan utilisé est affichée.
- **Repères** : chaque ratio repéré affiche « Repère respecté », « À surveiller »
  ou « Seuil critique » (voir [Seuils](#seuils-et-points-dattention)).
- **Comparaison** : même période N-1 (par défaut), période précédente ou aucune ;
  variations en valeur et en pourcentage.
- **Export CSV** : le fichier s’ouvre dans Excel (séparateur point-virgule,
  virgule décimale, accents conservés).
- **Imprimer / PDF** : rapport « Dossier de gestion » complet, sections
  dépliées, sans boutons ; choisir « Enregistrer au format PDF » dans la boîte
  d’impression.
- **Isolation et rôles** : un compte d’une autre entreprise, un rôle `operator`
  ou `viewer`, ou un identifiant d’entreprise deviné n’accède à rien (403 ou
  404).
- **Traçabilité** : le journal d’audit indique qui a saisi, importé, supprimé ou
  modifié, et quand.
- **Réimport** : réimporter le même relevé ne crée aucun doublon ; un relevé qui
  chevauche le précédent n’ajoute que les nouvelles opérations.
- **Annulation d’import** : « Annuler l’import » supprime en une seule
  transaction les écritures encore liées à ce lot.

## Architecture et accès

- [schemas/finance.py](schemas/finance.py) : contrats Pydantic stricts (enums
  fermées, champs inconnus interdits, dates ISO sans heure, cohérence HT/TVA/TTC)
  et structure du tableau de bord.
- [schemas/finance_entries.py](schemas/finance_entries.py) et
  [schemas/finance_ingestion.py](schemas/finance_ingestion.py) : saisie, journal
  d’audit, résultats et journal des imports.
- [models/finance.py](models/finance.py) : SQLAlchemy 2 ; chaque table de pièces
  porte `company_id`, indexé avec la date, et la base vérifie elle-même les
  contraintes (CHECK, unicité par date).
- [kpi_engine.py](kpi_engine.py) : moteur pur, sans HTTP, ORM, données de marché
  ni IA. Calcul commun, indicateurs bancaires, stratégies sectorielles
  (`BaseSectorKPIStrategy` et factory `sector_strategy`), points d’attention,
  évolution mensuelle et comparaison.
- [finance_entries.py](finance_entries.py) : profil, saisie, suppression et
  journal d’audit ; chaque écriture et son événement d’audit sont enregistrés
  dans la même transaction.
- [finance_connectors.py](finance_connectors.py) et
  [ingestion_service.py](ingestion_service.py) : adaptateurs POS, CSV, OFX et OCR
  (`BaseDataConnector`, `connector_factory`) et ingestion atomique, idempotente
  et annulable.
- [finance_demo.py](finance_demo.py) : démonstrations calculées en mémoire, sans
  accès à la base.
- [finance_database.py](finance_database.py) : SQLite
  `data_file("finance.sqlite3")` ouvert à la première requête, clés étrangères
  actives, transaction explicite pour une lecture cohérente.
- [routers/finance.py](routers/finance.py) : routes FastAPI, montées par
  `server.py` sous `/api/finance`.
- Interface : [companyFinance.js](../frontend/src/companyFinance.js) (client,
  libellés, formats, export CSV, impression),
  [useFinanceLoader.js](../frontend/src/useFinanceLoader.js),
  [CompanyFinanceDashboard.jsx](../frontend/src/CompanyFinanceDashboard.jsx),
  [CompanyFinanceReport.jsx](../frontend/src/CompanyFinanceReport.jsx),
  [CompanyFinanceEntry.jsx](../frontend/src/CompanyFinanceEntry.jsx) et
  [CompanyFinanceDashboard.css](../frontend/src/CompanyFinanceDashboard.css),
  intégrés à [PortusNummarius.jsx](../frontend/src/PortusNummarius.jsx).

Contrôle d’accès : l’authentification existante est requise. Pour
`/api/finance/{company_id}/…`, l’appartenance du couple utilisateur/entreprise
est vérifiée dans `enterprise_members` : 404 si le compte n’est pas membre, 403
pour un rôle autre que `admin` ou `manager`. Un identifiant deviné ne donne
aucun accès. `CompanyProfile.id` reprend l’identifiant de l’entreprise du module
Entreprise, jamais un identifiant d’utilisateur ; aucun profil n’est créé
automatiquement. Plusieurs entreprises coexistent, chacune avec sa devise.

Interface : le rattachement vient de `/api/enterprise/context`. Chaque requête
est limitée à 30 secondes et annulée au changement d’onglet ou de période ; la
fenêtre est réinitialisée lors d’un changement de compte. Un compte sans
entreprise ou sans droits voit un message explicite (« Rattachement
nécessaire », « Accès entreprise ») et un accès direct à la démonstration,
jamais un exemple présenté comme des données réelles.

## Précision des calculs

- Montants, taux et quantités sont des `Decimal`, jamais des flottants. Les
  schémas acceptent des chaînes décimales, des entiers ou des `Decimal` et
  refusent un `float` Python ; l’API lit les nombres JSON directement en
  `Decimal` exact. Un taux `"20"` signifie **20 %**.
- Montants : 2 décimales au plus. Taux, heures, jours : 4 décimales au plus.
- Contexte local de précision 38, arrondi `ROUND_HALF_UP`, indépendant du
  contexte global.
- Résultats : montants au centime ; pourcentages et ratios (couverture, gearing,
  rotation) à 2 décimales ; durées en jours ou en années à 1 décimale.
- SQLite ne garantit pas l’exactitude décimale des colonnes `NUMERIC` :
  `ScaledDecimal` stocke des entiers à échelle fixe et restitue des `Decimal`.
  Aucune division ni conversion flottante SQL sur ces colonnes.
- En sortie, les décimaux sont des **chaînes JSON** et un indicateur indisponible
  vaut `null`. Un client ne doit ni le remplacer par zéro ni recalculer les
  montants en flottants ; l’interface affiche directement les chaînes reçues.

Un script serveur passe par les mêmes fonctions que l’API, afin que la
validation, les conflits et le journal d’audit s’appliquent. Ne pas insérer
directement des objets SQLAlchemy.

```python
from pathlib import Path

from sqlalchemy.orm import Session

from finance_database import get_engine
from finance_entries import create_entry
from ingestion_service import ingest_payload
from schemas.finance import FinanceIngestionSource
from schemas.finance_entries import FinanceEntryKind

with Session(get_engine(), expire_on_commit=False) as session:
    create_entry(session, "identifiant_entreprise", FinanceEntryKind.REVENUES, {
        "date": "2026-01-15", "amount_ht": "1250.00", "vat_rate": "20",
        "payment_method": "TRANSFER", "business_reference": "FACT-2026-001",
    }, actor="script-reprise")
    ingest_payload(
        session, company_id="identifiant_entreprise",
        source=FinanceIngestionSource.BANK_STATEMENT_CSV,
        raw_data=Path("releve-janvier.csv").read_bytes(), actor="script-reprise",
    )
```

## Saisie manuelle

`POST /api/finance/{company_id}/entries/{kind}` (`Content-Type:
application/json`, corps de 64 Kio au plus). Les champs calculés par le serveur
sont refusés en entrée.

| Pièce (`kind`) | Champs | Règles |
|---|---|---|
| Recette (`revenues`) | `date`, `amount_ht`, `vat_rate`, `payment_method` (CASH, CARD, TRANSFER, CHEQUE, OTHER), `business_reference`, `allocation` (FOOD, BEVERAGE, MERCHANDISE, OTHER), `ticket_count`, `hours`, `days` | TTC calculé : HT + TVA arrondie au centime. Un HT négatif enregistre un avoir. |
| Achat (`expenses`) | `date`, `supplier`, `amount_ht`, `vat_rate` **ou** `amount_vat`, `vat_deductible` (vrai par défaut), `category` (MATIERE_PREMIERE, SOUS_TRAITANCE, FOURNITURES, FRAIS_GENERAUX, EQUIPEMENT), `allocation`, `business_reference` | TVA déductible : la TVA entière, ou zéro si `vat_deductible` est faux. Ventilation réservée à MATIERE_PREMIERE. |
| Charge récurrente (`overheads`) | `label`, `category` (RENT, PAYROLL, LOAN, INSURANCE, OTHER), `monthly_amount_ht`, `vat_rate`, `vat_recoverable`, `employer_charges`, `loan_principal`, `active_from`, `active_to` | Pas de TVA sur les salaires ni sur les emprunts ; charges patronales réservées à PAYROLL ; capital réservé à LOAN et au plus égal à la mensualité. |
| Inventaire (`inventories`) | `date`, `allocation` (FOOD, BEVERAGE, MERCHANDISE), `value` | Valeur au coût au début du jour ; un seul par date et par famille ; un stock nul se déclare explicitement. |
| Solde de trésorerie (`cash_balances`) | `date`, `amount` | Solde au début du jour ; un seul par date. |
| Mouvement de trésorerie (`cash_movements`) | `date`, `amount`, `label`, `business_reference` | Positif : encaissement ; négatif : décaissement. |
| Bilan (`balance_sheets`) | `date`, `equity`, `financial_debt`, `inventory`, `trade_receivables`, `trade_payables`, `tax_social_payables`, `cash`, `total_assets` | Un seul par date ; capitaux propres éventuellement négatifs. Le total, facultatif, doit couvrir l’actif saisi (stocks + créances + disponibilités) et le passif saisi. |

- Une erreur de saisie renvoie 422 avec un message en français qui nomme chaque
  champ fautif. Une date déjà occupée (inventaire, solde, bilan) renvoie 409.
- Les saisies manuelles identiques ne sont **pas** dédoublonnées : une recette
  saisie deux fois compte deux fois.
- Une pièce ne se modifie pas : la supprimer (avec confirmation) puis la
  ressaisir. Supprimer une écriture importée retire aussi son lien avec l’import.
- Listes : `GET …/entries/{kind}?start_date=…&end_date=…&limit=…`, 200 pièces par
  défaut, 500 au plus, avec l’indicateur `truncated`. Les charges récurrentes
  sont retenues si elles sont actives sur la période.
- Journal d’audit : `GET …/audit`, 200 derniers événements (`create`, `delete`,
  `import`, `revert`, `profile`) avec auteur, résumé et horodatage UTC.
- Le profil (`GET`/`PUT …/profile`) fixe nom, secteur et devise ; changer de
  devise est refusé (409) dès qu’une pièce existe.

## Imports

`POST /api/finance/{company_id}/ingestions/{source}`, réservé aux membres admin
ou manager. Les relevés bancaires s’importent depuis l’interface ; la caisse
(POS) et l’OCR de factures passent uniquement par l’API.

| Source | `Content-Type` | Crée | Limites |
|---|---|---|---|
| `bank_statement_csv` | `text/csv` | Mouvements de trésorerie | 5 Mio, 5 000 opérations |
| `bank_statement_ofx` | `application/x-ofx` | Mouvements de trésorerie | 5 Mio, 5 000 opérations |
| `pos_webhook` | `application/json` | Recettes | 5 Mio, 5 000 transactions |
| `invoice_ocr` | `application/json` | Achats | 5 Mio, 500 lignes |

Règles communes :

- profil financier requis et devise identique à celle du profil ; corps
  compressés refusés (415) ;
- tout ou rien : le lot, ses écritures, leurs liens et l’événement d’audit sont
  enregistrés dans une seule transaction ;
- en-tête `Idempotency-Key` facultatif (1 à 128 caractères parmi lettres,
  chiffres, `.`, `_`, `:` et `-`). Par défaut : `pos-` + SHA-256 de `event_id`,
  `ocr-` + SHA-256 de `invoice_id`, et le SHA-256 du fichier pour un relevé.
  Même clé et même contenu : le lot existant est renvoyé (`replayed: true`) ;
  même clé et contenu différent : 409 ;
- réponse : `batch_id`, `record_count`, `duplicate_count`, `payload_sha256`,
  `replayed`, `review_required`, `notes` (contrôles) et `warnings` (points à
  vérifier).

### Relevés bancaires CSV et OFX

- Un relevé crée **uniquement** des mouvements de trésorerie signés (débit
  négatif, crédit positif), jamais de recette, d’achat, de HT ou de TVA.
- Les opérations déjà importées sont reconnues et ignorées, ce qui permet
  d’importer des relevés qui se chevauchent. Identité stable : compte, FITID,
  date et montant en OFX ; sinon date, libellé, montant, référence et rang de
  l’occurrence dans le fichier. Si toutes les opérations sont déjà connues : 409
  explicite.
- Les doublons **entre** CSV et OFX ne sont pas détectables : ne pas importer
  une même période dans les deux formats.
- La note de contrôle résume l’import : « Relevé du … au … : n écritures lues —
  débits …, crédits … », plus les lignes ignorées et, en OFX, le solde
  comptable déclaré par la banque (`LEDGERBAL`), utile au rapprochement.
- CSV : UTF-8 (avec ou sans BOM), UTF-16 avec BOM ou Windows-1252 ;
  séparateur `;`, tabulation ou `,` ; en-tête recherché dans les 30 premières
  lignes, 40 colonnes au plus. Colonnes reconnues : date d’opération
  (prioritaire sur la date de valeur), libellé et détail, débit et crédit **ou**
  montant signé (avec une colonne « sens » D/C facultative), référence, devise.
  Lignes de solde, total, sous-total ou report ignorées ; montants nuls
  ignorés. Montants : `1 234,56`, `1.234,56`, `1,234.56`, `12,5` ou `12.5`,
  avec `€` ou `EUR` facultatif. Dates `JJ/MM/AAAA` (année sur deux chiffres
  acceptée) ou `AAAA-MM-JJ`, heure éventuelle ignorée. Classeurs Excel refusés :
  exporter en CSV. Avertissement si une colonne « montant » ne contient aucun
  montant négatif sur au moins 5 opérations.
- OFX/QFX : SGML 1.x ou XML 2.x, un seul compte bancaire (`STMTRS`) ; relevés
  de carte et comptes-titres refusés, ainsi que les opérations en devise
  étrangère.

Le journal des imports (`GET …/ingestions`, 50 derniers lots par défaut, 100 au
plus) indique la source, les écritures importées, les doublons ignorés et les
écritures encore présentes. `DELETE …/ingestions/{batch_id}` supprime ces
écritures, leurs liens et le lot dans une seule transaction et l’inscrit au
journal d’audit ; le même relevé peut ensuite être réimporté.

### Caisse (POS) et factures OCR

- POS : `event_id`, `currency`, `transactions[]` (`transaction_id`, `date`,
  `amount_ht`, `amount_vat`, `amount_ttc`, `vat_rate`, `payment_method`,
  `allocation`, `ticket_count`, `business_reference`), `totals` (`amount_ht`,
  `amount_vat`, `amount_ttc`) et `checksum`. Chaque ligne doit respecter
  HT + TVA = TTC et TVA = HT × taux arrondi au centime ; les totaux déclarés
  doivent égaler la somme des lignes.
- Checksum POS : SHA-256 hexadécimal du JSON canonique de l’enveloppe sans
  `checksum`, telle que normalisée par le schéma (champs facultatifs inclus avec
  leur valeur par défaut, décimaux en chaînes, clés triées, séparateurs compacts,
  UTF-8 non échappé). Envoyer les décimaux en chaînes et tous les champs
  facultatifs rend ce JSON identique à celui transmis.
- Webhook signé `POST /api/finance/{company_id}/webhooks/pos`, sans session :
  `X-Sirius-Timestamp` (secondes Unix, 10 chiffres) et `X-Sirius-Signature:
  sha256=<hex>`, HMAC-SHA-256 de `timestamp + "." + corps brut`, fenêtre de
  cinq minutes. Le secret de l’entreprise (32 octets au moins) se configure dans
  `SIRIUS_FINANCE_POS_SECRET_<20 premiers caractères hexadécimaux en majuscules
  du SHA-256 de company_id>` ; sans lui, la route répond 503. Ce contrat est
  propre à SIRIUS : un pont doit authentifier puis traduire les événements
  natifs Square ou SumUp.
- OCR : `invoice_id`, `supplier`, `date`, `currency`, `lines[]` (`line_id`,
  `amount_ht`, `amount_vat`, `category`, `allocation`, `business_reference`,
  `deductible_vat`), `totals` et `checksum` facultatif. La TVA déductible vaut 0
  tant qu’elle n’est pas confirmée explicitement ; chaque import OCR exige une
  revue humaine (`review_required`).
- Une transaction ou une ligne source déjà importée dans un autre lot fait
  échouer tout le lot (409). Les avoirs sont négatifs, avec une TVA de même
  signe.

## Conventions de calcul

Les périodes sont **inclusives**. Les charges récurrentes sont réparties au
prorata des jours calendaires de chaque mois couvert, en respectant
`active_from` et `active_to`, puis arrondies au centime par charge. « Jours »
désigne le nombre de jours de la période. Un ratio dont le dénominateur est nul
ou négatif vaut `null`.

| Indicateur | Définition |
|---|---|
| CA HT / TTC | Somme des recettes datées dans la période, avoirs déduits |
| Coût d’un achat | TTC − TVA déductible (la TVA non déductible est un coût) |
| Variation de stocks | Σ (stock initial − stock final) des familles inventoriées le premier jour **et** le lendemain du dernier jour ; absente sinon |
| Coûts variables | Matières et marchandises + sous-traitance + fournitures + variation de stocks |
| Charges fixes d’exploitation | Charges récurrentes proratisées hors intérêts et capital (TVA non récupérable incluse) + frais généraux |
| Charges d’exploitation | Coûts variables + charges fixes ; les achats d’équipement (investissements) sont exclus |
| Frais de personnel | Salaires bruts + charges patronales, proratisés |
| Consommations de tiers | Charges d’exploitation − frais de personnel |
| Valeur ajoutée | CA HT − consommations de tiers |
| EBE approché | CA HT − charges d’exploitation = valeur ajoutée − frais de personnel |
| Intérêts d’emprunt | Mensualités − capital remboursé, proratisés |
| CAF approchée | EBE − intérêts (avant impôt sur les sociétés) |
| Annuités | Capital remboursé + intérêts |
| Couverture des annuités | EBE / annuités |
| Autofinancement après annuités | CAF − capital remboursé |
| Taux de marge sur coûts variables | (CA HT − coûts variables) / CA HT |
| Seuil de rentabilité | Charges fixes × CA HT / (CA HT − coûts variables), si le CA et la marge sont positifs |
| Marge et indice de sécurité | CA HT − seuil ; puis rapportée au CA HT |
| Point mort (date) | Premier jour où le CA HT cumulé atteint le seuil ; début de période si le seuil est nul |
| TVA théorique | TVA collectée (TTC − HT des recettes) − TVA déductible (achats + charges récurrentes récupérables) |
| Engagements récurrents | Charges récurrentes HT + charges patronales + TVA, proratisées, mensualités d’emprunt entières |
| Trésorerie d’ouverture | Dernier solde daté au plus tard du premier jour + mouvements datés de ce solde jusqu’à la veille du premier jour |
| Encaissements / décaissements | Mouvements positifs / négatifs datés dans la période |
| Trésorerie de clôture | Ouverture + encaissements − décaissements |
| Trésorerie en jours | Clôture × jours / décaissements, si la clôture est positive ou nulle |

Indicateurs de bilan, tirés du dernier bilan arrêté au plus tard à la fin de
période :

| Indicateur | Définition |
|---|---|
| BFR | Stocks + créances clients − dettes fournisseurs − dettes fiscales et sociales |
| BFR en jours de CA | BFR × jours / CA HT |
| Délai clients | Créances clients × jours / CA TTC |
| Délai fournisseurs | Dettes fournisseurs × jours / (achats TTC hors équipement + loyers, assurances et autres charges récurrentes engagés) |
| Rotation des stocks en jours | Stocks × jours / (achats de matières et marchandises au coût + variation de stocks) |
| Endettement net | Dettes financières − disponibilités |
| Gearing | Endettement net / capitaux propres (indisponible si les capitaux propres sont nuls ou négatifs) |
| Autonomie financière | Capitaux propres / total du bilan, si le total est saisi |
| Capacité de remboursement | Dettes financières / (CAF × 365 / jours) : années de CAF annualisée |

Les délais rapportent un bilan à l’activité de la période choisie : pour une
lecture annuelle classique, choisir les 12 mois qui se terminent à la date du
bilan.

### Stratégies sectorielles

- **Restauration** : coût consommé par famille = stock initial + achats de
  matières ventilés (au coût) − stock final. Food Cost = aliments consommés / CA
  aliments HT ; Beverage Cost = boissons consommées / CA boissons HT ; Prime
  Cost = (aliments + boissons consommés + frais de personnel) / CA HT total.
  Indisponibles, avec un point d’attention, si un inventaire manque, si un achat
  de matières n’est pas ventilé ou si la consommation est négative ; Food et
  Beverage Cost aussi si une recette n’est pas ventilée.
- **BTP** : déboursé sec = matières + sous-traitance (au coût) ; marge et taux de
  marge sur déboursé sec ; tableau par référence devis/chantier (CA, déboursé,
  marge, taux) ; point d’attention pour chaque chantier dont le déboursé dépasse
  le CA de la période ; CA et déboursé sans référence chiffrés à part, avec un
  point d’attention. Ce sont les marges **de la période**, pas une rentabilité
  à terminaison.
- **Commerce** : coût des marchandises consommées (inventaires de
  marchandises), marge commerciale et taux ; rotation = coût consommé / stock
  moyen ((début + fin) / 2), non annualisée ; panier moyen HT = CA HT / nombre de
  tickets, indisponible si une recette n’en indique pas. Compter chaque ticket
  une seule fois, même réparti sur plusieurs taux de TVA (0 sur les autres
  lignes).
- **Services** : taux horaire moyen réel = CA HT / heures ; taux journalier =
  CA HT / jours ; indisponibles si une recette n’indique pas ses heures ou ses
  jours (saisir 0 pour une recette sans temps passé). Charges de structure / CA
  = (charges récurrentes d’exploitation + frais généraux) / CA HT.

### Seuils et points d’attention

Repères bancaires usuels, indicatifs et identiques pour tous les secteurs :

| Indicateur | Repère | Point d’attention |
|---|---|---|
| Couverture des annuités | ≥ 1,2 | sous 1 : `DEBT_SERVICE_NOT_COVERED` (prioritaire) ; sous 1,2 : `DEBT_SERVICE_TIGHT` |
| Intérêts / EBE | ≤ 30 % | `HIGH_FINANCIAL_EXPENSES` |
| Capacité de remboursement | ≤ 4 ans | `LONG_REPAYMENT` ; dette sans CAF positive : `NO_REPAYMENT_CAPACITY` (prioritaire) |
| Gearing | ≤ 1 | `HIGH_GEARING` |
| Autonomie financière | ≥ 20 % | `LOW_EQUITY_RATIO` ; capitaux propres négatifs : `NEGATIVE_EQUITY` (prioritaire) |
| Trésorerie en jours | ≥ 30 jours | `LOW_CASH_DAYS` |
| Ancienneté du bilan | ≤ 18 mois | `BALANCE_SHEET_STALE` ; aucun bilan : `BALANCE_SHEET_MISSING` |

Autres points d’attention :

- prioritaires : `NEGATIVE_EBE`, `NEGATIVE_CASH` ;
- à surveiller : `NO_REVENUE_DATA`, `NO_EXPENSE_DATA`, `NO_OVERHEAD_DATA`,
  `NO_BREAK_EVEN`, `BELOW_BREAK_EVEN`, `MISSING_OPENING_CASH`, ceux des
  stratégies (`MISSING_STOCK_<FAMILLE>`, `INCONSISTENT_STOCK_<FAMILLE>`,
  `UNALLOCATED_PURCHASES`, `UNALLOCATED_REVENUES`, `LOSS_MAKING_PROJECT`,
  `UNALLOCATED_PROJECTS`, `MISSING_TICKET_COUNTS`, `MISSING_HOURS`,
  `MISSING_DAYS`) et `UNAVAILABLE_<INDICATEUR>` pour tout indicateur métier
  indisponible ;
- informations : `DEMO_DATA`, `MANAGEMENT_ESTIMATES` (méthode et périmètre),
  `CASH_LEDGER_ONLY`, `MONTHLY_SERIES_TRUNCATED`.

Pour modifier un repère, changer **ensemble** les constantes de
[kpi_engine.py](kpi_engine.py) (`MIN_DEBT_SERVICE_COVERAGE`,
`MAX_FINANCIAL_EXPENSES_TO_EBE_PCT`, `MAX_DEBT_REPAYMENT_YEARS`, `MAX_GEARING`,
`MIN_EQUITY_RATIO_PCT`, `MIN_CASH_DAYS`, `STALE_BALANCE_SHEET_MONTHS`) et
`THRESHOLDS` dans [companyFinance.js](../frontend/src/companyFinance.js), qui
calcule les statuts affichés.

## Comparaison, évolution mensuelle et rapport

- **Comparaison** (`comparison`) : `year_ago` (même période N-1, choix par défaut
  de l’interface), `previous` (période précédente, défaut de l’API) ou `none`.
  Une période en mois entiers se compare à des mois entiers ; sinon au même
  nombre de jours. Variation en valeur pour tous les indicateurs chiffrés, en
  pourcentage seulement pour les montants dont la référence est positive. Sans
  pièce sur la période de référence, `has_data` vaut faux et l’interface
  n’affiche pas de variations.
- **Évolution mensuelle** : mois calendaires de la période (60 derniers au plus)
  avec CA HT, variation de stocks, EBE, marge d’EBE, CAF, flux net et trésorerie
  de clôture.
- **Rapport « Dossier de gestion »** : synthèse, formation du résultat, cinq
  blocs bancaires, indicateurs métier (et tableau des chantiers), évolution
  mensuelle, comparaison détaillée, points d’attention, méthode et définitions
  de chaque indicateur, et avertissement de non-certification.
- **Export CSV** : `sirius-finance-<entreprise>-<début>_<fin>.csv`, UTF-8 avec
  BOM, point-virgule et virgule décimale, formules neutralisées. En-tête :
  société, secteur, période, comparaison, devise, version de calcul, nature des
  données et date d’export ; puis chaque indicateur du rapport avec sa valeur,
  son unité, la valeur de comparaison, la variation et une note (repère, motif
  d’indisponibilité), suivi des chantiers, de l’évolution mensuelle, des points
  d’attention et de l’avertissement.

## Limites connues

- Pas d’amortissements, d’impôt sur les sociétés ni de résultat net : EBE et CAF
  sont des approximations de gestion, avant IS et éléments exceptionnels.
- Bilan simplifié à 8 postes saisis à la main, sans immobilisations.
- TVA théorique : pas de régime sur les encaissements, de crédit antérieur ni de
  date d’exigibilité. En saisie manuelle, la TVA d’un achat est déductible en
  totalité ou pas du tout.
- Pas de prévisionnel ni de plan de financement.
- Doublons non détectés entre relevés CSV et OFX, ni entre saisies manuelles.
- Une devise par entreprise, aucune conversion ; pas de consolidation.
- Ne pas saisir une charge récurrente une seconde fois comme achat. Le moyen de
  paiement d’une facture ne prouve jamais son règlement : seule la trésorerie
  issue des mouvements fait foi.

## API et exploitation

| Méthode | Route | Usage |
|---|---|---|
| GET | `/api/finance/demo/companies` | Catalogue de la démonstration |
| GET | `/api/finance/demo/{sector}/dashboard` | Tableau fictif (2023 à 2025) |
| GET | `/api/finance/demo/{sector}/entries/{kind}` | Pièces fictives |
| GET | `/api/finance/{company_id}/dashboard` | Tableau de bord |
| GET, PUT | `/api/finance/{company_id}/profile` | Profil financier |
| GET, POST | `/api/finance/{company_id}/entries/{kind}` | Liste et saisie |
| DELETE | `/api/finance/{company_id}/entries/{kind}/{entry_id}` | Suppression |
| GET | `/api/finance/{company_id}/audit` | Journal d’audit |
| GET | `/api/finance/{company_id}/ingestions` | Journal des imports |
| POST | `/api/finance/{company_id}/ingestions/{source}` | Import |
| DELETE | `/api/finance/{company_id}/ingestions/{batch_id}` | Annulation d’un import |
| POST | `/api/finance/{company_id}/webhooks/pos` | Webhook POS signé |

Les tableaux de bord prennent `start_date`, `end_date` (ISO, 10 ans au plus) et
`comparison`. Réponse `FinanceDashboard` : `company`, `period`,
`calculation_version` (`"2"`), `demo`, `common`, `banking`, `specific`
(discriminé par `sector`), `comparison` (`null` sans comparaison), `monthly` et
`alerts` (`code`, `severity` `info`/`warning`/`critical`, `message`).

| Code | Cas |
|---|---|
| 400 | JSON invalide (y compris clé en double, `NaN` ou `Infinity`), encodage non UTF-8, corps vide, `Content-Length` invalide |
| 401 | Non authentifié ; signature ou horodatage du webhook invalide |
| 403 | Rôle autre qu’admin ou manager |
| 404 | Entreprise inaccessible, profil, pièce ou import introuvable |
| 409 | Date déjà occupée, devise verrouillée, clé d’idempotence réutilisée pour un autre contenu, relevé déjà importé, transaction source déjà importée |
| 413 | Corps de plus de 64 Kio (saisie) ou 5 Mio (import) |
| 415 | `Content-Type` inattendu ou corps compressé |
| 422 | Paramètres ou pièce invalides, format, checksum, devise ou totaux d’import incohérents, période inversée ou de plus de 10 ans, démonstration hors 2023-2025 |
| 500 | Données enregistrées incohérentes : erreur journalisée, aucun tableau partiel |
| 503 | Stockage ou vérification des droits indisponible ; webhook POS non configuré |

Exploitation :

- Le registre est `finance.sqlite3` dans `data_dir()` (`SIRIUS_DATA_DIR` s’il est
  défini, sinon le dossier `backend`). Il n’entre pas dans les exports du
  docstore : le sauvegarder séparément, avec la commande `.backup` de SQLite ou
  serveur arrêté.
- `create_all` crée les tables à la première requête mais ne les migre pas :
  toute évolution d’une table déjà déployée exige une migration versionnée.
- `SIRIUS_FINANCE_DEMO_PREWARM` : `1` prépare les démonstrations 30 secondes
  après le démarrage, toute autre valeur les construit à la demande. Par défaut,
  préparation activée sauf dans l’application de bureau empaquetée
  (`SIRIUS_PACKAGED=1`).
- `SIRIUS_FINANCE_POS_SECRET_…` : secret du webhook POS, par entreprise.

Tests, depuis `backend` puis `frontend` :

```powershell
..\.venv\Scripts\python.exe -m pytest tests\test_company_finance.py tests\test_finance_banking.py tests\test_finance_entries.py tests\test_finance_ingestion.py tests\test_finance_bank_statements.py tests\test_finance_demo.py -q
npm test -- --watchAll=false --runInBand src/companyFinance.test.js src/CompanyFinanceDashboard.test.jsx src/CompanyFinanceEntry.test.jsx
```
