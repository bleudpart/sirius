"""Contrats du cerveau analytique : stricts, figés, sérialisables sans perte (Decimal transmis en chaîne)."""
import unicodedata
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from schemas.finance import CompanyId, Period, SectorEnum, StrictModel
from brain_analytical.repartition import Attribution, Echange


class SeveriteAlerte(str, Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"

    @property
    def rang(self) -> int:
        return ("INFO", "WARNING", "CRITICAL").index(self.value)


class TypeDeclencheur(str, Enum):
    EVENEMENT = "EVENEMENT"
    SEUIL = "SEUIL"
    PERIODIQUE = "PERIODIQUE"
    MANUEL = "MANUEL"


class TypeEvenement(str, Enum):
    SAISIE_VALIDEE = "SAISIE_VALIDEE"
    SAISIE_SUPPRIMEE = "SAISIE_SUPPRIMEE"
    IMPORT_VALIDE = "IMPORT_VALIDE"
    IMPORT_ANNULE = "IMPORT_ANNULE"
    TICKET_CAISSE = "TICKET_CAISSE"
    PROFIL_MODIFIE = "PROFIL_MODIFIE"


class NiveauSante(str, Enum):
    SAIN = "SAIN"
    VIGILANCE = "VIGILANCE"
    CRITIQUE = "CRITIQUE"
    INDETERMINE = "INDETERMINE"


class HorizonAction(str, Enum):
    IMMEDIAT = "IMMEDIAT"
    SEMAINE = "SEMAINE"
    MOIS = "MOIS"
    TRIMESTRE = "TRIMESTRE"


class SourceSynthese(str, Enum):
    IA = "IA"
    DETERMINISTE = "DETERMINISTE"


class StatutAlerte(str, Enum):
    OUVERTE = "OUVERTE"
    ACQUITTEE = "ACQUITTEE"
    RESOLUE = "RESOLUE"


class StatutExecution(str, Enum):
    TERMINEE = "TERMINEE"
    INCHANGEE = "INCHANGEE"
    ECHEC = "ECHEC"


Unite = Literal["eur", "pct", "pts", "jours", "ratio", "ans", "nombre"]
CodeAlerte = Annotated[str, Field(pattern=r"^[A-Z0-9_]{3,64}$")]
Texte = Annotated[str, Field(min_length=1, max_length=600)]


class EvenementOperationnel(StrictModel):
    """Signal du cerveau opérationnel après une écriture validée : jamais de montant, seulement sa nature."""
    company_id: CompanyId
    type: TypeEvenement
    source: str = Field(min_length=1, max_length=64)
    reference: str | None = Field(default=None, max_length=160)
    acteur: str = Field(min_length=1, max_length=128)
    nombre_ecritures: Annotated[int, Field(ge=0)] | None = None
    survenu_le: datetime


class StrategicAlert(StrictModel):
    code: CodeAlerte
    severite: SeveriteAlerte
    metrique: str = Field(min_length=1, max_length=64)
    libelle_metrique: str = Field(min_length=1, max_length=120)
    valeur: Decimal | None = None
    seuil: Decimal | None = None
    unite: Unite
    explication: Texte
    plan_action: list[Texte] = Field(min_length=1, max_length=6)
    codes_tableau_de_bord: list[str] = Field(default_factory=list)


class IndicateurSante(StrictModel):
    cle: str
    libelle: str
    valeur: Decimal | None
    unite: Unite
    precedent: Decimal | None = None
    variation: Decimal | None = None


class PointProjection(StrictModel):
    jour: int = Field(ge=0)
    echeance: date
    solde: Decimal


class ProjectionTresorerie(StrictModel):
    """Dernier solde reconstitué prolongé du flux mensuel le plus prudent, gestion ou banque."""
    solde_depart: Decimal
    date_depart: date
    flux_mensuel_gestion: Decimal | None
    flux_mensuel_bancaire: Decimal | None
    flux_mensuel_retenu: Decimal | None
    source_flux: Literal["gestion", "bancaire"] | None
    points: list[PointProjection]
    jour_rupture: int | None
    date_rupture: date | None
    methode: str


class BusinessHealthSnapshot(StrictModel):
    """État de santé global d'une entreprise ; l'empreinte ne dépend que des données, pas de l'heure du calcul."""
    version: Literal["1"] = "1"
    company_id: CompanyId
    entreprise: str
    secteur: SectorEnum
    devise: str
    periode: Period
    periode_comparee: Period | None
    date_analyse: date
    derniere_donnee: date | None
    calcule_le: datetime
    declencheur: TypeDeclencheur
    niveau: NiveauSante
    indice: Annotated[int, Field(ge=0, le=100)] | None
    methode_indice: str
    indicateurs: list[IndicateurSante]
    alertes: list[StrategicAlert]
    projection: ProjectionTresorerie | None
    empreinte: str = Field(pattern=r"^[0-9a-f]{64}$")


class Recommandation(StrictModel):
    titre: str = Field(min_length=1, max_length=120)
    action: str = Field(min_length=1, max_length=400)
    horizon: HorizonAction
    metriques: list[str] = Field(default_factory=list, max_length=6)


class SyntheseStrategique(StrictModel):
    company_id: CompanyId
    empreinte_snapshot: str = Field(pattern=r"^[0-9a-f]{64}$")
    generee_le: datetime
    declencheur: TypeDeclencheur
    source: SourceSynthese
    modele: str | None = None
    motif_repli: str | None = None
    resume: str = Field(min_length=1, max_length=1500)
    points_cles: list[str] = Field(max_length=6)
    recommandations: list[Recommandation] = Field(max_length=6)
    avertissement: str


def _sans_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text.casefold()) if not unicodedata.combining(c))


