"""Tableaux analytiques décisionnels du module Finance : calcul pur à partir du corps de la requête, rien n'est écrit."""
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractContextManager, nullcontext
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, ValidationError
from starlette.concurrency import run_in_threadpool

from analytics_engine import AnalyticsEngine, AnalyticsError
from finance_entries import validation_detail
from routers.finance import AuthResolver, FinanceMember, MembershipDatabase, read_json_object, resolve_finance_member
from schemas.finance import CompanyId
from schemas.finance_analytics import (
    ANALYTICS_FIELD_LABELS, BreakEvenRequest, FoodCostVarianceRequest, HudPayload, MenuEngineeringRequest,
    SupplierImpactRequest,
)

logger = logging.getLogger(__name__)

MAX_ANALYTICS_PAYLOAD_BYTES = 512 * 1024
RequestT = TypeVar("RequestT", bound=BaseModel)
SortBy = Annotated[str | None, Query(max_length=64, description="Clé d'une colonne triable ; défaut propre au tableau.")]
Descending = Annotated[bool | None, Query(description="Ordre décroissant ; défaut propre au tableau.")]


def make_finance_analytics_router(
    db: MembershipDatabase, require_user: AuthResolver,
    *, business_activity: Callable[[str, str], AbstractContextManager[None]] | None = None,
    engine: AnalyticsEngine | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/finance", tags=["finance-analytique"])
    analytics = engine or AnalyticsEngine()

    async def membership(request: Request, company_id: str) -> AsyncIterator[FinanceMember]:
        member = await resolve_finance_member(db, require_user, request, company_id)
        activity = business_activity(f"finance:{member.company_id}", "analytics") if business_activity else nullcontext()
        with activity:
            yield member

    async def run(
        request: Request, model: type[RequestT], compute: Callable[[RequestT], HudPayload],
    ) -> HudPayload:
        body = await read_json_object(request, MAX_ANALYTICS_PAYLOAD_BYTES)
        try:
            data = model.model_validate(body)
        except ValidationError as error:
            raise HTTPException(422, validation_detail(error, ANALYTICS_FIELD_LABELS)) from error
        try:
            return await run_in_threadpool(compute, data)
        except ValidationError as error:
            logger.exception("[FINANCE] Tableau analytique : résultat incohérent")
            raise HTTPException(500, "Tableau analytique indisponible : résultat incohérent.") from error
        except AnalyticsError as error:
            raise HTTPException(422, str(error)) from error

    def sorting(sort_by: str | None, descending: bool | None) -> dict[str, object]:
        """Seuls les paramètres fournis surchargent les valeurs par défaut du moteur."""
        chosen: dict[str, object] = {}
        if sort_by is not None:
            chosen["sort_by"] = sort_by
            # Sans ordre explicite, une colonne choisie se lit du plus petit au plus grand.
            chosen["descending"] = False
        if descending is not None:
            chosen["descending"] = descending
        return chosen

    @router.post("/{company_id}/analytics/menu-engineering", response_model=HudPayload)
    async def menu_engineering(
        company_id: Annotated[CompanyId, Path()], request: Request,
        _member: Annotated[FinanceMember, Depends(membership)], sort_by: SortBy = None, descending: Descending = None,
    ) -> HudPayload:
        return await run(request, MenuEngineeringRequest,
                         lambda data: analytics.menu_engineering(data, **sorting(sort_by, descending)))

    @router.post("/{company_id}/analytics/food-cost-variance", response_model=HudPayload)
    async def food_cost_variance(
        company_id: Annotated[CompanyId, Path()], request: Request,
        _member: Annotated[FinanceMember, Depends(membership)], sort_by: SortBy = None, descending: Descending = None,
    ) -> HudPayload:
        return await run(request, FoodCostVarianceRequest,
                         lambda data: analytics.food_cost_variance(data, **sorting(sort_by, descending)))

    @router.post("/{company_id}/analytics/supplier-impact", response_model=HudPayload)
    async def supplier_impact(
        company_id: Annotated[CompanyId, Path()], request: Request,
        _member: Annotated[FinanceMember, Depends(membership)], sort_by: SortBy = None, descending: Descending = None,
    ) -> HudPayload:
        return await run(request, SupplierImpactRequest,
                         lambda data: analytics.supplier_impact(data, **sorting(sort_by, descending)))

    @router.post("/{company_id}/analytics/break-even", response_model=HudPayload)
    async def break_even(
        company_id: Annotated[CompanyId, Path()], request: Request,
        _member: Annotated[FinanceMember, Depends(membership)], sort_by: SortBy = None, descending: Descending = None,
    ) -> HudPayload:
        return await run(request, BreakEvenRequest,
                         lambda data: analytics.break_even(data, **sorting(sort_by, descending)))

    return router
