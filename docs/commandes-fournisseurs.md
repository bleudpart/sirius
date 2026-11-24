# Portail de commandes multi-fournisseurs

Première version **en mode essai uniquement** : le client compose un panier
contenant des produits de plusieurs fournisseurs et le valide une seule fois.
Le serveur enregistre une commande avec une partie distincte par fournisseur.
**Aucun e-mail n'est envoyé, aucun paiement n'est demandé.** L'envoi réel devra
faire l'objet d'une activation et d'une validation supplémentaires ; le transport
d'e-mail n'est pas encore implémenté dans cette version.

## Les accès

- Gestion associée : ouvrir « Commandes clients — portail multi-fournisseurs »
  dans ΣIRIUS, ou [la gestion web](https://sirius-assistant.fr/commandes/gestion)
  avec le compte ΣIRIUS associé. L'espace se trouve aussi dans PLUTOS.
- Commercial : ouvrir son lien de gestion privé, sans compte ΣIRIUS. Il peut
  gérer les fournisseurs, les grilles, les liens clients et les commandes,
  mais pas créer ou révoquer d'autres liens commerciaux.
- Client : ouvrir le lien privé créé dans la gestion, sans compte ΣIRIUS.

Avec une entreprise configurée, seuls ses administrateurs et gestionnaires
accèdent à sa gestion. Sans entreprise, l'espace est propre au compte connecté.
Les données de ces espaces ne sont pas mélangées. Depuis l'application Windows
en mode relais Cloud, la gestion utilise le compte Cloud lié au poste.

## Portail du commercial

Avec l'accord du commercial, créer son lien depuis « Accès privé du commercial »
dans la gestion associée. Le lien est affiché une seule fois : le conserver et
le transmettre en privé. **Toute personne qui le possède peut gérer les données
du portail**, sans mot de passe ; ne pas le publier. Le compte associé peut le
révoquer sans supprimer les données, puis en créer un nouveau si nécessaire.
Le serveur ne conserve que l'empreinte du secret.

Le commercial et le compte associé voient les mêmes fournisseurs, clients et
commandes : les modifications de l'un sont visibles par l'autre. Le lien cesse
de fonctionner si le compte associé est désactivé, perd ses droits ou son accès.
Le commercial et la gestion associée peuvent renseigner ensemble le nom du
portail ; ce nom apparaît dans l'espace commercial et sur le portail client.

Les interfaces du commercial et des clients sont présentées sans marque ΣIRIUS.
**L'adresse reste provisoirement sur `sirius-assistant.fr`** : aucun domaine
personnalisé n'a encore été choisi ou configuré. Le portail dépend du même
hébergement et du compte associé ; il n'est pas techniquement autonome.

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
`b2b_suppliers`, `b2b_clients`, `b2b_orders` et `b2b_portal_settings` font partie
des sauvegardes entreprise. Les liens commerciaux ne sont pas inclus ni restaurés :
une restauration ne réactive donc pas un lien révoqué. Lors d'une restauration
sur une nouvelle base, il faut créer de nouveaux liens commerciaux.
Toutes ces collections, dont `b2b_manager_links`, font partie de l'examen manuel
préalable à la suppression d'un compte.
