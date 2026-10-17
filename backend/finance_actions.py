"""First adapters to the shared registry; legacy financial APIs remain unchanged."""

import uuid
from typing import Literal

from fastapi import HTTPException
from pydantic import Field, JsonValue

from action_registry import ActionDefinition, ActionInputs, ActionOutput, ActionRegistry, ActionResult, ActionSource
from ariane_market_runs import evaluate_rules
from finance_workspace import Action, PreviewIn
from nummarius_api import STOCKS
from work_draft_recordings import digest


class AnalysisInputs(ActionInputs):
    symbol: Literal["AAPL", "MSFT", "NVDA", "TSLA"]
    period: Literal["1m", "3m", "1y", "5y"] = "1y"


class RuleInputs(ActionInputs):
    analysis: dict[str, JsonValue]
    volatility_threshold_pct: float = Field(default=30, gt=0, le=1000, strict=True)


class PrepareInputs(ActionInputs):
    action: Action


class ConfirmFinanceInputs(ActionInputs):
    preview: dict[str, JsonValue]


class AnalysisOutput(ActionResult):
    analysis: dict[str, JsonValue]


class RulesOutput(ActionResult):
    findings: list[dict[str, JsonValue]]
    missing: list[dict[str, JsonValue]]
    alerts_created: int
    rule_parameters: dict[str, JsonValue]


def make_finance_actions(service):
    registry = ActionRegistry()

    async def analyze(context, inputs):
        return AnalysisOutput(analysis=await service.reader(inputs.symbol, dict(STOCKS)[inputs.symbol], inputs.period))

    async def rules(context, inputs):
        analysis = inputs.analysis
        required = ("symbol", "volatility_20d_annualized_pct", "age_calendar_days", "rejected_bars", "as_of", "data_version")
        if any(key not in analysis for key in required):
            raise HTTPException(422, "Résultat d'analyse incomplet pour évaluer la condition.")
        value = analysis["volatility_20d_annualized_pct"]
        for numeric in (value, analysis["age_calendar_days"], analysis["rejected_bars"]):
            if numeric is not None and (isinstance(numeric, bool) or not isinstance(numeric, (int, float))):
                raise HTTPException(422, "Indicateur numérique invalide.")
        if analysis["age_calendar_days"] is None or analysis["rejected_bars"] is None:
            raise HTTPException(422, "Métadonnées d'analyse absentes.")
        return RulesOutput(**evaluate_rules([analysis], inputs.volatility_threshold_pct))

    async def portfolio(context, inputs):
        data = await service.valuation(context.user_id)
        return ActionOutput(data=data, completion="PARTIAL" if data["state"] == "PARTIAL" else "COMPLETE",
                            issues=[f"Données de valorisation indisponibles pour {symbol}." for symbol in data["missing"]])

    async def overview(context, inputs):
        return ActionOutput(data=await service.overview(context.user_id))

    async def prepare(context, inputs):
        return ActionOutput(data=await service.preview(context.user_id, PreviewIn(
            request_id=uuid.uuid5(uuid.NAMESPACE_URL, context.idempotency_key), action=inputs.action,
        )))

    async def confirm(context, inputs):
        identity = inputs.preview.get("id")
        if not isinstance(identity, str):
            raise HTTPException(422, "La référence de l'aperçu est absente.")
        original = await service.preview_status(context.user_id, identity)
        if digest(original) != digest(inputs.preview):
            raise HTTPException(409, "L'aperçu présenté ne correspond pas à l'aperçu authentifié ; aucune modification.")
        return ActionOutput(data=await service.confirm(context.user_id, identity))

    for definition in (
        ActionDefinition("portus.analysis", "PORTUS", "Lire et calculer les indicateurs d'une action", "1",
                         AnalysisInputs, AnalysisOutput, analyze),
        ActionDefinition("portus.volatility_rules", "PORTUS", "Évaluer les réserves et le seuil de volatilité", "1",
                         RuleInputs, RulesOutput, rules,
                         sources=(ActionSource("analysis", "portus.analysis", ("analysis",)),)),
        ActionDefinition("finance.portfolio", "PORTUS", "Valoriser les positions déclarées", "1",
                         ActionInputs, ActionOutput, portfolio),
        ActionDefinition("finance.overview", "NÉMÉSIS", "Consulter les surveillances et décisions financières", "1",
                         ActionInputs, ActionOutput, overview),
        ActionDefinition("finance.prepare", "PORTUS / CHRONOS", "Préparer un aperçu financier, sans l'exécuter", "1",
                         PrepareInputs, ActionOutput, prepare, kind="prepare"),
        ActionDefinition("finance.confirm", "PORTUS / CHRONOS", "Appliquer l'aperçu financier exact après accord", "1",
                         ConfirmFinanceInputs, ActionOutput, confirm, kind="mutation", risk="sensitive",
                         sources=(ActionSource("preview", "finance.prepare", ("data",)),)),
    ):
        registry.register(definition)
    return registry
