"""Portail B2B : grilles par fournisseur et commandes réparties, en mode essai."""
import csv
import hashlib
import io
import logging
import secrets
import sqlite3
import uuid
from decimal import Decimal, localcontext
from email.message import EmailMessage
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, model_validator
from pymongo.errors import PyMongoError

import cloud_link
from access_gate import access_status
from auth_api import is_direct_local_request, require_user
from schemas.finance import FINANCE_CONTEXT, Quantity, money
from work_draft_recordings import digest, insert_once, now_iso

logger = logging.getLogger(__name__)
HEADER = "X-Sirius-Order-Client"
PORTAL_URL = "https://sirius-assistant.fr/commandes"
Name = Annotated[str, StringConstraints(
    min_length=1, max_length=160, pattern=r"^[^\x00-\x1f\x7f]+$",
)]
Email = Annotated[str, StringConstraints(
    max_length=254, pattern=r"^(?:|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$",
)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SupplierInput(Input):
    name: Name
    email: Email = ""
    price_basis: Literal["HT", "TTC"] = "HT"


class ProductInput(Input):
    reference: Name
    name: Name
    unit: Annotated[str, StringConstraints(min_length=1, max_length=30, pattern=r"^[^\x00-\x1f\x7f]+$")]
    price: Quantity


class CatalogInput(Input):
    version: str = Field(max_length=64)
    products: list[ProductInput] = Field(max_length=500)
    supplier: SupplierInput | None = None

    @model_validator(mode="after")
    def unique_references(self):
        refs = [row.reference for row in self.products]
        if len(set(refs)) != len(refs):
            raise ValueError("Chaque référence doit être unique dans la grille.")
        return self


class ClientInput(Input):
    name: Name
    email: Email = ""


class CatalogCsvInput(Input):
    csv: str = Field(min_length=1, max_length=500000)


def parse_catalog_csv(text):
    text = text.lstrip("\ufeff")
    if not text.strip():
        raise HTTPException(422, "Le CSV ne contient aucun produit.")
    delimiter = ";" if ";" in text.splitlines()[0] else ","
    products = []
    try:
        reader = csv.DictReader(io.StringIO(text), delimiter=delimiter, strict=True)
        if not reader.fieldnames or len(reader.fieldnames) != 4 or set(reader.fieldnames) != {"reference", "nom", "unite", "prix"}:
            raise HTTPException(422, "Colonnes CSV requises : reference;nom;unite;prix.")
        for line, row in enumerate(reader, 2):
            if len(products) >= 500 or None in row or any(value is None for value in row.values()):
                raise HTTPException(422, f"Ligne {line} : grille limitée à 500 produits et quatre colonnes.")
            try:
                products.append(ProductInput(
                    reference=row["reference"], name=row["nom"], unit=row["unite"],
                    price=row["prix"].strip().replace(",", "."),
                ))
            except ValidationError as error:
                raise HTTPException(422, f"Ligne {line} : {error.errors()[0]['msg']}") from error
        CatalogInput(version="", products=products)
    except csv.Error as error:
        raise HTTPException(422, "CSV illisible : vérifiez les séparateurs et les guillemets.") from error
    except ValidationError as error:
        raise HTTPException(422, error.errors()[0]["msg"]) from error
    if not products:
        raise HTTPException(422, "Le CSV ne contient aucun produit.")
    return [{**row.model_dump(mode="json"), "price": format(row.price.normalize(), "f")} for row in products]


class OrderLine(Input):
    supplier_id: uuid.UUID
    product_id: uuid.UUID
    quantity: Annotated[Quantity, Field(gt=Decimal("0"))]


class OrderInput(Input):
    request_id: uuid.UUID
    catalog_version: str = Field(pattern=r"^[a-f0-9]{64}$")
    contact: Name
    delivery_address: str = Field(min_length=1, max_length=500)
    note: str = Field(default="", max_length=1000)
    lines: list[OrderLine] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def unique_products(self):
        keys = [(row.supplier_id, row.product_id) for row in self.lines]
        if len(set(keys)) != len(keys):
            raise ValueError("Un produit ne peut figurer qu'une fois dans le panier.")
        return self


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


async def owner_scope(db, user):
    membership = await db.enterprise_members.find_one({"user_id": user["user_id"]})
    if membership:
        company = await db.enterprise_companies.find_one({"id": membership["company_id"]})
        if not company or membership.get("role") not in {"admin", "manager"}:
            raise HTTPException(403, "Portail réservé aux gestionnaires de l'entreprise.")
        return f"company:{company['id']}"
    if user.get("company_id"):
        raise HTTPException(403, "Rattachement entreprise à vérifier.")
    return f"user:{user['user_id']}"


def scope_fields(scope, user_id):
    return {
        "scope_key": scope, "user_id": user_id,
        **({"company_id": scope.removeprefix("company:")} if scope.startswith("company:") else {}),
    }


def public_client(row):
    return {key: row[key] for key in ("id", "name", "email", "active", "created_at")}


def receipt(order):
    return {
        key: order[key] for key in (
            "id", "client_name", "contact", "delivery_address", "note", "created_at", "status", "totals",
        )
    } | {"supplier_orders": [
        {key: part[key] for key in ("supplier_id", "supplier_name", "price_basis", "lines", "total", "status")}
        for part in order["supplier_orders"]
    ]}


def supplier_message(order, part):
    message = EmailMessage()
    if part["email"]:
        message["To"] = part["email"]
    message["Subject"] = f"[ESSAI NON ENVOYÉ] Commande {order['id']} — {part['supplier_name']}"
    lines = [
        "SIMULATION — aucune commande réelle n'a été envoyée.",
        f"Client : {order['client_name']}", f"Contact : {order['contact']}",
        f"E-mail client : {order['client_email'] or 'non renseigné'}",
        f"Livraison : {order['delivery_address']}", "",
    ]
    for row in part["lines"]:
        lines.append(
            f"{row['reference']} — {row['name']} : {row['quantity']} {row['unit']}"
            f" × {row['price']} EUR = {row['total']} EUR {part['price_basis']}"
        )
    lines.extend(["", f"Total : {part['total']} EUR {part['price_basis']}",
                  "TVA et frais de livraison non calculés.", f"Note : {order['note']}"])
    message.set_content("\n".join(lines))
    return message.as_bytes()


def make_supplier_orders_router(db, rate_ok):
    async def storage_errors():
        try:
            yield
        except (sqlite3.Error, PyMongoError) as error:
            logger.exception("[COMMANDES B2B] Stockage indisponible")
            raise HTTPException(503, "Enregistrement ou lecture indisponible. Réessayez sans changer de commande.") from error

    router = APIRouter(tags=["supplier-orders"], dependencies=[Depends(storage_errors)])

    async def manager(request: Request):
        user = await require_user(request, db)
        if cloud_link.relay_allowed():
            if not is_direct_local_request(request):
                raise HTTPException(403, "Gestion Cloud réservée à ce poste.")
            return user, None
        return user, await owner_scope(db, user)

    async def proxy(request, path, body=None):
        if cloud_link.relay_allowed():
            return await cloud_link.relay_supplier_orders(
                request.method, path, **({"json": body.model_dump(mode="json")} if body is not None else {}),
            )
        return None

    async def suppliers(scope):
        rows = await db.b2b_suppliers.find({"scope_key": scope}, {"_id": 0}).sort("name", 1).to_list(101)
        if len(rows) > 100:
            raise HTTPException(409, "Limite de 100 fournisseurs atteinte.")
        return rows

    async def catalog(scope):
        rows = await suppliers(scope)
        visible = [{
            "id": row["id"], "name": row["name"], "price_basis": row["price_basis"],
            "products": row.get("products", []),
        } for row in rows if row.get("products")]
        return {"suppliers": visible, "version": digest(visible)}

    async def client_identity(request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        ip = request.client.host if request.client else "unknown"
        if not rate_ok(f"b2b:{ip}", limit=60):
            raise HTTPException(429, "Trop de requêtes. Patientez une minute.")
        token = request.headers.get(HEADER, "")
        if not 30 <= len(token) <= 100:
            raise HTTPException(401, "Lien client absent, révoqué ou invalide.")
        client = await db.b2b_clients.find_one({"token_hash": token_hash(token), "active": True}, {"_id": 0})
        if not client:
            raise HTTPException(401, "Lien client absent, révoqué ou invalide.")
        owner = await db.users.find_one({"user_id": client["user_id"]})
        if not owner or owner.get("disabled"):
            raise HTTPException(401, "Accès client indisponible.")
        if not (await access_status(db, owner)).get("allowed"):
            raise HTTPException(402, "Le portail de ce commercial est temporairement indisponible.")
        if await owner_scope(db, owner) != client["scope_key"]:
            raise HTTPException(401, "Accès client indisponible.")
        return client

    @router.get("/supplier-orders")
    async def workspace(request: Request, identity=Depends(manager)):
        forwarded = await proxy(request, "")
        if forwarded is not None:
            return forwarded
        _user, scope = identity
        clients = await db.b2b_clients.find({"scope_key": scope}, {"_id": 0}).sort("created_at", -1).to_list(1001)
        orders = await db.b2b_orders.find({"scope_key": scope}, {"_id": 0}).sort("created_at", -1).to_list(101)
        return {
            "mode": "test", "suppliers": await suppliers(scope),
            "clients": [public_client(row) for row in clients[:1000]],
            "orders": [receipt(row) for row in orders[:100]], "orders_truncated": len(orders) > 100,
            "clients_truncated": len(clients) > 1000,
        }

    @router.post("/supplier-orders/suppliers")
    async def add_supplier(body: SupplierInput, request: Request, identity=Depends(manager)):
        forwarded = await proxy(request, "/suppliers", body)
        if forwarded is not None:
            return forwarded
        user, scope = identity
        if len(await suppliers(scope)) >= 100:
            raise HTTPException(409, "Limite de 100 fournisseurs atteinte.")
        row = {
            **scope_fields(scope, user["user_id"]), "id": str(uuid.uuid4()),
            **body.model_dump(), "version": uuid.uuid4().hex, "products": [], "created_at": now_iso(),
        }
        await db.b2b_suppliers.insert_one(dict(row))
        return row

    @router.put("/supplier-orders/suppliers/{supplier_id}/catalog")
    async def save_catalog(supplier_id: uuid.UUID, body: CatalogInput, request: Request, identity=Depends(manager)):
        forwarded = await proxy(request, f"/suppliers/{supplier_id}/catalog", body)
        if forwarded is not None:
            return forwarded
        _user, scope = identity
        products = [{
            **row.model_dump(mode="json"),
            "price": format(row.price.normalize(), "f"),
            "id": str(uuid.uuid5(supplier_id, row.reference)),
        } for row in body.products]
        version = uuid.uuid4().hex
        result = await db.b2b_suppliers.update_one(
            {"scope_key": scope, "id": str(supplier_id), "version": body.version},
            {"$set": {
                "products": products, "version": version,
                **(body.supplier.model_dump() if body.supplier is not None else {}),
            }},
        )
        if not result.matched_count:
            raise HTTPException(409, "Grille modifiée ou fournisseur inaccessible. Rechargez avant de réessayer.")
        return {"products": products, "version": version}

    @router.post("/supplier-orders/suppliers/{supplier_id}/catalog/preview")
    async def preview_catalog(supplier_id: uuid.UUID, body: CatalogCsvInput, request: Request, identity=Depends(manager)):
        forwarded = await proxy(request, f"/suppliers/{supplier_id}/catalog/preview", body)
        if forwarded is not None:
            return forwarded
        _user, scope = identity
        if not await db.b2b_suppliers.find_one({"scope_key": scope, "id": str(supplier_id)}):
            raise HTTPException(404, "Fournisseur introuvable.")
        return {"products": parse_catalog_csv(body.csv), "saved": False}

    @router.post("/supplier-orders/clients")
    async def add_client(body: ClientInput, request: Request, identity=Depends(manager)):
        forwarded = await proxy(request, "/clients", body)
        if forwarded is not None:
            return forwarded
        user, scope = identity
        if await db.b2b_clients.count_documents({"scope_key": scope}) >= 1000:
            raise HTTPException(409, "Limite de 1 000 accès clients atteinte.")
        token = secrets.token_urlsafe(32)
        row = {
            **scope_fields(scope, user["user_id"]), "id": str(uuid.uuid4()), **body.model_dump(),
            "active": True, "token_hash": token_hash(token), "created_at": now_iso(),
        }
        await db.b2b_clients.insert_one(dict(row))
        return {"client": public_client(row), "url": f"{PORTAL_URL}#k={token}"}

    @router.delete("/supplier-orders/clients/{client_id}/link")
    async def revoke_client(client_id: uuid.UUID, request: Request, identity=Depends(manager)):
        forwarded = await proxy(request, f"/clients/{client_id}/link")
        if forwarded is not None:
            return forwarded
        _user, scope = identity
        result = await db.b2b_clients.update_one(
            {"scope_key": scope, "id": str(client_id)}, {"$set": {"active": False}},
        )
        if not result.matched_count:
            raise HTTPException(404, "Accès client introuvable.")
        return {"active": False}

    @router.get("/supplier-orders/orders/{order_id}/suppliers/{supplier_id}/message")
    async def preview_message(order_id: uuid.UUID, supplier_id: uuid.UUID, request: Request, identity=Depends(manager)):
        forwarded = await proxy(request, f"/orders/{order_id}/suppliers/{supplier_id}/message")
        if forwarded is not None:
            return forwarded
        _user, scope = identity
        order = await db.b2b_orders.find_one({"scope_key": scope, "id": str(order_id)})
        if not order:
            raise HTTPException(404, "Commande introuvable.")
        part = next((part for part in order["supplier_orders"] if part["supplier_id"] == str(supplier_id)), None)
        if part is None:
            raise HTTPException(404, "Commande fournisseur introuvable.")
        return {
            "filename": f"essai-{order_id}-{supplier_id}.eml",
            "content": supplier_message(order, part).decode("utf-8"), "sent": False,
        }

    @router.get("/public/supplier-orders/catalog")
    async def client_catalog(client=Depends(client_identity)):
        return {
            "client_id": client["id"], "client_name": client["name"], "mode": "test",
            **await catalog(client["scope_key"]),
        }

    @router.post("/public/supplier-orders/orders")
    async def place_order(body: OrderInput, client=Depends(client_identity)):
        scope = client["scope_key"]
        identity = {"scope_key": scope, "client_id": client["id"], "id": str(body.request_id)}
        fingerprint = digest(body.model_dump(mode="json"))
        existing = await db.b2b_orders.find_one(identity)
        if existing:
            if existing["request_digest"] != fingerprint:
                raise HTTPException(409, "Cet identifiant correspond déjà à un autre panier.")
            return receipt(existing)
        current = await catalog(scope)
        if body.catalog_version != current["version"]:
            raise HTTPException(409, "Les tarifs ont changé. Rechargez la grille et vérifiez votre panier.")
        supplier_map = {row["id"]: row for row in current["suppliers"]}
        parts = {}
        with localcontext(FINANCE_CONTEXT):
            for line in body.lines:
                supplier_id = str(line.supplier_id)
                supplier = supplier_map.get(supplier_id)
                product = next((row for row in (supplier or {}).get("products", [])
                                if row["id"] == str(line.product_id)), None)
                if not product:
                    raise HTTPException(422, "Un produit du panier n'est pas disponible dans cette grille.")
                part = parts.setdefault(supplier_id, {
                    "supplier_id": supplier_id, "supplier_name": supplier["name"],
                    "price_basis": supplier["price_basis"], "lines": [], "status": "test_not_sent",
                })
                part["lines"].append({
                    **product, "quantity": format(line.quantity.normalize(), "f"),
                    "total": str(money(Decimal(product["price"]) * line.quantity)),
                })
            totals = {}
            for supplier_id, part in parts.items():
                supplier = await db.b2b_suppliers.find_one({"scope_key": scope, "id": supplier_id})
                part["email"] = supplier["email"]
                total = sum((Decimal(row["total"]) for row in part["lines"]), Decimal("0"))
                part["total"] = str(money(total))
                basis = part["price_basis"]
                totals[basis] = str(money(Decimal(totals.get(basis, "0")) + total))
        order = {
            **scope_fields(scope, client["user_id"]), **identity, "request_digest": fingerprint,
            "client_name": client["name"], "client_email": client["email"],
            "contact": body.contact, "delivery_address": body.delivery_address, "note": body.note,
            "created_at": now_iso(), "status": "test_not_sent", "supplier_orders": list(parts.values()), "totals": totals,
        }
        saved, _created = await insert_once(db, "b2b_orders", order, identity=identity)
        if saved["request_digest"] != fingerprint:
            raise HTTPException(409, "Cet identifiant correspond déjà à un autre panier.")
        return receipt(saved)

    return router
