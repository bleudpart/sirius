# Support et récupération SIRIUS

## Signaler un bug

Avant de signaler un problème :

1. noter la version affichée dans **À propos** ;
2. préciser Windows, le module et les étapes exactes pour reproduire ;
3. indiquer le résultat attendu et le résultat observé ;
4. joindre `audit-report.json` ou un extrait de journal nettoyé ;
5. ne jamais joindre de mot de passe, clé API, donnée client ou document HACCP réel.

Les demandes peuvent être ouvertes dans les Issues du dépôt GitHub SIRIUS. Pour les demandes privées liées aux données personnelles, utiliser :

- danielpartel@hotmail.com
- danielsirius.pro2026@gmail.com
- https://sirius-assistant.fr/

## Récupération après incident

1. Fermer SIRIUS et ne pas supprimer le dossier de données utilisateur.
2. Copier le dossier de données sur un support séparé avant toute réparation.
3. Ouvrir la version Entreprise avec un compte administrateur.
4. Restaurer la dernière sauvegarde vérifiée depuis **Entreprise → Sauvegardes**.
5. Vérifier les documents, les fiches HACCP, les membres et le journal d'audit.
6. Si l'application ne démarre plus, utiliser le dernier installateur stable et restaurer la sauvegarde sur une copie de travail.
7. Conserver l'ancien dossier et les journaux jusqu'à validation complète.

La restauration exige une confirmation explicite et est réservée à un administrateur. Tester régulièrement une restauration sur une copie, au minimum avant une mise à jour importante.

## Versions stables

- Les versions publiées sont identifiées par un tag `vMAJEUR.MINEUR.PATCH`.
- Une version stable doit passer le build frontend, les tests backend ciblés, les tests de restauration et l'audit statique.
- Ne pas publier une version si un test de restauration échoue ou si le rapport d'audit est en échec.
- Conserver au moins une version stable précédente pour retour arrière.
- Les releases GitHub contiennent l'installateur Windows et la version portable correspondante.

## Contrôle qualité local

Depuis la racine du dépôt :

```powershell
Push-Location backend
python -m pytest tests/test_proactive.py tests/test_briefing_intent.py tests/test_enterprise.py tests/test_sirius_doctor.py tests/test_auth_api_unit.py tests/test_server_hardening.py -q
python -m py_compile server.py sirius_brain.py proactive.py enterprise.py routers/files.py routes/pantheon_oracle.py
Pop-Location

Push-Location frontend
npm test -- --watchAll=false --runInBand
npm run build
Pop-Location

python scripts/sirius_audit.py
```

Les clés API et les données de production ne doivent jamais être placées dans le dépôt ou dans les rapports de test.

© 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
