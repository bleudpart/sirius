# Briefing du jour et veille locale

« Mon briefing », « Lis le briefing » et le Réveil matinal lisent
`GET /api/work-dossiers/briefing`. Le rapport reste en **lecture seule** : il
n'envoie aucun message, ne termine aucune tâche et ne déclenche aucune action.

## Contenu, dans l'ordre de lecture

1. **HACCP** : étiquettes enregistrées et impressions confirmées aujourd'hui,
   priorités du jour et bilan d'hier recalculé à la demande (même calcul que
   HACCP > Fin de service). Les contrôles physiques restent humains.
2. **Agenda** : rendez-vous du jour des agendas Google et Outlook connectés
   (5 au plus, le reste est compté).
3. **Dossiers de travail** : contenu historique du briefing (dossiers,
   engagements, propositions métier non approuvées).
4. **Veille locale** (facultative) : météo de l'établissement, événements
   naturels et séismes à moins de 300 km, repères de marché.

Chaque section a un délai de 7 secondes et des sources indépendantes. Une
source refusée, absente ou en panne produit une ligne explicite
(« Source indisponible … Aucune valeur remplacée. »), jamais une valeur
estimée. La réponse JSON contient aussi ces sections sous la clé `daily`.

## Réglage de la veille

Dans **Réveil matinal**, section « Veille locale du briefing » :

- indiquer la ville de l'établissement, puis cocher « Ajouter la veille au
  briefing du jour » ;
- choisir les sources : météo locale, événements naturels et séismes, repères
  de marché ;
- « Tester la veille » affiche exactement le texte qui sera ajouté.

Les réglages sont propres à chaque compte (`GET`/`PUT /api/veille/settings`,
aperçu `GET /api/veille`). La ville est géocodée une fois par Open-Meteo ;
le nom et le pays retenus sont affichés pour vérification, car une commune
homonyme peut être choisie. Les réglages sont inclus dans l'export et la
suppression du compte.

## Sources et confidentialité

| Section | Fournisseur | Ce qui est envoyé |
| --- | --- | --- |
| Météo locale | Open-Meteo | nom de la ville (géocodage), puis coordonnées |
| Événements naturels | OSIRIS (NASA EONET, NOAA/NWS) | rien : flux mondial filtré par ΣIRIUS |
| Séismes | OSIRIS (USGS), magnitude 3 et plus, 7 derniers jours | rien : flux mondial filtré par ΣIRIUS |
| Repères de marché | OSIRIS : Brent, blé (Chicago), euro/dollar | rien |

