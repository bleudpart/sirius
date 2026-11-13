"""Registre des entrees lues, par etablissement et periode, sans stock restant."""
import csv
import io
import logging
from collections.abc import Awaitable, Callable, Iterator
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

import cloud_link
from haccp_database import get_db
from models.haccp import EtiquetteHaccp, HaccpDeliveryDocument
from routers.haccp import _csv_cell, _restaurant_slug
from schemas.haccp import PARIS
from schemas.haccp_documents import DeliveryDocument, ReceptionEntry, ReceptionEntryPage

logger = logging.getLogger(__name__)
DOCUMENT_DATE = func.coalesce(
    HaccpDeliveryDocument.document["date_document"].as_string(),
    func.haccp_paris_day(HaccpDeliveryDocument.created_at),
)
LABEL_DATE = func.haccp_paris_day(EtiquetteHaccp.created_at)
CATEGORY_LABELS = {
    "Viandes": "Boucherie / Charcuterie", "Poissons": "Poissonnerie",
    "Produits Laitiers": "Crémerie", "Fruits & Légumes": "Fruits & Légumes",
    "Épicerie": "Épicerie", "Non classé": "Non classé",
}


def entry_register(
    db: Session, scope: str, restaurant: str, year: int, month: int | None,
) -> tuple[list[ReceptionEntry], list[int]]:
    documents = select(HaccpDeliveryDocument).where(
        HaccpDeliveryDocument.scope_key == scope,
        HaccpDeliveryDocument.restaurant_name == restaurant,
        HaccpDeliveryDocument.document["type_document"].as_string().in_(("facture", "bon_livraison")),
    )
    labels = select(EtiquetteHaccp).where(
        EtiquetteHaccp.scope_key == scope, EtiquetteHaccp.restaurant_name == restaurant,
        EtiquetteHaccp.type_operation == "reception",
    )
    years = {year, datetime.now(PARIS).year}
    for statement, date_column in ((documents, DOCUMENT_DATE), (labels, LABEL_DATE)):
        for value in db.scalars(statement.with_only_columns(func.substr(date_column, 1, 4)).distinct()):
            if not isinstance(value, str) or not value.isdecimal() or not 1 <= int(value) <= 9999:
                raise ValueError("Date d'archive invalide dans le registre des entrees.")
            years.add(int(value))
    prefix = f"{year:04d}" + (f"-{month:02d}" if month is not None else "")
    entries: list[tuple[ReceptionEntry, datetime]] = []
    document_rows = db.scalars(documents.where(
        func.substr(DOCUMENT_DATE, 1, len(prefix)) == prefix,
    ).order_by(HaccpDeliveryDocument.created_at.desc(), HaccpDeliveryDocument.id.desc()))
    for row in document_rows:
        document = DeliveryDocument.model_validate(row.document)
        day = document.date_document or row.created_at.replace(tzinfo=timezone.utc).astimezone(PARIS).date()
        for index, line in enumerate(document.lignes, start=1):
            entries.append((ReceptionEntry(
                id=f"document:{row.id}:{index}", restaurant_name=restaurant, date=day,
                origine_date="document" if document.date_document is not None else "photo",
                categorie=line.categorie, produit=line.produit,
                quantite=format(line.quantite, "f") if line.quantite is not None else None,
                unite=line.unite, lot=line.lot, source=document.type_document,
                reference=document.reference, fournisseur=document.fournisseur,
            ), row.created_at))
    label_rows = db.scalars(labels.where(
        func.substr(LABEL_DATE, 1, len(prefix)) == prefix,
    ).order_by(EtiquetteHaccp.created_at.desc(), EtiquetteHaccp.id.desc()))
    for row in label_rows:
        entries.append((ReceptionEntry(
            id=f"etiquette:{row.id}", restaurant_name=restaurant,
            date=row.created_at.replace(tzinfo=timezone.utc).astimezone(PARIS).date(), origine_date="photo",
            categorie=row.categorie, produit=row.nom_produit, quantite=None, unite=None,
            lot=row.numero_lot, source="etiquette", reference=f"#{row.id}", fournisseur=row.fournisseur_ou_marque,
        ), row.created_at))
    entries.sort(key=lambda pair: (pair[0].date, pair[1]), reverse=True)
    return [entry for entry, _ in entries], sorted(years, reverse=True)


