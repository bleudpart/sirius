# Envoyer vos e-mails depuis ΣIRIUS

ΣIRIUS peut envoyer vos factures, devis, relances et comptes rendus directement depuis votre propre adresse e-mail. Le réglage se fait une seule fois et prend environ 5 minutes.

## Où faire le réglage

1. Ouvrez **THÉMIS**.
2. Cliquez sur l’onglet **CLÉS API**.
3. Descendez jusqu’à **ENVOI D’E-MAILS — VOTRE SERVEUR SMTP**.
4. Remplissez les champs en suivant la fiche de votre messagerie ci-dessous.
5. Cliquez sur **SCELLER LES CLÉS**.

Vos identifiants restent enregistrés sur votre appareil. Ils ne passent par le serveur ΣIRIUS qu’au moment d’un envoi et n’y sont jamais conservés.

---

## Gmail (adresses @gmail.com)

Google n’accepte pas votre mot de passe habituel. Il faut créer un **mot de passe d’application**, un code de 16 lettres réservé à ΣIRIUS.

### Étape 1 : activer la validation en deux étapes (si ce n’est pas déjà fait)

1. Allez sur <https://myaccount.google.com/security>.
2. Cliquez sur **Validation en deux étapes** et suivez les instructions (un code par SMS suffit).

### Étape 2 : créer le mot de passe d’application

1. Allez sur <https://myaccount.google.com/apppasswords>.
2. Dans le nom de l’application, tapez **SIRIUS**, puis cliquez sur **Créer**.
3. Google affiche un code de 16 lettres. Copiez-le (les espaces n’ont pas d’importance).

### Étape 3 : remplir ΣIRIUS

| Champ | À saisir |
|---|---|
| Serveur SMTP | `smtp.gmail.com` |
| Port | `587` |
| Identifiant / adresse e-mail | votre adresse Gmail complète |
| Mot de passe | le code de 16 lettres (pas votre mot de passe Gmail) |
| Adresse expéditeur | laissez vide |
| Nom d’expéditeur | le nom de votre entreprise |

---

## Orange (adresses @orange.fr et @wanadoo.fr)

| Champ | À saisir |
|---|---|
| Serveur SMTP | `smtp.orange.fr` |
| Port | `465` |
| Identifiant / adresse e-mail | votre adresse Orange complète |
| Mot de passe | le mot de passe de votre messagerie Orange |
| Adresse expéditeur | laissez vide |
| Nom d’expéditeur | le nom de votre entreprise |

Si l’envoi est refusé, connectez-vous une fois sur <https://messagerie.orange.fr> pour vérifier que votre mot de passe est bon, puis réessayez.

---

## Outlook, Hotmail, Live (adresses @outlook.fr, @hotmail.fr, @live.fr)

| Champ | À saisir |
|---|---|
| Serveur SMTP | `smtp-mail.outlook.com` |
| Port | `587` |
| Identifiant / adresse e-mail | votre adresse Outlook complète |
| Mot de passe | votre mot de passe Microsoft, ou un mot de passe d’application si la validation en deux étapes est activée |
| Adresse expéditeur | laissez vide |
| Nom d’expéditeur | le nom de votre entreprise |

Pour créer un mot de passe d’application Microsoft : <https://account.live.com/proofs/manage/additional>, rubrique **Mots de passe d’application**.

**Important :** Microsoft limite de plus en plus l’envoi depuis les logiciels extérieurs avec un simple mot de passe. Si l’envoi est refusé malgré un mot de passe correct, utilisez plutôt une adresse Gmail ou Orange pour vos envois.

---

## Autres messageries

| Messagerie | Serveur SMTP | Port | Mot de passe |
|---|---|---|---|
| Free | `smtp.free.fr` | `465` | mot de passe de la messagerie Free |
| SFR | `smtp.sfr.fr` | `465` | mot de passe de la messagerie SFR |
| La Poste | `smtp.laposte.net` | `465` | mot de passe de la messagerie La Poste |
| Yahoo | `smtp.mail.yahoo.com` | `465` | mot de passe d’application Yahoo (Sécurité du compte) |
| iCloud | `smtp.mail.me.com` | `587` | mot de passe pour application Apple (appleid.apple.com) |

**Adresse professionnelle** (nom@votre-entreprise.fr) : demandez à votre hébergeur (OVH, Ionos, o2switch…) ou à votre prestataire informatique le **serveur SMTP** et le **port**. L’identifiant est en général votre adresse complète.

---

## En cas de problème

| Message affiché | Que faire |
|---|---|
| « Authentification SMTP refusée » | L’identifiant ou le mot de passe est faux. Pour Gmail, utilisez bien le code de 16 lettres et non votre mot de passe habituel. |
| « Serveur SMTP injoignable » | Vérifiez l’orthographe du serveur et le port (587 ou 465, voir les tableaux ci-dessus). |
| « Configurez d’abord votre serveur SMTP » | Les champs n’ont pas été enregistrés : retournez dans **CLÉS API** et cliquez sur **SCELLER LES CLÉS**. |

**Conseil :** après le réglage, envoyez un premier devis à votre propre adresse pour vérifier que tout fonctionne.
