# Déploiement Hetzner du site et de l’API ΣIRIUS

Kit prévu pour un VPS Hetzner Cloud CX22 sous Ubuntu 24.04, avec Caddy en HTTPS automatique devant FastAPI/Uvicorn sur `127.0.0.1:8001`.
Le site React est servi directement par Caddy, sans lancer Node sur le VPS.
Sa compilation se fait dans GitHub Actions, pas sur le VPS.

## 1. Préparer la clé SSH Windows

Dans PowerShell :

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\sirius_hetzner
Get-Content $env:USERPROFILE\.ssh\sirius_hetzner.pub
```

Ajoutez la clé publique dans Hetzner Cloud.

## 2. Créer le serveur

1. Créez un compte/projet Hetzner Cloud.
2. Créez un serveur **CX22**, image **Ubuntu 24.04**, région proche, avec votre clé SSH.
3. Activez les **backups Hetzner (+20%)**.
4. Notez l’IPv4 et l’IPv6.
5. Si possible, baissez le TTL DNS de `api.sirius-assistant.fr` avant la bascule.

## 3. Premier bootstrap

Connectez-vous en root :

```powershell
ssh -i $env:USERPROFILE\.ssh\sirius_hetzner root@IP_DU_SERVEUR
```

Sur le serveur :

```bash
apt-get update && apt-get install -y git
mkdir -p /opt/sirius
if [ ! -d /opt/sirius/.git ]; then git clone https://github.com/bleudpart/sirius.git /opt/sirius; fi
/opt/sirius/deploy/hetzner/setup.sh api.sirius-assistant.fr votre-email@example.com
```

Le script est idempotent : il met à jour Ubuntu, installe `ufw`, `fail2ban`, Caddy, Python 3.12, le venv, Playwright Chromium, crée l’utilisateur système `sirius`, le dossier `/var/lib/sirius`, `/etc/sirius/sirius.env`, le service systemd et un utilisateur `deploy`.

## 4. Variables d’environnement

Copiez les variables nécessaires depuis le déploiement précédent dans :

```bash
sudo nano /etc/sirius/sirius.env
sudo systemctl restart sirius
```

Ne commitez jamais ces secrets. Le fichier appartient à `root`, mode `600`. Le script ajoute `SIRIUS_DATA_DIR=/var/lib/sirius`. Si `MONGO_URL` n’est pas défini, les données vivent en SQLite sur le VPS dans `/var/lib/sirius`.

## 5. Tester avant la bascule DNS

Test local serveur :

```bash
curl -fsS http://127.0.0.1:8001/api/health
```

Test Caddy avant DNS (HTTP, avec résolution forcée côté client) :

```powershell
curl.exe --resolve api.sirius-assistant.fr:80:IP_DU_SERVEUR http://api.sirius-assistant.fr/api/health
```

Après bascule DNS, test HTTPS :

```powershell
curl.exe --resolve api.sirius-assistant.fr:443:IP_DU_SERVEUR https://api.sirius-assistant.fr/api/health
```

## 6. Basculer le DNS

Dans la zone DNS de `sirius-assistant.fr`, pointez `api.sirius-assistant.fr` vers le VPS :

- `A` → IPv4 Hetzner
- `AAAA` → IPv6 Hetzner, si utilisée

Caddy obtiendra automatiquement le certificat Let’s Encrypt quand le domaine pointera vers le VPS.

Pour héberger aussi le site, après publication et vérification locale du build :

- remplacer le `A @` par l’IPv4 Hetzner ;
- remplacer le `CNAME www` par `sirius-assistant.fr` ;
- retirer les anciens `A`/`AAAA` de ces deux noms qui pointent ailleurs, sans
  toucher aux enregistrements de messagerie, de vérification ou à `api`.

Conserver l’ancien hébergement pendant la propagation. Le fichier Caddy fourni cible les
trois noms `api.sirius-assistant.fr`, `sirius-assistant.fr` et `www.sirius-assistant.fr` :
adapter ces noms avant installation pour un autre domaine.

## 7. Déploiement GitHub Actions

Ajoutez les secrets GitHub :

- `HETZNER_HOST` : IP ou nom DNS du serveur
- `HETZNER_USER` : `deploy` recommandé, ou `root`
- `HETZNER_SSH_KEY` : clé privée autorisée sur le serveur

Pour l’utilisateur non-root `deploy`, `setup.sh` crée la règle sudoers limitée à :

```text
/opt/sirius/deploy/hetzner/deploy.sh
```

Le workflow `.github/workflows/deploy-hetzner.yml` ne fait rien si `HETZNER_HOST` est vide.
Il se déclenche aussi sur les changements frontend. Il compile avec
`REACT_APP_BACKEND_URL=https://api.sirius-assistant.fr`, transfère le build par SSH,
puis publie le commit exact. Les limites et la facturation GitHub Actions
restent applicables.