def csv_entries(entries: list[ReceptionEntry]) -> Iterator[str]:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow([
        "Date", "Établissement", "Famille", "Produit", "Quantité", "Unité", "Lot",
        "Pièce", "Référence", "Fournisseur", "Date utilisée",
    ])
    yield "\ufeff" + buffer.getvalue()
    source_labels = {"facture": "Facture", "bon_livraison": "Bon de livraison", "etiquette": "Étiquette"}
    for entry in entries:
        buffer.seek(0)
        buffer.truncate(0)
        writer.writerow([_csv_cell(value) for value in (
            entry.date.strftime("%d/%m/%Y"), entry.restaurant_name, CATEGORY_LABELS[entry.categorie],
            entry.produit or "Non lu", entry.quantite.replace(".", ",") if entry.quantite is not None else "Non lue",
            entry.unite or "Non lue", entry.lot or "Non lu", source_labels[entry.source],
            entry.reference, entry.fournisseur, "Document" if entry.origine_date == "document" else "Photo",
        )])
        yield buffer.getvalue()


def make_haccp_entries_router(resolve_scope: Callable[[Request], Awaitable[str]]) -> APIRouter:
    router = APIRouter(prefix="/receptions/entrees", tags=["haccp-entrees"])

    def establishment(request: Request, name: str) -> str:
        kitchen = getattr(request.state, "haccp_kitchen", None)
        name = kitchen["restaurant_name"] if kitchen is not None else name.strip()
        _restaurant_slug(name)
        return name

    async def load(db: Session, scope: str, name: str, year: int, month: int | None):
        try:
            return await run_in_threadpool(entry_register, db, scope, name, year, month)
        except (SQLAlchemyError, ValidationError, ValueError) as error:
            logger.exception("[HACCP-ENTREES] Lecture du registre impossible")
            raise HTTPException(500, "Le registre des entrees est indisponible. Rechargez-le avant utilisation.") from error

    @router.get("", response_model=ReceptionEntryPage)
    async def entries(
        request: Request, response: Response,
        restaurant_name: Annotated[str, Query(min_length=1, max_length=160)],
        annee: Annotated[int | None, Query(ge=1, le=9999)] = None,
        mois: Annotated[int | None, Query(ge=1, le=12)] = None,
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=100)] = 25,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> ReceptionEntryPage:
        response.headers["Cache-Control"] = "private, no-store"
        name = establishment(request, restaurant_name)
        year = annee if annee is not None else datetime.now(PARIS).year
        if cloud_link.relay_allowed():
            forwarded = await cloud_link.relay_haccp_registry("GET", "/receptions/entrees", params={
                "restaurant_name": name, "annee": year, "offset": offset, "limit": limit,
                **({"mois": mois} if mois is not None else {}),
            })
            return ReceptionEntryPage.model_validate(forwarded.json())
        items, years = await load(db, scope, name, year, mois)
        return ReceptionEntryPage(
            restaurant_name=name, annee=year, mois=mois, annees=years,
            offset=offset, limit=limit, total=len(items), items=items[offset:offset + limit],
        )

    @router.get("/export-csv")
    async def export(
        request: Request,
        restaurant_name: Annotated[str, Query(min_length=1, max_length=160)],
        annee: Annotated[int | None, Query(ge=1, le=9999)] = None,
        mois: Annotated[int | None, Query(ge=1, le=12)] = None,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ):
        if getattr(request.state, "haccp_kitchen", None) is not None:
            raise HTTPException(403, "Export reserve au chef connecte.")
        name = establishment(request, restaurant_name)
        year = annee if annee is not None else datetime.now(PARIS).year
        filename = f"entrees_{_restaurant_slug(name)}_{year:04d}" + (f"-{mois:02d}" if mois is not None else "") + ".csv"
        headers = {"Cache-Control": "private, no-store", "Content-Disposition": f'attachment; filename="{filename}"'}
        if cloud_link.relay_allowed():
            forwarded = await cloud_link.relay_haccp_registry("GET", "/receptions/entrees/export-csv", params={
                "restaurant_name": name, "annee": year, **({"mois": mois} if mois is not None else {}),
            })
            if not forwarded.headers.get("content-type", "").lower().startswith("text/csv"):
                logger.error("[HACCP-ENTREES] Export Cloud refuse : contenu non CSV")
                raise HTTPException(502, "Le fichier des entrees Cloud est invalide. Rechargez avant son export.")
            return Response(forwarded.content, media_type="text/csv; charset=utf-8", headers=headers)
        items, _ = await load(db, scope, name, year, mois)
        return StreamingResponse(csv_entries(items), media_type="text/csv; charset=utf-8", headers=headers)

    return router
