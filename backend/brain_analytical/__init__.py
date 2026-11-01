"""Cerveau analytique & stratégique de ΣIRIUS.

Second cerveau, en arrière-plan : il surveille les constantes vitales des entreprises (fenêtre glissante),
détecte les seuils franchis, projette la trésorerie, persiste alertes et synthèses, puis publie son état.
Le cerveau opérationnel (commandes, OCR, conformité, saisie) reste seul en temps réel ; il signale ses
écritures validées et lit l'état publié, sans jamais attendre une analyse. Répartition : ``repartition.py``.

Modules :
- ``schemas`` : contrats Pydantic stricts (StrategicAlert, BusinessHealthSnapshot, synthèse…) ;
- ``repartition`` : registre des tâches de chaque cerveau et des échanges entre eux ;
- ``regles`` : seuils, alertes, projection de trésorerie et indice de santé, 100 % déterministes (Decimal) ;
- ``collecte`` : fenêtre d'analyse et lecture SQL des pièces via le moteur KPI existant ;
- ``store`` : tables ``brain_*`` du registre financier SQLite, réconciliation des alertes ;
- ``strategic_advisor`` : rédaction par LLM (JSON typé, garde numérique) ou repli déterministe ;
- ``orchestrator`` : signaux, anti-rebond, déclencheurs événement / seuil / périodique / manuel ;
- ``conversation`` : réponses du cerveau opérationnel aux questions stratégiques ;
- ``routes`` : API FastAPI (état, analyse à la demande, acquittement, vue ZEUS CORTEX).
"""
