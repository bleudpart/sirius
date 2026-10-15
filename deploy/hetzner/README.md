# Déploiement Hetzner de l’API SIRIUS

Kit prévu pour un VPS Hetzner Cloud CX22 sous Ubuntu 24.04, avec Caddy en HTTPS automatique devant FastAPI/Uvicorn sur `127.0.0.1:8001`.

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

Copiez les variables Render nécessaires dans :

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

## 8. Déployer manuellement

```bash
sudo /opt/sirius/deploy/hetzner/deploy.sh
```

Le script fait `git fetch/reset origin/master`, réinstalle les dépendances si `backend/requirements.txt` change, redémarre `sirius` et vérifie `/api/health`.

## 9. Rollback

Plan de retour rapide : remettez les enregistrements DNS `A/AAAA` de `api.sirius-assistant.fr` vers Render. Tant que le TTL est bas, le retour est rapide. Gardez Render actif jusqu’à validation complète du VPS.