Les versions du site restent dans `/var/www/sirius/releases`. Le lien `current`
est remplacé atomiquement après validation du build et de la configuration Caddy.
Les ressources hachées restent dans `/var/www/sirius/assets/static` pour les
onglets déjà ouverts. Ces versions et ressources sont conservées : surveiller
l’espace disque et nettoyer uniquement les versions identifiées comme inutiles.
`/deploy-sha.txt` permet de vérifier le commit réellement servi.
Le port de contrôle `8080` écoute uniquement sur `127.0.0.1`.

Lors de la première migration d’un ancien déploiement API seul, mettre à jour
le script `deploy.sh` sur le serveur avec la version committée avant le premier
workflow incluant le site. Aucun accès sudo supplémentaire n’est nécessaire.

## 8. Déployer manuellement

```bash
sudo /opt/sirius/deploy/hetzner/deploy.sh
```

Le script fait `git fetch/reset origin/master`, réinstalle les dépendances si `backend/requirements.txt` change, redémarre `sirius` et vérifie `/api/health`.
Sans argument, il ne remplace pas le site. Pour publier le site, utiliser le
workflow GitHub Actions : il fournit l’archive et le SHA attendus, puis vérifie
le site sur la boucle locale avant le contrôle de santé API.

## 9. Clôturer l’ancien hébergement

Avant de supprimer un ancien service, vérifier les trois noms de domaine
(`sirius-assistant.fr`, `www.sirius-assistant.fr`, `api.sirius-assistant.fr`),
`https://sirius-assistant.fr/deploy-sha.txt` et
`https://api.sirius-assistant.fr/api/health`, puis tester les fonctions métier
et la continuité des données sur le VPS.

Vérifier dans `/etc/sirius/sirius.env` que les clés et services nécessaires
sont configurés sur Hetzner. Confirmer où se trouvent les données MongoDB et
les fichiers téléversés ; si l’ancien déploiement utilisait SQLite ou un
disque persistant, exporter et restaurer ces données avant la fermeture.
Conserver une sauvegarde vérifiée du VPS et des données.

Après ces vérifications, dans le tableau de bord de l’ancien hébergeur,
désactiver les déploiements automatiques, identifier les seuls services du
site et de l’API SIRIUS, vérifier leurs disques et tâches, puis les supprimer.
Ne pas supprimer MongoDB Atlas ni les services tiers. Vérifier ensuite que les
trois domaines et le site répondent toujours depuis Hetzner. Les journaux ou
sauvegardes de l’ancien hébergeur peuvent suivre une durée de rétention propre
au fournisseur ; la suppression des services ne prouve pas leur effacement
immédiat.

Une fois l’ancien service supprimé, il n’y a plus de retour DNS instantané vers
lui. Pour un rollback, restaurer une sauvegarde validée sur un hôte disponible
et ne modifier le DNS qu’après les contrôles de santé.

## 10. Préparer la reconnaissance du locuteur, sans l'activer

Cette étape est **optionnelle**. Elle ne publie pas le code, ne modifie pas
`/etc/sirius/sirius.env`, ne choisit aucun seuil et ne redémarre pas le service.
Vérifier l'empreinte SSH du VPS par un canal fiable avant de s'y connecter ; ne
pas désactiver `StrictHostKeyChecking`. Le backend comprenant
`voice_identity_worker.py` et `requirements-voice-identity.txt` doit déjà être
déployé. Aucun accès SSH ni changement de production n'est nécessaire pour
préparer et tester ces scripts localement.

Sur le VPS, vérifier l'espace disque et la capacité CPU disponible. Le moteur
utilise un thread CPU par inférence ; un test de chargement ne garantit pas les
temps de vérification en charge. Installer explicitement le décodeur si absent :

```bash
sudo apt-get install ffmpeg
```

L'opérateur télécharge le modèle officiel en dehors du dépôt :

```bash
curl --fail --location --proto '=https' --proto-redir '=https' \
  --output /tmp/wespeaker_en_voxceleb_resnet34_LM.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
bash /opt/sirius/deploy/hetzner/prepare-voice-identity.sh \
  --check /tmp/wespeaker_en_voxceleb_resnet34_LM.onnx
sudo bash /opt/sirius/deploy/hetzner/prepare-voice-identity.sh \
  --prepare /tmp/wespeaker_en_voxceleb_resnet34_LM.onnx
```

`--check` est en lecture seule : il vérifie les fichiers requis, ffmpeg et
l'empreinte officielle, pas l'inférence. `--prepare` installe le runtime optionnel
dans le venv existant, copie le modèle vérifié dans
`/var/lib/sirius/models/voice-identity/` (root:sirius, lecture seule pour le service),
puis charge réellement le modèle sous l'utilisateur `sirius`, sans audio.
Une empreinte incorrecte ou un modèle installé différent provoque un arrêt
explicite. Un échec ultérieur peut laisser le runtime ou le modèle installés :
aucun retour arrière destructif ni activation n'est effectué.

