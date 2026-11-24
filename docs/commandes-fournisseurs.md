# Portail de commandes multi-fournisseurs

Première version **en mode essai uniquement** : le client compose un panier
contenant des produits de plusieurs fournisseurs et le valide une seule fois.
Le serveur enregistre une commande avec une partie distincte par fournisseur.
**Aucun e-mail n'est envoyé, aucun paiement n'est demandé.** L'envoi réel devra
faire l'objet d'une activation et d'une validation supplémentaires ; le transport
d'e-mail n'est pas encore implémenté dans cette version.

## Les deux accès

- Gestion : ouvrir « Commandes clients — portail multi-fournisseurs » dans ΣIRIUS,
  ou [la gestion web](https://sirius-assistant.fr/commandes/gestion), connecté
  au compte du commercial. L'espace se trouve aussi dans PLUTOS.
- Client : ouvrir le lien privé créé dans la gestion. Il pointe vers
  `/commandes#k=...`, sans compte ΣIRIUS pour le client.

Avec une entreprise configurée, seuls ses administrateurs et gestionnaires
accèdent à sa gestion. Sans entreprise, l'espace est propre au compte connecté.
Les données de ces espaces ne sont pas mélangées. Depuis l'application Windows
en mode relais Cloud, la gestion utilise le compte Cloud lié au poste.

## Préparer les fournisseurs et importer les grilles

1. Ajouter chaque fournisseur : nom, e-mail facultatif pour le moment et base
   de prix HT ou TTC. Il n'y a pas de produits ni de prix fictifs préchargés.
2. Ouvrir « Configurer » pour renseigner les articles manuellement ou charger
   un CSV UTF-8. Télécharger le modèle vide depuis la gestion.
3. Vérifier les lignes affichées, puis enregistrer le fournisseur et sa grille.
   Charger un CSV ne sauvegarde rien ; enregistrer remplace sa grille actuelle.

Colonnes obligatoires : `reference;nom;unite;prix`.
Le séparateur virgule est également accepté ; les prix à virgule décimale doivent
alors être entourés de guillemets. Les prix sont exprimés en EUR, avec jusqu'à
quatre décimales. Une référence doit être unique dans la grille ; l'unité
correspond au conditionnement effectivement vendu (kg, litre, carton...).
Une grille est limitée à 500 produits et un espace à 100 fournisseurs.
Les quantités et prix manquants ou invalides sont refusés, pas remplacés par zéro.

Les montants des lignes sont arrondis au centime (demi supérieur), puis additionnés.
Les montants HT et TTC restent séparés : TVA et frais de livraison ne sont pas
calculés. Le serveur fixe les prix à partir de la grille, jamais depuis le panier
transmis par le navigateur. Un changement de tarifs impose une nouvelle lecture
et une vérification du panier. Les commandes déjà enregistrées gardent leurs prix.

## Accès clients et essais

Créer un lien par client et le transmettre en privé. **Chaque lien permet de voir
toutes les grilles de l'espace** : les tarifs individualisés par client ne sont
pas encore gérés. Le lien est un secret d'accès, affiché une seule fois ;
le serveur n'en conserve que l'empreinte. Un lien perdu peut être révoqué puis
remplacé par un nouvel accès. La révocation ne supprime pas les commandes.
L'accès dépend aussi du compte du commercial et de ses droits actuels.

Le client indique les quantités, son contact et l'adresse de livraison, vérifie
le panier, puis valide la commande **d'essai**. Les commandes des autres clients
et la gestion ne sont pas accessibles avec ce lien.

En cas de réponse interrompue, la demande reste dans le stockage de session du
navigateur. « Réessayer la même validation » réutilise son identifiant :
un nouvel essai identique ne crée pas une seconde commande. Ne pas effacer ce
stockage ni changer de navigateur pour contourner une validation incertaine.
Le stockage de session doit être disponible pour valider.
Si sa remise à zéro échoue après confirmation, le reçu reste affiché et une
nouvelle commande est bloquée : conserver sa référence et contacter le commercial.

Dans la gestion, ouvrir la commande enregistrée puis télécharger le message `.eml`
de chaque fournisseur. Ce fichier porte une mention d'essai et ne contient que
ses produits. Le téléchargement **n'envoie pas le message**. Éviter de l'envoyer
manuellement comme une commande réelle.

Les données utilisent le docstore MongoDB ou SQLite existant. Les collections
`b2b_suppliers`, `b2b_clients` et `b2b_orders` font partie des sauvegardes entreprise
et de l'examen manuel préalable à la suppression d'un compte.
