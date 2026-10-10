# Configurer SIRIUS simplement

## Commencer sans chercher de clés

Connectez-vous à votre compte SIRIUS. Votre essai dure **7 jours à partir
de la première activation du compte**, avec des limites quotidiennes.
Pendant cet essai, les services autorisés utilisent les clés du serveur :
vous n'avez pas à les connaître, les copier ou les demander.

La disponibilité dépend des services effectivement configurés. Une fonction
facultative absente n'empêche pas d'utiliser les autres fonctions.
Les limites quotidiennes sont visibles dans **Configuration → Clés API et services**.
Se déconnecter ou réinstaller l'application ne recommence pas l'essai.

> **Important : après ces 7 jours, les services en ligne qui utilisent les
> clés de SIRIUS ne fonctionneront plus avec ces clés. Pour continuer à
> utiliser ces services, la configuration de vos propres clés devient
> obligatoire. Préparez-la avant la fin de l'essai pour éviter une interruption.**
>
> Vos dossiers et les outils réellement locaux restent accessibles.
> Vous n'avez pas à configurer toutes les clés : seulement celles des
> services que vous souhaitez continuer à utiliser.

## Après l'essai : vos clés, votre configuration

Vous pouvez préparer vos clés avant la fin de l'essai.
La **page de configuration** s'ouvre avec le bouton **Réglages**
(icône de réglages du profil) dans le HUD, puis l'onglet **CLÉS API ET SERVICES**, ou le bouton **GÉRER MES CLÉS API** dans **PROFIL**.

1. Ouvrez **Configuration → Clés API et services**.
2. Choisissez les services dont vous avez besoin. Pour discuter, commencez
   par la clé **Groq** ; les autres services sont facultatifs.
3. Cliquez sur **obtenir** à côté du service. Sur le site du fournisseur,
   créez votre compte et votre clé, puis copiez-la dans le champ correspondant.
4. Cliquez sur **TESTER**. Un résultat refusé, un quota atteint ou un problème
   de connexion doit être résolu avant de considérer le service utilisable.
5. Choisissez un **mot de passe de coffre d'au moins 12 caractères**,
   confirmez-le et cliquez sur **Protéger et enregistrer**.

SIRIUS chiffre et enregistre les clés sur cet appareil. Il n'est pas nécessaire
de modifier du code, des fichiers `.env` ou des variables d'environnement.
Les champs de clés ne sont pas sauvegardés par le simple bouton général
**ENREGISTRER** : utilisez bien **Protéger et enregistrer**.

> Les fournisseurs peuvent demander une validation de compte, l'activation
> d'une API ou un moyen de paiement. Consultez leurs tarifs et leurs quotas.
> SIRIUS ne crée pas automatiquement leurs comptes ni leurs clés.

## Restaurer automatiquement une configuration déjà préparée

Si vous possédez un fichier **sirius.vault**, vous n'avez pas à recopier les
clés une par une :

1. Ouvrez **Clés API et services** et sélectionnez **Importer un coffre chiffré**.
2. Choisissez votre fichier, puis saisissez le mot de passe de ce coffre.
3. Cliquez sur **Déverrouiller et confirmer l'import**. Relisez la liste des
   services avant de confirmer le remplacement du coffre de votre compte
   sur cet appareil.

Les champs sont remplis et les clés deviennent utilisables pour cette session.
L'import ne modifie pas les clés du serveur, les autres comptes ou votre rôle.
Après import, testez les services : une clé peut avoir expiré depuis l'export.

## À la prochaine ouverture

Les clés restent chiffrées sur l'appareil. Dans **Clés API et services**,
saisissez le mot de passe du coffre et cliquez sur **Déverrouiller**.
Vous n'avez pas à saisir à nouveau toutes vos clés.

**Verrouiller** retire les clés déverrouillées de la session sans supprimer
le coffre. La déconnexion ou le changement de compte les verrouille également.

## Sauvegarder ou changer d'appareil

Cliquez sur **Exporter le coffre** après avoir protégé et enregistré vos clés.
Conservez le fichier **sirius.vault** et son mot de passe séparément.
Sur le nouvel appareil, connectez-vous à votre compte et importez ce fichier.

Le fichier de profil `.json` contient uniquement des informations de profil :
**il ne contient pas vos clés**. Il ne remplace pas le coffre.

## Si vous aviez déjà enregistré des clés dans l'ancienne version

