"""Répartition TriCortex : B1 dialogue, B2 logique directe, B3 supervise les quatre satellites."""
from datetime import datetime, timedelta, timezone
from enum import Enum

from pydantic import Field

from schemas.finance import StrictModel

# Au-delà, le cerveau opérationnel juge l'état publié périmé et demande une nouvelle analyse.
ETAT_PERIME_APRES = timedelta(hours=24)


class Cerveau(str, Enum):
    OPERATIONNEL = "OPERATIONNEL"
    ANALYTIQUE = "ANALYTIQUE"
    SENTINEL = "SENTINEL"


class ModeExecution(str, Enum):
    TEMPS_REEL = "TEMPS_REEL"
    ARRIERE_PLAN = "ARRIERE_PLAN"


class Attribution(StrictModel):
    cle: str = Field(pattern=r"^[a-z_]{3,40}$")
    libelle: str
    cerveau: Cerveau
    mode: ModeExecution
    detail: str


class Echange(StrictModel):
    de: Cerveau
    vers: Cerveau
    canal: str
    detail: str


def _operationnel(cle: str, libelle: str, detail: str) -> Attribution:
    return Attribution(cle=cle, libelle=libelle, cerveau=Cerveau.OPERATIONNEL, mode=ModeExecution.TEMPS_REEL, detail=detail)


def _analytique(cle: str, libelle: str, detail: str) -> Attribution:
    return Attribution(cle=cle, libelle=libelle, cerveau=Cerveau.ANALYTIQUE, mode=ModeExecution.TEMPS_REEL, detail=detail)


def _sentinel(cle: str, libelle: str, detail: str) -> Attribution:
    return Attribution(cle=cle, libelle=libelle, cerveau=Cerveau.SENTINEL, mode=ModeExecution.ARRIERE_PLAN, detail=detail)


REPARTITION: tuple[Attribution, ...] = (
    _operationnel("commandes", "Commandes vocales et écrites",
                  "Comprend et exécute la demande sur-le-champ ; aucune analyse de fond dans le temps de réponse."),
    _sentinel("ocr", "SubagentVision · étiquettes et factures",
              "Extraction structurée et confiance par champ non calibrée ; le Cerveau 2 contrôle, le Cerveau 1 restitue."),
    _analytique("conformite", "Contrôles HACCP et traçabilité",
                "Validation directe des lectures et des règles PMS ; aucune certification sanitaire automatique."),
    _analytique("saisie", "Saisie, imports et tickets de caisse",
                  "Valide chaque écriture dans sa transaction, répond, puis signale le changement en tâche de fond."),
    _analytique("tableau_de_bord", "Tableau de bord et stress test à la demande",
                  "Calcul déterministe immédiat sur la période choisie par l'utilisateur."),
    _operationnel("questions_strategiques", "Réponses sur la santé de l'entreprise",
                  "Lit le dernier état publié par Sentinel, sans recalcul ; "
                  "demande une analyse si cet état manque ou date de plus de 24 h."),
    _sentinel("surveillance", "SubagentSanitaryGuard · DLC et allergènes",
              "Surveillance J-2, FEFO puis FIFO ; observations à vérifier, pas un inventaire physique."),
    _analytique("seuils", "Détection des seuils et des dérives",
                "Coût matière, prime cost, dérive de marge, baisse d'activité, couverture des annuités, capitaux propres."),
    _analytique("projection", "Projection de trésorerie J+15 à J+90",
                "Solde reconstitué prolongé du flux mensuel le plus prudent entre gestion et banque."),
    _analytique("synthese", "Synthèse stratégique par IA",
                "Le modèle n'explique que des chiffres déjà calculés ; un chiffre non fourni impose le repli déterministe."),
    _sentinel("consolidation", "SubagentMarginAudit · consolidation et prix",
              "Ordonnanceur financier unique supervisé ; calculs confiés au Cerveau 2, aucune écriture comptable automatique."),
    _sentinel("alertes", "Alertes suivies et dossier banque",
              "Nouvelle, aggravée, atténuée ou résolue ; acquittement tracé ; notification des alertes critiques."),
    _sentinel("archivage", "SubagentArchivist · copies et file hors ligne",
              "Compression de copies, purge des caches, reprise bornée des analyses autorisées ; originaux conservés."),
)

ECHANGES: tuple[Echange, ...] = (
    Echange(de=Cerveau.OPERATIONNEL, vers=Cerveau.SENTINEL, canal="Signal d'écriture validée",
            detail="Entreprise, nature et auteur, jamais de montant ; signaux regroupés entre 20 s et 2 min."),
    Echange(de=Cerveau.SENTINEL, vers=Cerveau.ANALYTIQUE, canal="Validation et calcul directs",
            detail="Vision et audit appellent le Cerveau 2 ; aucune file ni boucle de surveillance dans le Cerveau 2."),
    Echange(de=Cerveau.ANALYTIQUE, vers=Cerveau.OPERATIONNEL, canal="État publié",
            detail="Alertes, projection et synthèse lues par les suggestions proactives, la conversation et ZEUS CORTEX."),
)


def attributions(cerveau: Cerveau) -> tuple[Attribution, ...]:
    return tuple(item for item in REPARTITION if item.cerveau == cerveau)


def responsable(cle: str) -> Cerveau:
    """Cerveau chargé d'une tâche ; KeyError pour une tâche non répartie, pour qu'aucune ne soit orpheline."""
    for item in REPARTITION:
        if item.cle == cle:
            return item.cerveau
    raise KeyError(cle)


def etat_perime(calcule_le: datetime | None, maintenant: datetime) -> bool:
    """Un état absent ou vieux de plus de 24 h doit être rafraîchi en arrière-plan."""
    if calcule_le is None:
        return True
    if calcule_le.tzinfo is None or maintenant.tzinfo is None:
        raise ValueError("Les dates de fraîcheur doivent inclure leur fuseau horaire.")
    age = maintenant.astimezone(timezone.utc) - calcule_le.astimezone(timezone.utc)
    return age < timedelta(0) or age > ETAT_PERIME_APRES