Le marqueur root `/etc/sirius/voice-identity.prepared` n'est créé qu'après réussite.
Il permet à `deploy.sh` de conserver les dépendances optionnelles lors des prochains
déploiements ou d'une recréation du venv. Il ne rend **pas** la protection active.
Le runtime est réinstallé si son manifeste change ou si son marqueur dans le venv
est absent ; l'absence de sherpa malgré un marqueur provoque un échec explicite.
Ces scripts n'installent rien sur un serveur qui n'a pas été préparé explicitement.

Conserver l'attribution WeSpeaker (Wang et al., ICASSP 2023) et la licence des poids
**CC-BY-4.0** ; provenance, licence et SHA-256 attendu sont dans
[`backend/.env.example`](../../backend/.env.example). Après réussite, supprimer
uniquement le fichier téléchargé identifié dans `/tmp` s'il n'est plus utile.

### Activation : étape distincte

L'opérateur doit ensuite renseigner les variables `SIRIUS_VOICE_IDENTITY_*` dans
`/etc/sirius/sirius.env` : chemin absolu du modèle préparé, SHA-256 attendu,
ffmpeg et **seuil explicite à calibrer**, puis `ENABLED=1` et redémarrage contrôlé.
Ne pas recopier un seuil d'un essai anglais comme garantie anti-TV en français.
L'API authentifiée `/api/voice-identity/status` doit ensuite annoncer `ready=true`.
`/api/health` seul ne prouve pas la disponibilité du moteur vocal.

Dans l'application, le titulaire donne son consentement puis enregistre trois
nouvelles références de 3 à 15 secondes dans « Ma voix et ma diction ». Valider
ensuite sa propre voix, une autre voix et la télévision, sur les vrais microphones.
Le système ne constitue pas une protection anti-rejeu d'un enregistrement de sa
voix. L'écoute automatique reste bloquée si l'identité est incertaine ou le moteur
indisponible ; l'appui volontaire pour parler reste le secours prévu.

Pour désactiver : `SIRIUS_VOICE_IDENTITY_ENABLED=0` puis redémarrage contrôlé.
Ne pas effacer les empreintes des comptes ou les modèles comme méthode d'arrêt.
Retirer le marqueur opérateur ne désinstalle rien et ne désactive pas le moteur :
cela retire seulement la gestion optionnelle des dépendances au déploiement.

### Tests locaux de la préparation

Depuis la racine du dépôt :

```powershell
node --test scripts\voice-identity-deploy.test.mjs
```

Les tests utilisent Bash (Git for Windows par défaut sous Windows, surcharge
possible avec `SIRIUS_TEST_BASH`) et des répertoires temporaires isolés.
Ils simulent sudo, l'installation pip, les permissions et le chargement du modèle ;
ils ne prouvent donc ni une installation Linux réelle, ni la précision biométrique.
Ils vérifient notamment les refus avant installation, la copie vérifiée, les
échecs du moteur, l'idempotence, le maintien du runtime optionnel et l'absence
d'activation ou de redémarrage du service. Un test vérifie aussi le refus d'un
faux modèle avec la véritable commande SHA-256.
## 11. Sauvegarde quotidienne hors serveur (Storage Box)

Les étiquettes HACCP, leurs photos et toutes les données SQLite vivent dans
`/var/lib/sirius`. Cette sauvegarde les copie chaque nuit (vers 3 h 30, heure de
Paris), chiffrées avec restic, vers une Hetzner Storage Box : un autre serveur que le VPS.
Elle complète les backups Hetzner du VPS, sans les remplacer.

1. Commander une **Storage Box BX11** dans la console Hetzner (environ 4 € par mois).
2. Dans ses réglages, activer **SSH** et **l'accès externe**, puis définir un mot de passe.
3. Ouvrir la console du VPS dans Hetzner Cloud et lancer, avec l'identifiant
   de la Storage Box :

```bash
sudo bash /opt/sirius/deploy/hetzner/prepare-backup.sh u123456
```

Le script installe restic, crée une clé SSH dédiée et l'installe sur la Storage Box.
Le mot de passe de la Storage Box est demandé une seule fois.
Le script crée ensuite le dépôt chiffré, active `sirius-backup.timer` et lance une
première sauvegarde. Il affiche alors le **mot de passe de chiffrement** : à noter
hors du serveur, sinon la sauvegarde est illisible si le VPS est perdu.

Rétention : 30 jours, 12 semaines, 24 mois. Les bases SQLite sont copiées par l'API
de sauvegarde SQLite et vérifiées avant l'envoi ; chaque sauvegarde relit aussi 5 % des données.
Le déploiement réinstalle le timer seulement si `/etc/sirius/backup.env` existe.

Contrôles :

```bash
systemctl list-timers sirius-backup.timer
journalctl -u sirius-backup.service -n 50 --no-pager
sudo bash -c 'set -a; . /etc/sirius/backup.env; restic snapshots'
```

Restauration dans un dossier séparé, sans écraser la production :

```bash
sudo bash -c 'set -a; . /etc/sirius/backup.env; restic restore latest --target /var/tmp/sirius-restore'
```

Les bases SQLite restaurées se trouvent sous `var/tmp/sirius-sqlite-snapshot/`,
les fichiers (photos, documents) sous `var/lib/sirius/`.