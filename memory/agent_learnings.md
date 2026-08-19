
## 2026-08-03 — PIÈGE OUTIL search_replace
- Symptôme observé 3× : quand PLUSIEURS search_replace sont appliqués en PARALLÈLE sur le MÊME fichier, certains édits sont silencieusement perdus (tout en répondant "successful") et des fragments dupliqués apparaissent en fin de fichier ("return outside of function").
- Fichiers touchés : App.js (2×), SiriusDisplay.jsx (1×).
- RÈGLE : ne jamais lancer plus d'un search_replace à la fois sur un même fichier ; vérifier avec grep après édition ; contrôler la fin du fichier (tail) après une série d'édits.
