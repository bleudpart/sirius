"""Répartition des tâches entre les deux cerveaux de ΣIRIUS : source unique pour l'API, ZEUS CORTEX et la doc.

Principe : le cerveau opérationnel ne fait jamais attendre l'utilisateur ; tout ce qui demande d'agréger
l'historique, de comparer des périodes ou d'appeler un modèle de raisonnement part au cerveau analytique,
en arrière-plan. Les deux ne partagent que des signaux sans montant et un état publié en base.
"""
from datetime import datetime, timedelta, timezone
from enum import Enum

from pydantic import Field

from schemas.finance import StrictModel

# Au-delà, le cerveau opérationnel juge l'état publié périmé et demande une nouvelle analyse.
ETAT_PERIME_APRES = timedelta(hours=24)


class Cerveau(str, Enum):
    OPERATIONNEL = "OPERATIONNEL"
    ANALYTIQUE = "ANALYTIQUE"


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
    return Attribution(cle=cle, libelle=libelle, cerveau=Cerveau.ANALYTIQUE, mode=ModeExecution.ARRIERE_PLAN, detail=detail)


REPARTITION: tuple[Attribution, ...] = (
    _operationnel("commandes", "Commandes vocales et écrites",
                  "Comprend et exécute la demande sur-le-champ ; aucune analyse de fond dans le temps de réponse."),
    _operationnel("ocr", "OCR d'étiquettes et de factures",
                  "Lit le document à la capture et le fait vérifier avant tout enregistrement."),
    _operationnel("conformite", "Conformité immédiate (HACCP, traçabilité)",
                  "Contrôles, relevés et non-conformités au fil du service, sans attendre le cerveau analytique."),
    _operationnel("saisie", "Saisie, imports et tickets de caisse",
                  "Valide chaque écriture dans sa transaction, répond, puis signale le changement en tâche de fond."),
    _operationnel("tableau_de_bord", "Tableau de bord et stress test à la demande",
                  "Calcul déterministe immédiat sur la période choisie par l'utilisateur."),
    _operationnel("questions_strategiques", "Réponses sur la santé de l'entreprise",
                  "Lit le dernier état publié par le cerveau analytique, sans recalcul ; "
                  "demande une analyse si cet état manque ou date de plus de 24 h."),
    _analytique("surveillance", "Surveillance des constantes vitales",
                "Fenêtre glissante de 3 mois comparée à la précédente : CA, marges, EBE, point mort, trésorerie, dette."),
    _analytique("seuils", "Détection des seuils et des dérives",
                "Coût matière, prime cost, dérive de marge, baisse d'activité, couverture des annuités, capitaux propres."),
    _analytique("projection", "Projection de trésorerie J+15 à J+90",
                "Solde reconstitué prolongé du flux mensuel le plus prudent entre gestion et banque."),
    _analytique("synthese", "Synthèse stratégique par IA",
                "Le modèle n'explique que des chiffres déjà calculés ; un chiffre non fourni impose le repli déterministe."),
    _analytique("consolidation", "Consolidation périodique",
                "Vérification horaire, point quotidien conservé, synthèse IA au moins hebdomadaire."),
    _analytique("alertes", "Alertes suivies et dossier banque",
                "Nouvelle, aggravée, atténuée ou résolue ; acquittement tracé ; notification des alertes critiques."),
)

ECHANGES: tuple[Echange, ...] = (
    Echange(de=Cerveau.OPERATIONNEL, vers=Cerveau.ANALYTIQUE, canal="Signal d'écriture validée",
            detail="Entreprise, nature et auteur, jamais de montant ; signaux regroupés entre 20 s et 2 min."),
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
