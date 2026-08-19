# ROADMAP — SIRIUS

## P0 (rien en attente)
- Aucun bug bloquant connu. Sécurité auth/isolation validée (iteration_37).

## P1 (rien en attente)
- Vérification utilisateur en conditions réelles : connexion Google, calendrier, pipeline Hermès Agora avec paiement Stripe test.

## P2
- Polissage du flux Face ID (reconnaissance faciale) si l'utilisateur demande plus d'intégration caméra.
- Refactoring : server.py (2360 lignes) et modules_api.py (1815 lignes) — scinder chat/agora/paiements pour réduire les risques de régression. App.js (4800+ lignes) : ne jamais réécrire, search_replace uniquement.
- Performance panneau admin : requêtes N+1 (Mongo + SQLite par compte) — agréger si le nombre de comptes grandit.

## Fait (08/06/2026)
- ~~Isolation Thémis par utilisateur~~ (docs, clients, stocks, commandes, paiements, pièces, export, bilan, stats — tous filtrés par user_id).
- ~~Badge + panneau admin~~ (/api/admin/users, AdminPanel.jsx, badge ADMIN).