def _horizon(value: object) -> object:
    if not isinstance(value, str):
        return value
    text = _sans_accents(value)
    if any(word in text for word in ("immediat", "urgent", "aujourd", "48")):
        return HorizonAction.IMMEDIAT
    if "semaine" in text:
        return HorizonAction.SEMAINE
    if "trimestre" in text or "3 mois" in text:
        return HorizonAction.TRIMESTRE
    if "mois" in text:
        return HorizonAction.MOIS
    return value.strip().upper()


def _cinq_premiers(value: object) -> object:
    return value[:5] if isinstance(value, list) else value


class RecommandationLLM(BaseModel):
    """Sortie du modèle, tolérante sur la forme ; les chiffres restent contrôlés par la garde numérique."""
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    titre: str = Field(min_length=1, max_length=120)
    action: str = Field(min_length=1, max_length=400)
    horizon: Annotated[HorizonAction, BeforeValidator(_horizon)] = HorizonAction.MOIS
    metriques: Annotated[list[str], BeforeValidator(_cinq_premiers)] = Field(default_factory=list)


class RedactionLLM(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    resume: str = Field(min_length=1, max_length=1500)
    points_cles: Annotated[list[str], BeforeValidator(_cinq_premiers)] = Field(default_factory=list)
    recommandations: Annotated[list[RecommandationLLM], BeforeValidator(_cinq_premiers)] = Field(default_factory=list)


class AlerteSuivie(StrictModel):
    id: int
    statut: StatutAlerte
    alerte: StrategicAlert
    premiere_detection: datetime
    derniere_detection: datetime
    occurrences: int = Field(ge=1)
    acquittee_le: datetime | None = None
    acquittee_par: str | None = None
    resolue_le: datetime | None = None
    commentaire: str | None = None


class JournalExecution(StrictModel):
    id: int
    declencheur: TypeDeclencheur
    statut: StatutExecution
    demarre_le: datetime
    duree_ms: int = Field(ge=0)
    detail: str


class EtatOrchestrateur(StrictModel):
    actif: bool
    en_attente: int
    evenements_recus: int
    evenements_rejetes: int
    analyses_terminees: int
    analyses_en_echec: int
    syntheses_ia: int
    derniere_analyse: datetime | None
    dernier_cycle_periodique: datetime | None


class EtatCerveau(StrictModel):
    company_id: CompanyId
    snapshot: BusinessHealthSnapshot | None
    synthese: SyntheseStrategique | None
    synthese_a_jour: bool
    alertes: list[AlerteSuivie]
    executions: list[JournalExecution]
    orchestrateur: EtatOrchestrateur
    verifie_le: datetime | None = None
    message: str | None = None


class AnalyseLancee(StrictModel):
    company_id: CompanyId
    acceptee: bool
    message: str


class DemandeAcquittement(StrictModel):
    commentaire: str = Field(default="", max_length=300)


class VueCortexAnalytique(StrictModel):
    etat: EtatCerveau | None
    message: str | None = None
    repartition: list[Attribution]
    echanges: list[Echange]
