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