Utilisez **Migrer mes anciennes clés** sur votre appareil personnel.
Confirmez que ces clés vous appartiennent, vérifiez les champs et cliquez
sur **Protéger et enregistrer**.
L'ancienne copie dans le stockage du navigateur est alors retirée.
Les anciens exports JSON ne sont pas automatiquement supprimés : protégez
ou supprimez vous-même ces anciennes copies.

## Comprendre les résultats sans fausse promesse

- **Configuré** : le serveur indique qu'un service est renseigné ; cela ne
  prouve pas qu'une demande réelle réussira.
- **Réponse IA testée** : le test a obtenu une réponse du fournisseur.
- **Micro testé** : un enregistrement d'essai a été transcrit.
- **Voix audible** : vous avez confirmé avoir entendu la phrase d'essai.

Les tests de fournisseurs peuvent consommer une petite partie de leurs quotas.
Le micro n'est testé qu'après votre action et votre autorisation.

Pendant l'essai, votre clé personnelle remplace celle de SIRIUS uniquement
pour le fournisseur concerné. Ajouter une clé de bourse ne coupe donc pas
l'essai des réponses IA. Une clé personnelle refusée ne déclenche pas un
repli vers la clé de SIRIUS du même fournisseur.

Décocher un service masque son champ sans supprimer la clé renseignée.
Pour retirer une clé du coffre, videz le champ et enregistrez à nouveau
le coffre protégé.

Tous les modules n'ont pas encore de connecteur à clés personnelles :
les actualités, la météo, les fiches pays et Europeana qui dépendent de la
configuration du serveur peuvent rester bloqués après l'essai.
Le coffre ne crée pas automatiquement un connecteur manquant.

## Protéger vos clés et votre mot de passe

Le coffre utilise un chiffrement authentifié. Son mot de passe est distinct
du mot de passe du compte SIRIUS ; **il n'est pas récupérable dans l'application**.
Une copie du coffre avec un mot de passe perdu peut devenir inutilisable.
Vous pouvez alors recréer vos clés chez les fournisseurs et un nouveau coffre.

Après déverrouillage, les clés personnelles sont transmises au backend SIRIUS
pour appeler les services choisis. Utilisez uniquement une installation et un
serveur de confiance. Le chiffrement protège le fichier enregistré ; il ne
rend pas sûr un appareil compromis.

La carte Google Maps constitue un cas particulier : sa clé est utilisée
par le composant cartographique dans le navigateur, et peut donc y être
observée pendant l'utilisation. Elle doit être une clé personnelle adaptée
à cet usage et restreinte dans Google Cloud, jamais une clé secrète partagée
du propriétaire. La carte OpenStreetMap reste une alternative sans cette clé.

Le coffre n'accorde **aucun droit administrateur**. L'administration dépend
du rôle de votre compte authentifié, géré séparément côté serveur.

## En cas de difficulté

| Message ou situation | Que faire |
|---|---|
| Essai terminé | Configurez vos clés personnelles ou déverrouillez votre coffre. |
| Limite quotidienne atteinte pendant l'essai | Attendez la remise à zéro à minuit UTC ou utilisez vos clés personnelles. |
| Clé refusée | Vérifiez le fournisseur, la copie complète de la clé et l'activation du service. |
| Fournisseur indisponible | Réessayez plus tard ; changer le mot de passe du coffre ne résout pas une panne réseau. |
| Mot de passe incorrect ou coffre altéré | Vérifiez le mot de passe et essayez une sauvegarde intacte. |
| Aucun coffre enregistré | Importez votre sauvegarde ou créez et protégez une nouvelle configuration. |
| Service facultatif non configuré | Ignorez-le si vous n'en avez pas besoin. |

**Le parcours le plus court : essayer SIRIUS → créer uniquement les clés utiles
→ les tester → protéger une fois le coffre → le déverrouiller aux prochaines sessions.**

---

## Où obtenir les clés et connecter vos comptes

**Une clé API se crée dans le compte du fournisseur : elle ne se télécharge
pas comme un logiciel.** Une connexion à une boîte mail ou à Spotify utilise
au contraire une page d'autorisation officielle, appelée **OAuth**.
Ne collez pas votre mot de passe Gmail, Microsoft ou Spotify dans un champ
de clé API de SIRIUS.

Les adresses ci-dessous sont celles des fournisseurs. Le nom de certains
boutons peut changer. Vérifiez les tarifs, les droits demandés et les limites
dans votre propre compte.

### Choisir sans tout configurer