OSIRIS (<https://www.osirisai.live>) est un agrégateur public sous licence MIT ;
ΣIRIUS ne lit que ses flux JSON, sans clé ni IA, avec un cache de 10 minutes
(1 minute après une panne). Les réponses de plus de 1 Mo, illisibles ou plus
anciennes que 6 heures (5 jours pour les cours) sont refusées.

## Limites à connaître

- Les alertes NOAA/NWS couvrent les **États-Unis** et NASA EONET ne recense que
  les événements majeurs : la **vigilance Météo-France n'est pas incluse**, le
  briefing le rappelle.
- Les repères de marché sont des cours internationaux, **pas vos tarifs
  fournisseurs**.
- La mention de chaleur (30 °C et plus) vient de la prévision : elle rappelle de
  surveiller les relevés des enceintes froides, elle ne remplace aucun relevé.
- Sur le serveur Cloud, le registre HACCP local du PC n'est pas lisible : le
  briefing l'indique au lieu d'afficher des chiffres.

## Configuration

`OSIRIS_BASE_URL` (facultatif) remplace `https://www.osirisai.live`, par exemple
pour une instance OSIRIS auto-hébergée. Seul `https` est accepté, ou `http`
vers `localhost`/`127.0.0.1`.

## Cartographie des événements OSIRIS

Le module **CARTOGRAPHIE** (groupe OUTILS, ou « Zirius, ouvre la carte OSIRIS »)
affiche dans ΣIRIUS une carte native des événements naturels et des séismes
lus dans les flux OSIRIS. Le site OSIRIS interdit son intégration en iframe
(`X-Frame-Options: SAMEORIGIN`) ; le bouton « Carte OSIRIS complète » l'ouvre
dans un onglet séparé.

- Données : `GET /api/veille/carte` (session requise), jusqu'à 2 000 points,
  triés par distance puis gravité. Le même cache de 10 minutes que le briefing
  est utilisé.
- Centre : la ville réglée dans la veille (géocodée par Open-Meteo), même si la
  veille du briefing est désactivée. Sans ville, la carte reste mondiale et le
  filtre de rayon est désactivé.
- Filtrage géographique : rayon de 50, 100, 300 ou 1 000 km (300 km par
  défaut) ou monde entier, et case « Zone visible uniquement » qui limite la
  fenêtre flottante aux événements affichés à l'écran.
- Fenêtre flottante : les 30 événements les plus proches ; un clic centre la
  carte et ouvre la fiche ; un clic sur le titre de la fenêtre lit le résumé.
- Confidentialité : aucune position n'est transmise à OSIRIS. Les tuiles du
  fond de carte proviennent d'OpenStreetMap (`tile.openstreetmap.org`), qui
  reçoit l'adresse IP et la zone affichée. Les coordonnées de la ville ne sont
  renvoyées qu'à l'utilisateur connecté et n'apparaissent pas dans le briefing.
- Mêmes limites que le briefing : NOAA/NWS couvre les États-Unis et la
  vigilance Météo-France n'est pas incluse.

### Calques complémentaires : aviation, espace et géopolitique

Les calques **Avions**, **Satellites**, **Zones de conflit** et **Actualités
internationales** sont désactivés à l'ouverture. Les activer charge les flux
publics OSIRIS correspondants uniquement pour la zone visible et le rayon
choisi. Sans ville, seul le filtre de zone visible s'applique.

- Les avions proviennent des données OpenSky / ADS-B agrégées par OSIRIS.
  Leur couverture et leur fraîcheur varient ; l'heure affichée est celle du
  flux, pas nécessairement celle de la dernière position de chaque avion.
- Les positions des satellites sont **calculées et approximatives**. Le rayon
  et la distance correspondent au point situé sous le satellite sur Terre,
  pas à la distance jusqu'au satellite.
- Les zones de conflit sont des **repères indicatifs** sélectionnés par OSIRIS :
  ce ne sont ni des frontières ni des délimitations précises. Leur présence,
  leur absence et la date du flux ne certifient pas la situation actuelle.
- Les actualités sont des publications de presse et de sources OSINT ; elles
  ne sont pas vérifiées par ΣIRIUS. La localisation peut être approximative,
  notamment un simple point associé à un pays. Les publications sans lien
  HTTPS ou sans localisation exploitable, et celles de plus de sept jours, ne
  sont pas affichées. Les titres peuvent rester dans la langue de la source.
- La carte est informative et **ne doit pas être utilisée pour la navigation,
  la sécurité ou une décision opérationnelle**. Consulter et recouper les
  sources officielles.
- Chaque calque affiche au maximum 500 points dans la zone et le rayon
  sélectionnés, avec le nombre total et une mention en cas de limitation.
  Zoomer permet d'explorer une zone plus petite. Les calques actifs sont
  actualisés toutes les minutes lorsque la page est visible ; les caches
  OSIRIS et ΣIRIUS peuvent conserver un même instantané plus longtemps.
  Toute source vide, périmée ou indisponible est signalée, sans donnée inventée.
- Pour filtrer les nouveaux calques, la zone visible et le rayon sont envoyés
  à l'API ΣIRIUS, locale ou distante selon la configuration. Aucune ville,
  position ou zone visible n'est envoyée à OSIRIS ; le fond OpenStreetMap
  reçoit toujours l'adresse IP et la zone affichée.
- Les navires sont reportés : lors de la vérification du 3 novembre 2026,
  le flux maritime public d'OSIRIS ne renvoyait aucune position AIS.

## HERACLES : recherches passives de domaine

La commande vocale « Zirius, analyse ce domaine » ouvre HERACLES ; un domaine
prononcé à la suite est prérempli. L’utilisateur doit confirmer qu’il possède
le domaine ou est autorisé à le vérifier avant d’ouvrir les sources choisies.
La première version prépare des recherches sur crt.sh, Shodan, Censys et,
facultativement, le tableau de bord Have I Been Pwned. Le domaine est transmis
directement aux fournisseurs sélectionnés dans leur URL, pas à l’API ΣIRIUS.
HIBP n’accepte que les domaines dont le contrôle a été vérifié par leur
propriétaire ; Shodan/Censys peuvent imposer une connexion ou des limites.

ΣIRIUS ne lance pas de scan actif, n’exécute pas theHarvester et ne présente
pas l’ouverture d’un lien comme un résultat d’analyse. Roso.info et
Fingerprint.to ciblent des identifiants de personnes, pas la recherche de
domaine : ils ne sont pas inclus dans ce parcours. La carte OSIRIS s’ouvre
dans un onglet séparé (le site interdit actuellement l’intégration en iframe).