| Votre besoin | Fournisseur | Où aller | Dans SIRIUS |
|---|---|---|---|
| Réponses IA et transcription Groq | Groq | [Console Groq — clés](https://console.groq.com/keys) | Clé Groq |
| Réflexion approfondie | Kimi / Moonshot | [Console Moonshot](https://platform.moonshot.cn/console/api-keys) | Clé Kimi K3 |
| Recherche Web par API | SerpAPI | [Ma clé SerpAPI](https://serpapi.com/manage-api-key) | Clé SerpAPI |
| Génération vidéo | fal.ai | [Clés fal.ai](https://fal.ai/dashboard/keys) | Clé fal.ai |
| Carte Google LOCUS | Google Maps Platform | [Identifiants Google Cloud](https://console.cloud.google.com/apis/credentials) | Clé Google Maps JavaScript API |
| Informations boursières | Alpha Vantage | [Créer une clé Alpha Vantage](https://www.alphavantage.co/support/#api-key) | Clé Alpha Vantage |
| Lecture vocale Google Cloud | Google Cloud Text-to-Speech | [Console Google Cloud](https://console.cloud.google.com/) | Clé Google TTS, si acceptée par le service |
| Lecture vocale Gemini | Google AI Studio | [Clés Gemini](https://aistudio.google.com/apikey) | Clé Gemini TTS |
| Gmail et agenda Google | Google | [Compte Google](https://accounts.google.com/) | Centre des connexions → Google |
| Outlook, Hotmail, Microsoft 365 | Microsoft | [Compte Microsoft](https://account.microsoft.com/) | Centre des connexions → Microsoft |
| Musique Spotify | Spotify | [Spotify](https://open.spotify.com/) | Lecteur Spotify → CONNECTER SPOTIFY |
| Lecture de vidéos YouTube | YouTube | [YouTube](https://www.youtube.com/) | Lecteurs multimédias ; pas de clé YouTube à importer |
| Facebook / Instagram / X | Meta / X | Voir les sections ci-dessous | Pas de connecteur API prêt à configurer dans ce coffre |

### 1. Groq : commencer par l'essentiel

1. Ouvrez [console.groq.com/keys](https://console.groq.com/keys).
2. Créez votre compte ou connectez-vous, puis ouvrez **API Keys**.
3. Créez une nouvelle clé et donnez-lui un nom, par exemple « Mon SIRIUS ».
4. Copiez la clé complète dans **Clé Groq** sur la page **Clés API et services**.
5. Cliquez sur **TESTER**, puis protégez et enregistrez le coffre.

Ne confondez pas cette clé avec celle de Kimi. Pour commencer, il n'est
pas nécessaire de configurer tous les fournisseurs.
[Documentation officielle Groq](https://console.groq.com/docs/quickstart).

### 2. Kimi / Moonshot : fonction facultative

1. Ouvrez la [console Moonshot](https://platform.moonshot.cn/console/api-keys)
   et créez ou connectez votre compte.
2. Dans **API Keys**, créez une clé personnelle et copiez-la.
3. Sélectionnez le service de réflexion approfondie dans SIRIUS.
4. Collez la clé dans **Clé Kimi K3**, testez puis enregistrez le coffre.

**Attention aux régions :** la plateforme internationale propose aussi
[platform.kimi.ai](https://platform.kimi.ai/console/api-keys).
Une clé doit correspondre à l'adresse du service configurée sur le backend.
Si vous utilisez la plateforme internationale et que le test est refusé,
demandez à l'administrateur de vérifier cette compatibilité ; ne changez pas
au hasard les champs Groq et Kimi.
[Documentation officielle Kimi](https://platform.kimi.ai/docs/overview.md).

### 3. SerpAPI : recherches sur le Web

1. Ouvrez [serpapi.com](https://serpapi.com/) et créez votre compte.
2. Connectez-vous à [la page de votre clé](https://serpapi.com/manage-api-key).
3. Copiez la clé privée de votre compte.
4. Dans SIRIUS, sélectionnez **recherche web**, renseignez **Clé SerpAPI**,
   testez puis enregistrez le coffre.

Le nombre de recherches dépend de votre offre SerpAPI. Ne publiez pas votre clé.

### 4. fal.ai : génération de vidéos

1. Créez ou ouvrez votre compte sur [fal.ai](https://fal.ai/).
2. Vérifiez les prix des modèles et le crédit disponible avant de générer.
3. Dans [les clés du tableau de bord](https://fal.ai/dashboard/keys),
   créez une clé avec les permissions nécessaires aux appels de modèles
   (préréglage **API** lorsque proposé).
4. Copiez la clé dans **Clé fal.ai**, cliquez sur **TESTER** et protégez le coffre.

Si fal.ai ne permet pas de confirmer la clé pour le moment, SIRIUS indique
**non vérifiable** et demande votre accord avant de l'enregistrer chiffrée.
Cet accord ne transforme pas le test en réussite : retestez le service ensuite.
Une clé explicitement refusée n'est pas enregistrée.

La création d'une vidéo peut être facturée. Une vérification de clé réussie
ne garantit ni crédit suffisant ni accès à tous les modèles.
[Authentification officielle fal.ai](https://fal.ai/docs/documentation/setting-up/authentication/index.md).

### 5. Google Maps : affichage de la carte LOCUS

1. Connectez-vous à [Google Cloud](https://console.cloud.google.com/).
2. Choisissez ou créez un projet dédié à votre usage.
3. Dans la bibliothèque des API, activez **Maps JavaScript API**
   pour l'affichage de la carte ; vérifiez les conditions de facturation.
4. Dans **API et services → Identifiants**, créez une clé API et configurez
   les restrictions de sites/origines compatibles avec votre application.
   N'enlevez pas ces restrictions pour tenter de réussir un test serveur.
5. Collez-la dans **Clé Google Maps**, puis protégez le coffre en confirmant
   son stockage comme **non vérifiée**. Testez ensuite l'ouverture de la
   carte LOCUS : le backend ne peut pas vérifier une clé de carte navigateur.

La recherche d'adresses n'est pas opérationnelle dans la version actuelle,
même avec une clé. Cette clé ne répare pas un connecteur manquant.
OpenStreetMap reste une alternative pour afficher une carte sans clé Google.
N'activez pas ce service si vous n'en avez pas besoin.
[Documentation Maps JavaScript API](https://developers.google.com/maps/documentation/javascript/get-api-key).

### 6. Alpha Vantage : informations boursières

1. Ouvrez [le formulaire officiel](https://www.alphavantage.co/support/#api-key).
2. Renseignez les informations demandées, notamment une adresse e-mail valide.
3. Récupérez la clé proposée par le fournisseur.
4. Collez-la dans **Clé Alpha Vantage**, testez et enregistrez le coffre.

Certaines données et fréquences nécessitent une offre spécifique.
La clé ne donne pas accès sans limite à toutes les informations.
[Documentation Alpha Vantage](https://www.alphavantage.co/documentation/).

### 7. Lecture vocale : Google TTS et Gemini TTS ne sont pas la même clé

Vous pouvez utiliser la lecture locale du téléphone ou du navigateur sans
activer ces deux services cloud.

**Google Cloud Text-to-Speech**

1. Dans [Google Cloud](https://console.cloud.google.com/), choisissez votre projet.
2. Activez **Cloud Text-to-Speech API** et vérifiez la facturation.
3. Consultez [les méthodes d'authentification prises en charge](https://cloud.google.com/text-to-speech/docs/authentication).
4. Si votre configuration autorise une clé API pour cet usage, créez une clé
   adaptée et renseignez **Clé Google TTS** dans SIRIUS.
5. Testez-la. Si le fournisseur exige une autre méthode d'authentification,
   ne collez pas un fichier de compte de service dans ce champ :
   utilisez la voix locale ou demandez l'aide de l'administrateur.

**Gemini TTS**

1. Ouvrez [Google AI Studio — clés](https://aistudio.google.com/apikey).
2. Connectez-vous et créez une clé dans le projet souhaité.
3. Vérifiez l'accès à la génération audio, les quotas et la facturation.
4. Collez-la dans **Clé Gemini TTS**, testez puis protégez le coffre.
5. Faites ensuite un essai de lecture et confirmez que vous entendez la phrase.

Les clés Gemini ont leurs propres restrictions et règles d'accès.
[Documentation officielle des clés Gemini](https://ai.google.dev/gemini-api/docs/api-key).

### 8. Gmail et Google Agenda : autoriser votre compte, pas copier un secret

1. Dans SIRIUS, ouvrez **Centre des connexions**.
2. Choisissez **Google**, puis cliquez sur le bouton de connexion.
3. Une page Google s'ouvre : sélectionnez votre propre compte Gmail.
4. Relisez les autorisations demandées. Autorisez seulement si vous souhaitez
   utiliser ces fonctions et faites confiance à cette installation de SIRIUS.
5. Revenez dans SIRIUS et vérifiez l'indication **Connecté**. Si nécessaire,
   utilisez l'action de vérification proposée dans le centre.
6. Pour retirer l'accès, utilisez **Déconnecter** et, si souhaité, révoquez
   l'autorisation dans [les connexions de votre compte Google](https://myaccount.google.com/connections).

**Si Google refuse la connexion :** le connecteur doit d'abord être configuré
et autorisé par l'administrateur de l'installation. En mode test, il peut
falloir ajouter votre compte à la liste des utilisateurs autorisés.
Une clé Google Maps ou Gemini ne remplace pas cette autorisation Gmail.

Pour l'administrateur uniquement : préparer le projet Google Cloud,
activer les API nécessaires (Gmail et Calendar), configurer l'écran de
consentement OAuth et les adresses de retour exactes de SIRIUS.
Les identifiants OAuth de l'application restent côté serveur, pas dans
le coffre personnel de l'utilisateur.
[Autorisations Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes).

### 9. Outlook, Hotmail et Microsoft 365

1. Dans **Centre des connexions**, choisissez **Microsoft**.
2. Lancez la connexion ; la page Microsoft vous demande votre compte personnel
   ou professionnel.
3. Connectez-vous sur cette page officielle et effectuez la vérification
   supplémentaire de Microsoft si elle est demandée.
4. Relisez les autorisations et confirmez celles nécessaires.
5. Revenez dans SIRIUS et vérifiez l'indication **Connecté**.
6. Utilisez **Déconnecter** pour retirer la connexion de cette installation.

Pour un compte professionnel, votre organisation peut bloquer les applications
externes ou exiger l'accord de son administrateur.
Le connecteur doit accepter le type de compte utilisé.

Pour l'administrateur de SIRIUS uniquement : l'application doit être enregistrée
dans [Microsoft Entra](https://entra.microsoft.com/), avec les types de comptes,
adresses de retour et permissions Microsoft Graph correspondant aux fonctions
réellement utilisées.
[Guide officiel d'enregistrement](https://learn.microsoft.com/en-us/graph/auth-register-app-v2).
L'utilisateur ne doit pas créer un secret OAuth ni le coller dans **Clé Groq**.

### 10. Spotify

1. Ouvrez le lecteur **Spotify** de SIRIUS.
2. Cliquez sur **CONNECTER SPOTIFY**.
3. Connectez-vous sur la page Spotify officielle et relisez l'autorisation.
4. Revenez dans le lecteur ; recherchez un titre ou un artiste.
5. Choisissez un résultat pour le lecteur intégré.
6. Pour piloter un appareil Spotify, ouvrez Spotify sur cet appareil :
   la lecture à distance nécessite un appareil disponible et un compte
   compatible, notamment **Premium** pour ces fonctions.

Les lecteurs intégrés peuvent proposer un extrait plutôt que la lecture
complète selon votre connexion Spotify et les règles du fournisseur.

Si l'autorisation fonctionne mais que les appels sont refusés, l'application
Spotify peut être en mode développement : le compte utilisateur doit alors
être autorisé dans la liste de l'application.
Selon [les règles officielles du mode de quota](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
consultées, le propriétaire d'une application en mode développement doit
avoir Premium, et l'application est limitée à cinq utilisateurs autorisés.
Ces règles peuvent évoluer.

Pour l'administrateur uniquement : créer/configurer l'application dans
[Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
renseigner l'adresse de retour exacte et les utilisateurs autorisés.
Le **Client Secret Spotify** n'est pas une clé à importer dans le coffre
de l'utilisateur.

### 11. YouTube

**Pour regarder ou écouter avec les lecteurs officiels :**

1. Ouvrez une vidéo YouTube via les fonctions multimédias de SIRIUS.
2. Lancez la lecture dans le lecteur officiel.
3. Si YouTube l'exige, connectez-vous à YouTube dans le contexte du lecteur
   ou ouvrez la vidéo sur [youtube.com](https://www.youtube.com/).
4. Respectez les restrictions d'âge, de région et d'intégration de la vidéo.

**Aucune clé YouTube n'est à importer dans le coffre actuel pour cette lecture.**
Le coffre ne configure pas une API de gestion de votre chaîne.

Pour une future intégration **YouTube Data API**, un développeur doit
créer un projet Google Cloud, activer l'API, configurer les identifiants
adaptés et OAuth pour les actions privées sur un compte.
Créer une clé ne suffit pas à ajouter ce connecteur à SIRIUS.
[Démarrage officiel YouTube Data API](https://developers.google.com/youtube/v3/getting-started).

### 12. Facebook : ce qui n'est pas encore intégré

**Il n'existe pas, dans ce coffre, de champ ou de connecteur prêt à l'emploi
pour administrer votre compte Facebook ou publier sur vos Pages.**
Vous pouvez continuer à utiliser [facebook.com](https://www.facebook.com/)
dans votre navigateur, indépendamment du coffre.

Pour préparer une future intégration, et non pour activer une fonction actuelle :

1. Le responsable de l'intégration ouvre [Meta for Developers](https://developers.facebook.com/).
2. Il crée une application correspondant à l'usage envisagé.
3. Pour les Pages, il identifie une Page qu'il est autorisé à gérer.
4. Il configure les permissions et le parcours d'autorisation, puis teste
   avec les comptes autorisés ; une validation de Meta peut être nécessaire.
5. Le connecteur doit être développé dans SIRIUS avant d'être utilisable.

Une **App Secret Meta**, un jeton de Page et le mot de passe Facebook sont
trois choses différentes : ne les placez pas dans un champ API d'un autre service.
[Prérequis officiels de l'API Pages](https://developers.facebook.com/docs/pages-api/getting-started/).

### 13. Instagram : attention au type de compte

Le coffre actuel **ne configure pas d'intégration Instagram**.
Utilisez normalement [instagram.com](https://www.instagram.com/) si vous
souhaitez simplement consulter votre compte.

Pour une future intégration professionnelle :

1. Vérifiez si le compte doit devenir **Business** ou **Creator**.
2. Le responsable crée/configure l'application dans Meta for Developers.
3. Il choisit le parcours Instagram approprié :
   l'API avec Instagram Login exige un compte professionnel ;
   le parcours avec Facebook Login exige aussi une Page Facebook liée.
4. Il prépare les autorisations et les tests, puis les validations de Meta
   nécessaires pour les utilisateurs visés.
5. L'intégration doit ensuite être implémentée dans SIRIUS.

Un compte personnel ordinaire ne donne pas automatiquement accès à ces API
professionnelles. Créer un jeton aujourd'hui ne rend pas SIRIUS compatible.
[Documentation officielle Instagram Platform](https://developers.facebook.com/docs/instagram-platform/).

### 14. X, anciennement Twitter

Le coffre actuel **ne possède pas de connecteur X** pour lire votre compte,
publier ou gérer vos messages privés.
L'utilisation normale de [x.com](https://x.com/) reste indépendante.

Pour une future intégration :

1. Le responsable ouvre [console.x.com](https://console.x.com/) et crée
   le compte développeur demandé.
2. Il crée une application et choisit les fonctions et permissions.
3. Il vérifie la tarification : l'API v2 est présentée dans la documentation
   actuelle avec une facturation à l'usage ; ne supposez pas un accès gratuit.
4. Il configure les identifiants et l'autorisation utilisateur nécessaires.
5. Il développe et teste le connecteur dans SIRIUS avant de distribuer cette fonction.

Ne collez pas les secrets X dans un champ SerpAPI ou Groq.
[Présentation officielle de l'API X](https://docs.x.com/x-api/getting-started/about-x-api).

### 15. Autres boîtes mail et autres réseaux

Pour Yahoo, iCloud, Proton ou un autre fournisseur, **ne supposez pas**
que le connecteur Google ou Microsoft fonctionne. Le centre actuel présente
les connexions Google et Microsoft ; un autre fournisseur demande un
connecteur adapté. Ne saisissez pas vos mots de passe de messagerie dans
les champs du coffre.

Si un fournisseur n'apparaît pas dans la page, demander son intégration
est préférable à recopier son secret dans un champ qui ne lui correspond pas.

## Pour le propriétaire de SIRIUS : anciennes clés déjà partagées

Déplacer une clé sur le serveur **ne révoque pas les copies précédemment
distribuées**. Si vos clés étaient présentes dans un ancien fichier de profil,
une sauvegarde ou une installation transmise à quelqu'un :

1. Révoquez ou remplacez ces clés dans les consoles des fournisseurs.
2. Configurez les nouvelles clés uniquement dans l'environnement du serveur.
3. Vérifiez les services après le remplacement.
4. Ne distribuez plus ces nouvelles clés dans le frontend, un coffre utilisateur
   ou un fichier de profil.

Les utilisateurs créent leurs propres clés pour l'après-essai.
Les identifiants OAuth de l'application et les droits administrateur restent
gérés séparément côté serveur.
