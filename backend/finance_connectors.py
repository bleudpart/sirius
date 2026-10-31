"""Adaptateurs stricts des sources d'import approuvées vers le registre financier."""
import codecs
import csv
import hashlib
import hmac
import html
import io
import json
import re
import unicodedata
from abc import ABC, abstractmethod
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, localcontext
from enum import Enum
from typing import TypeAlias

from pydantic import Field, TypeAdapter, ValidationError, model_validator

from schemas.finance import (
    AllocationEnum, CategorieExpense, CompanyId, FINANCE_CONTEXT, FinanceIngestionSource,
    CashMovementIn, HUNDRED, IsoDate, Money, PaymentMethod, Percent, Reference,
    StrictModel, TransactionRevenueIn, PurchaseExpenseIn, ZERO, money,
)

StandardizedTransaction: TypeAlias = TransactionRevenueIn | PurchaseExpenseIn | CashMovementIn
STANDARDIZED_TRANSACTIONS = TypeAdapter(list[StandardizedTransaction])
MAX_CONNECTOR_ROWS = 5_000
MAX_CONNECTOR_PAYLOAD_BYTES = 5 * 1024 * 1024


class ConnectorValidationError(ValueError):
    """Charge utile mal formée, ou dont le rapprochement échoue."""


class IngestionConflictError(ValueError):
    """Clé d'idempotence ou transaction source réutilisée de façon incohérente."""


def _canonical_json(value: object) -> bytes:
    def exact(item: object) -> str:
        if isinstance(item, Decimal):
            return str(item)
        if isinstance(item, Enum):
            return str(item.value)
        raise TypeError(f"Type non pris en charge dans le checksum : {type(item).__name__}")

    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False, default=exact,
    ).encode("utf-8")


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Clé JSON dupliquée : {key}")
        result[key] = value
    return result


def _records_checksum(transactions: list[StandardizedTransaction]) -> str:
    return hashlib.sha256(_canonical_json([
        record.model_dump(mode="json") for record in transactions
    ])).hexdigest()


def _document(raw_data: dict | bytes) -> dict:
    if isinstance(raw_data, bytes):
        if not raw_data or len(raw_data) > MAX_CONNECTOR_PAYLOAD_BYTES:
            raise ConnectorValidationError("Charge utile JSON vide ou trop volumineuse.")
        try:
            payload = json.loads(
                raw_data.decode("utf-8-sig"),
                parse_float=Decimal,
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Constante JSON interdite: {value}")),
                object_pairs_hook=_unique_json_object,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
            raise ConnectorValidationError("JSON UTF-8 invalide, trop imbriqué ou contenant un nombre non fini.") from error
    elif isinstance(raw_data, dict):
        payload = raw_data
    else:
        raise ConnectorValidationError("Objet JSON ou octets UTF-8 requis.")
    if not isinstance(payload, dict):
        raise ConnectorValidationError("Un objet JSON est requis.")
    try:
        encoded = _canonical_json(payload)
    except (TypeError, ValueError, UnicodeError) as error:
        raise ConnectorValidationError("Objet JSON invalide ou non representable.") from error
    if len(encoded) > MAX_CONNECTOR_PAYLOAD_BYTES:
        raise ConnectorValidationError("Charge utile JSON trop volumineuse.")
    return payload


def _validate_model(model, value):
    try:
        return model.model_validate(value)
    except ValidationError as error:
        locations = [
            ".".join(str(part) for part in item["loc"])
            for item in error.errors(include_input=False)[:8]
        ]
        raise ConnectorValidationError(
            "Champs absents ou invalides : " + ", ".join(locations or ["payload"])
        ) from error


def _validated_transactions(records: list[StandardizedTransaction]) -> list[StandardizedTransaction]:
    try:
        return STANDARDIZED_TRANSACTIONS.validate_python(records)
    except ValidationError as error:
        locations = [
            ".".join(str(part) for part in item["loc"])
            for item in error.errors(include_input=False)[:8]
        ]
        raise ConnectorValidationError(
            "Transactions normalisées invalides : " + ", ".join(locations or ["payload"])
        ) from error


class BaseDataConnector(ABC):
    source: FinanceIngestionSource

    def __init__(self, company_id: str, currency: str):
        self.company_id, self.currency = company_id, currency
        self._parsed_checksum: str | None = None
        self._records_checksum: str | None = None
        self._idempotency_key: str | None = None
        # Rempli par parse_payload : informations de contrôle (notes) et points à revoir par une personne (warnings).
        self.import_notes: tuple[str, ...] = ()
        self.import_warnings: tuple[str, ...] = ()

    @property
    def idempotency_key(self) -> str | None:
        return self._idempotency_key

    @abstractmethod
    def parse_payload(self, raw_data: dict | bytes) -> list[StandardizedTransaction]:
        """Analyse une charge utile source complète, sans rien écrire dans le stockage."""

    @abstractmethod
    def validate_checksum_and_totals(self, transactions: list[StandardizedTransaction]) -> bool:
        """Rapproche le checksum et les totaux déclarés par la source avant tout enregistrement."""

    def _remember(self, transactions: list[StandardizedTransaction], checksum: str | None) -> None:
        self._records_checksum = _records_checksum(transactions)
        self._parsed_checksum = checksum

    def _validate_fingerprint(self, transactions: list[StandardizedTransaction]) -> bool:
        return self._records_checksum is not None and hmac.compare_digest(
            self._records_checksum, _records_checksum(transactions),
        )

    def _company_currency(self, value: str) -> None:
        if value != self.currency:
            raise ConnectorValidationError(f"Devise incompatible : {value}, attendue {self.currency}.")


class POSLine(StrictModel):
    transaction_id: Reference
    date: IsoDate
    amount_ht: Money
    amount_vat: Money
    amount_ttc: Money
    vat_rate: Percent
    payment_method: PaymentMethod = Field(strict=False)
    allocation: AllocationEnum = Field(default=AllocationEnum.OTHER, strict=False)
    ticket_count: int | None = Field(default=None, ge=0)
    business_reference: Reference | None = None

    @model_validator(mode="after")
    def exact_totals(self):
        with localcontext(FINANCE_CONTEXT):
            if self.amount_ht + self.amount_vat != self.amount_ttc:
                raise ValueError("HT + TVA doit être égal au TTC.")
            if self.amount_ht * self.amount_vat < ZERO:
                raise ValueError("La TVA doit avoir le même signe que le HT.")
            if money(self.amount_ht * self.vat_rate / HUNDRED) != self.amount_vat:
                raise ValueError("Le taux de TVA ne correspond pas au montant transmis.")
        return self


class POSDeclaredTotals(StrictModel):
    amount_ht: Money
    amount_vat: Money
    amount_ttc: Money

    @model_validator(mode="after")
    def consistent(self):
        with localcontext(FINANCE_CONTEXT):
            if self.amount_ht + self.amount_vat != self.amount_ttc:
                raise ValueError("Le total HT plus TVA ne correspond pas au TTC.")
        return self


class POSWebhookPayload(StrictModel):
    event_id: Reference
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    transactions: list[POSLine] = Field(min_length=1, max_length=MAX_CONNECTOR_ROWS)
    totals: POSDeclaredTotals
    checksum: str = Field(pattern=r"^[a-f0-9]{64}$")


class POSWebhookAdapter(BaseDataConnector):
    """Enveloppe POS canonique de ΣIRIUS ; la requête brute est authentifiée par HMAC en amont."""

    source = FinanceIngestionSource.POS_WEBHOOK

    def __init__(self, company_id: str, currency: str):
        super().__init__(company_id, currency)
        self._declared_totals: POSDeclaredTotals | None = None
        self._expected_payload_checksum: str | None = None

    def parse_payload(self, raw_data: dict | bytes) -> list[StandardizedTransaction]:
        payload = _validate_model(POSWebhookPayload, _document(raw_data))
        self._company_currency(payload.currency)
        canonical = payload.model_dump(mode="json", exclude={"checksum"})
        expected = hashlib.sha256(_canonical_json(canonical)).hexdigest()
        if not hmac.compare_digest(payload.checksum, expected):
            raise ConnectorValidationError("Checksum POS invalide.")
        ids = [line.transaction_id for line in payload.transactions]
        if len(set(ids)) != len(ids):
            raise ConnectorValidationError("Identifiants de transactions POS dupliqués.")
        transactions = _validated_transactions([
            TransactionRevenueIn(
                company_id=self.company_id, date=line.date,
                amount_ht=line.amount_ht, amount_ttc=line.amount_ttc, vat_rate=line.vat_rate,
                payment_method=line.payment_method, allocation=line.allocation,
                ticket_count=line.ticket_count, business_reference=line.business_reference,
                source_transaction_id="pos-" + hashlib.sha256(
                    f"{payload.event_id}:{line.transaction_id}".encode("utf-8")
                ).hexdigest(),
            )
            for line in payload.transactions
        ])
        self._declared_totals = payload.totals
        self._expected_payload_checksum = expected
        self._idempotency_key = "pos-" + hashlib.sha256(payload.event_id.encode("utf-8")).hexdigest()
        self._remember(transactions, payload.checksum)
        return transactions

    def validate_checksum_and_totals(self, transactions: list[StandardizedTransaction]) -> bool:
        if not self._validate_fingerprint(transactions) or self._declared_totals is None:
            return False
        if self._expected_payload_checksum is None or self._parsed_checksum is None:
            return False
        with localcontext(FINANCE_CONTEXT):
            sales = [row for row in transactions if isinstance(row, TransactionRevenueIn)]
            return (
                hmac.compare_digest(self._parsed_checksum, self._expected_payload_checksum)
                and sum((row.amount_ht for row in sales), ZERO) == self._declared_totals.amount_ht
                and sum((row.amount_ttc - row.amount_ht for row in sales), ZERO) == self._declared_totals.amount_vat
                and sum((row.amount_ttc for row in sales), ZERO) == self._declared_totals.amount_ttc
            )


BANK_DELIMITERS = (";", "\t", ",")
BANK_HEADER_SCAN_LINES = 30
BANK_MAX_COLUMNS = 40
BANK_LABEL_MAX = 160
BANK_EMPTY_LABEL = "Opération bancaire sans libellé"
BANK_EURO_WORDS = frozenset({"eur", "euro", "euros"})
BANK_SUMMARY_PREFIXES = ("solde", "total", "sous total", "ancien solde", "nouveau solde", "report")
BANK_UNSIGNED_SUSPICION = 5
BANK_DIRECTIONS = {
    **dict.fromkeys(("-", "d", "db", "dr", "deb", "debit", "debiteur", "sortie", "decaissement"), -1),
    **dict.fromkeys(("+", "c", "cr", "cred", "credit", "crediteur", "entree", "encaissement"), 1),
}
SPREADSHEET_SIGNATURES = (b"PK\x03\x04", b"\xd0\xcf\x11\xe0")
BANK_DATE = re.compile(
    r"(?:(?P<iso_year>\d{4})[-/.](?P<iso_month>\d{1,2})[-/.](?P<iso_day>\d{1,2})"
    r"|(?P<day>\d{1,2})[-/.](?P<month>\d{1,2})[-/.](?P<year>\d{4}|\d{2}))"
    r"(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?"
)
BANK_AMOUNT = re.compile(
    r"(?P<sign>[+-]?)(?P<before>€|eur)?(?P<inner_sign>[+-]?)(?P<number>[0-9.,]+)(?P<after>€|eur)?",
    re.IGNORECASE,
)
BANK_NUMBER_FORMATS = (
    (re.compile(r"\d{1,3}(?:\.\d{3})+,\d{1,2}"), ".", ","),
    (re.compile(r"\d{1,3}(?:,\d{3})+\.\d{1,2}"), ",", "."),
    (re.compile(r"\d+,\d{1,2}"), "", ","),
    (re.compile(r"\d+(?:\.\d{1,2})?"), "", "."),
)


def _aliases(target: str, rank: int, *names: str) -> dict[str, tuple[str, int]]:
    return {name: (target, rank) for name in names}


# Quand une banque exporte plusieurs colonnes candidates, le rang le plus bas l'emporte (date d'opération avant date de valeur).
BANK_HEADER_ALIASES: dict[str, tuple[str, int]] = {
    **_aliases("date", 0, "date operation", "date de l operation", "date d operation", "date de la transaction",
               "date transaction", "dateop", "operation date", "transaction date", "booking date"),
    **_aliases("date", 1, "date"),
    **_aliases("date", 2, "date comptable", "date de comptabilisation", "date comptabilisation",
               "date d ecriture", "date ecriture", "settlement date"),
    **_aliases("date", 3, "date valeur", "date de valeur", "dateval", "value date"),
    **_aliases("label", 0, "libelle operation", "libelle de l operation", "libelle complet"),
    **_aliases("label", 1, "libelle", "intitule", "label", "wording"),
    **_aliases("label", 2, "description"),
    **_aliases("label", 3, "libelle simplifie", "libelle court", "nature de l operation", "nature operation"),
    **_aliases("detail", 0, "detail", "details", "detail de l ecriture", "communication"),
    **_aliases("debit", 0, "debit", "debits", "montant debit", "debit montant", "sortie", "sorties",
               "decaissement", "decaissements", "withdrawal", "withdrawals"),
    **_aliases("credit", 0, "credit", "credits", "montant credit", "credit montant", "entree", "entrees",
               "encaissement", "encaissements", "deposit", "deposits"),
    **_aliases("amount", 0, "montant operation", "montant de l operation"),
    **_aliases("amount", 1, "montant", "montant net", "amount", "somme"),
    **_aliases("reference", 0, "reference", "ref", "reference operation", "reference de l operation", "transaction id"),
    **_aliases("reference", 1, "numero d operation", "numero operation", "n d operation", "no d operation",
               "numero de piece", "piece"),
    **_aliases("currency", 0, "devise", "currency", "monnaie"),
    **_aliases("direction", 0, "sens", "sens operation", "sens de l operation", "sens du mouvement",
               "d c", "c d", "side", "direction"),
}


def _folded(value: str) -> str:
    text = "".join(
        char for char in unicodedata.normalize("NFKD", value.casefold())
        if not unicodedata.combining(char)
    )
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())


def _excel_text(value: str) -> str:
    text = value.strip()
    if len(text) >= 3 and text.startswith('="') and text.endswith('"'):
        text = text[2:-1].strip()
    return text


def _clean_text(value: str, limit: int) -> str:
    text = " ".join("".join(
        " " if unicodedata.category(char).startswith("C") else char for char in value
    ).split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _bank_header_name(value: str) -> tuple[str, bool]:
    words = _folded(_excel_text(value)).split()
    euro = "€" in value
    if words and words[-1] in BANK_EURO_WORDS:
        words.pop()
        euro = True
    if euro and words and words[-1] == "en":
        words.pop()
    return " ".join(words), euro


def _bank_number(text: str) -> Decimal | None:
    for pattern, thousands, decimal_mark in BANK_NUMBER_FORMATS:
        if pattern.fullmatch(text):
            if thousands:
                text = text.replace(thousands, "")
            return money(Decimal(text.replace(decimal_mark, ".")))
    return None


def _bank_date(value: str) -> date | None:
    match = BANK_DATE.fullmatch(value.strip())
    if match is None:
        return None
    if match["iso_year"]:
        year, month, day = match["iso_year"], match["iso_month"], match["iso_day"]
    else:
        year, month, day = match["year"], match["month"], match["day"]
        if len(year) == 2:
            year = "20" + year
    try:
        return date(int(year), int(month), int(day))
    except ValueError:
        return None


def _is_summary(value: str) -> bool:
    text = _folded(value)
    return any(text == prefix or text.startswith(prefix + " ") for prefix in BANK_SUMMARY_PREFIXES)


def _direction(value: str) -> int | None:
    text = value.strip()
    return BANK_DIRECTIONS.get(text if text in {"-", "+"} else _folded(text))


def _plural(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def _fr_money(value: Decimal, currency: str) -> str:
    """Affichage français : espace fine insécable entre milliers, virgule décimale, devise après une espace insécable."""
    units, cents = f"{abs(value):.2f}".split(".")
    grouped = f"{int(units):,}".replace(",", "\u202f")
    sign = "-" if value < ZERO else ""
    return f"{sign}{grouped},{cents}\u00a0{'€' if currency == 'EUR' else currency}"


def _currency_code(value: str) -> str:
    code = value.strip().upper()
    return "EUR" if code in {"€", "EURO", "EUROS"} else code


def _statement_text(raw_data: dict | bytes, kind: str) -> str:
    if not isinstance(raw_data, bytes) or not raw_data or len(raw_data) > MAX_CONNECTOR_PAYLOAD_BYTES:
        raise ConnectorValidationError(f"Un fichier {kind} non vide de 5 Mio au plus est requis.")
    if raw_data.startswith(SPREADSHEET_SIGNATURES):
        raise ConnectorValidationError(f"Classeur Excel détecté : exportez le relevé au format {kind}.")
    encodings = ("utf-16",) if raw_data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else ("utf-8-sig", "cp1252")
    for encoding in encodings:
        try:
            text = raw_data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ConnectorValidationError("Encodage du relevé non reconnu : UTF-8, UTF-16 ou Windows-1252 attendu.")
    if "\x00" in text:
        raise ConnectorValidationError("Octet NUL dans le relevé : fichier binaire ou encodage non pris en charge.")
    return text.removeprefix("\ufeff")


@dataclass(frozen=True)
class _StatementLine:
    where: str
    day: date
    label: str
    amount: Decimal
    reference: str | None
    identity: dict[str, str]


class _BankStatementAdapter(BaseDataConnector):
    """Un relevé bancaire ne crée que des mouvements de trésorerie : jamais de ventes, d'achats, de montants HT ni de TVA."""

    id_prefix = "bank"

    @property
    def idempotency_key(self) -> str | None:
        return self._parsed_checksum

    def _amount(self, value: str, *, where: str, column: str) -> Decimal | None:
        text = "".join(value.split())
        if not text:
            return None
        match = BANK_AMOUNT.fullmatch(text)
        number = None
        if match is not None and not (match["sign"] and match["inner_sign"]):
            number = _bank_number(match["number"])
        if match is None or number is None:
            raise ConnectorValidationError(f"{where}, colonne « {column} » : montant invalide « {value.strip()[:40]} ».")
        if match["before"] or match["after"]:
            self._company_currency("EUR")
        return -number if "-" in (match["sign"], match["inner_sign"]) else number

    def _movements(
        self, raw_data: bytes, lines: list[_StatementLine], *,
        notes: list[str] | None = None, warnings: list[str] | None = None,
    ) -> list[StandardizedTransaction]:
        if not lines:
            raise ConnectorValidationError("Le relevé ne contient aucune écriture exploitable.")
        if len(lines) > MAX_CONNECTOR_ROWS:
            raise ConnectorValidationError(f"Plus de {MAX_CONNECTOR_ROWS} écritures : découpez le relevé par période.")
        occurrences: Counter[str] = Counter()
        rows: list[StandardizedTransaction] = []
        for line in lines:
            basis = _canonical_json(line.identity).decode("utf-8")
            occurrences[basis] += 1
            external_id = f"{self.id_prefix}-" + hashlib.sha256(
                f"{basis}:{occurrences[basis]}".encode("utf-8")
            ).hexdigest()
            try:
                rows.append(CashMovementIn(
                    company_id=self.company_id, date=line.day, label=line.label, amount=line.amount,
                    business_reference=line.reference, source_transaction_id=external_id,
                ))
            except ValidationError as error:
                fields = ", ".join(str(item["loc"][0]) for item in error.errors(include_input=False)[:4])
                raise ConnectorValidationError(f"{line.where} : écriture invalide ({fields}).") from error
        with localcontext(FINANCE_CONTEXT):
            self._declared_debit = -sum((line.amount for line in lines if line.amount < ZERO), ZERO)
            self._declared_credit = sum((line.amount for line in lines if line.amount > ZERO), ZERO)
        self._declared_count = len(lines)
        days = [line.day for line in lines]
        self.import_notes = (
            f"Relevé du {min(days):%d/%m/%Y} au {max(days):%d/%m/%Y} : "
            f"{_plural(len(lines), 'écriture lue', 'écritures lues')} — débits "
            f"{_fr_money(self._declared_debit, self.currency)}, crédits {_fr_money(self._declared_credit, self.currency)}.",
            *(notes or ()),
        )
        self.import_warnings = tuple(warnings or ())
        self._remember(rows, hashlib.sha256(raw_data).hexdigest())
        return rows

    def validate_checksum_and_totals(self, transactions: list[StandardizedTransaction]) -> bool:
        if not self._validate_fingerprint(transactions):
            return False
        if any(not isinstance(row, CashMovementIn) or row.amount == ZERO for row in transactions):
            return False
        if len({row.source_transaction_id for row in transactions}) != self._declared_count:
            return False
        with localcontext(FINANCE_CONTEXT):
            debit = -sum((row.amount for row in transactions if row.amount < ZERO), ZERO)
            credit = sum((row.amount for row in transactions if row.amount > ZERO), ZERO)
            return debit == self._declared_debit and credit == self._declared_credit


@dataclass(frozen=True)
class _CSVLayout:
    delimiter: str
    header_line: int
    width: int
    columns: dict[str, int]
    headers: dict[str, str]
    euro: bool


def _csv_layout(cells: list[str], delimiter: str, header_line: int) -> _CSVLayout | None:
    chosen: dict[str, tuple[int, int, bool]] = {}
    ties: dict[str, list[str]] = {}
    for index, cell in enumerate(cells):
        name, euro = _bank_header_name(cell)
        alias = BANK_HEADER_ALIASES.get(name)
        if alias is None:
            continue
        target, rank = alias
        current = chosen.get(target)
        if current is None or rank < current[0]:
            chosen[target] = (rank, index, euro)
            ties.pop(target, None)
        elif rank == current[0]:
            ties.setdefault(target, [_excel_text(cells[current[1]])]).append(_excel_text(cell))
    if {"debit", "credit"} <= chosen.keys():
        amounts: tuple[str, ...] = ("debit", "credit")
    elif "amount" in chosen:
        amounts = ("amount",)
    else:
        return None
    if "label" not in chosen and "detail" in chosen:
        chosen["label"] = chosen.pop("detail")
        if "detail" in ties:
            ties["label"] = ties.pop("detail")
    if not {"date", "label"} <= chosen.keys():
        return None
    extras = ("detail", "reference", "currency") + (("direction",) if amounts == ("amount",) else ())
    used = [target for target in ("date", "label", *amounts, *extras) if target in chosen]
    for target in used:
        if target in ties:
            raise ConnectorValidationError(
                "En-têtes ambigus : " + " / ".join(f"« {name} »" for name in ties[target])
                + ". Supprimez ou renommez la colonne en double."
            )
    return _CSVLayout(
        delimiter=delimiter, header_line=header_line, width=len(cells),
        columns={target: chosen[target][1] for target in used},
        headers={target: _excel_text(cells[chosen[target][1]]) for target in used},
        euro=any(chosen[target][2] for target in amounts),
    )


def _find_csv_layout(lines: list[str]) -> _CSVLayout:
    for index, line in enumerate(lines[:BANK_HEADER_SCAN_LINES]):
        for delimiter in BANK_DELIMITERS:
            if delimiter not in line:
                continue
            try:
                cells = next(csv.reader([line], delimiter=delimiter, strict=True), [])
            except csv.Error:
                continue
            if len(cells) <= BANK_MAX_COLUMNS and (layout := _csv_layout(cells, delimiter, index)):
                return layout
    raise ConnectorValidationError(
        f"En-tête introuvable dans les {BANK_HEADER_SCAN_LINES} premières lignes : "
        "colonnes Date, Libellé et Débit/Crédit (ou Montant signé) attendues."
    )


def _csv_records(lines: list[str], layout: _CSVLayout) -> Iterator[tuple[int, list[str]]]:
    offset = layout.header_line + 1
    reader = csv.reader(lines[offset:], delimiter=layout.delimiter, strict=True)
    while True:
        try:
            record = next(reader)
        except StopIteration:
            return
        except csv.Error as error:
            raise ConnectorValidationError(f"Ligne {offset + reader.line_num} : structure CSV mal formée.") from error
        yield offset + reader.line_num, record


@dataclass(frozen=True)
class _CSVRow:
    where: str
    day: date
    label: str
    detail: str
    reference: str
    amounts: dict[str, Decimal | None]
    direction: int | None


class BankStatementCSVAdapter(_BankStatementAdapter):
    """Exports CSV des banques françaises : en-tête après un éventuel préambule ; colonnes débit/crédit, montant signé, ou montant et sens."""

    source = FinanceIngestionSource.BANK_STATEMENT_CSV
    id_prefix = "bank"

    def parse_payload(self, raw_data: dict | bytes) -> list[StandardizedTransaction]:
        text = _statement_text(raw_data, "CSV")
        lines = list(io.StringIO(text, newline=""))
        layout = _find_csv_layout(lines)
        if layout.euro:
            self._company_currency("EUR")
        last_column = max(layout.columns.values())
        amount_columns = [target for target in ("debit", "credit", "amount") if target in layout.columns]
        rows: list[_CSVRow] = []
        summaries = 0
        for row_number, record in _csv_records(lines, layout):
            where = f"Ligne {row_number}"
            cells = [_excel_text(cell) for cell in record]
            if not any(cells):
                continue
            if len(cells) > layout.width and any(cells[layout.width:]):
                raise ConnectorValidationError(f"{where} : plus de colonnes que l’en-tête.")
            if len(cells) <= last_column:
                raise ConnectorValidationError(f"{where} : colonnes manquantes par rapport à l’en-tête.")
            cell = {target: cells[index] for target, index in layout.columns.items()}
            has_amount = any(cell[target] for target in amount_columns)
            summary = _is_summary(cell["date"]) or _is_summary(cell["label"])
            day = _bank_date(cell["date"])
            if day is None or not has_amount:
                if summary:
                    summaries += 1
                    continue
                if day is None and not (cell["date"] or has_amount):
                    continue
                if day is None:
                    problem = f"invalide « {cell['date'][:20]} »" if cell["date"] else "absente"
                    raise ConnectorValidationError(f"{where} : date {problem} (JJ/MM/AAAA ou AAAA-MM-JJ attendu).")
                raise ConnectorValidationError(f"{where} : montant absent.")
            if cell.get("currency"):
                self._company_currency(_currency_code(cell["currency"]))
            rows.append(_CSVRow(
                where, day, cell["label"], cell.get("detail", ""), cell.get("reference", ""),
                {target: self._amount(cell[target], where=where, column=layout.headers[target]) for target in amount_columns},
                self._row_direction(cell, layout, where),
            ))
            if len(rows) > MAX_CONNECTOR_ROWS:
                raise ConnectorValidationError(f"Plus de {MAX_CONNECTOR_ROWS} écritures : découpez le relevé par période.")
        movements = self._signed_lines(rows, layout)
        notes: list[str] = []
        if summaries:
            notes.append(_plural(summaries, "ligne de solde ou de total ignorée", "lignes de solde ou de total ignorées") + ".")
        if zeros := len(rows) - len(movements):
            notes.append(_plural(zeros, "ligne à montant nul ignorée", "lignes à montant nul ignorées") + ".")
        warnings: list[str] = []
        if (
            "amount" in layout.columns and "direction" not in layout.columns
            and len(movements) >= BANK_UNSIGNED_SUSPICION and all(line.amount > ZERO for line in movements)
        ):
            warnings.append(
                f"Aucun montant négatif dans la colonne « {layout.headers['amount']} » sur {len(movements)} écritures : "
                "si la banque n’exporte pas les débits en négatif, les dépenses sont comptées comme des entrées. "
                "Vérifiez le fichier ou utilisez l’export OFX."
            )
        return self._movements(raw_data, movements, notes=notes, warnings=warnings)

    @staticmethod
    def _row_direction(cell: dict[str, str], layout: _CSVLayout, where: str) -> int | None:
        if "direction" not in layout.columns:
            return None
        direction = _direction(cell["direction"])
        if direction is None:
            shown = cell["direction"].strip()[:20]
            raise ConnectorValidationError(
                f"{where} : sens « {shown} » non reconnu (D/Débit ou C/Crédit attendu)." if shown
                else f"{where} : sens absent (colonne « {layout.headers['direction']} »)."
            )
        return direction

    def _signed_lines(self, rows: list[_CSVRow], layout: _CSVLayout) -> list[_StatementLine]:
        if "debit" in layout.columns:
            debits = [(row.where, row.amounts["debit"]) for row in rows if row.amounts["debit"]]
            positive = next((where for where, value in debits if value > ZERO), None)
            negative = next((where for where, value in debits if value < ZERO), None)
            if positive and negative:
                raise ConnectorValidationError(
                    f"Colonne « {layout.headers['debit']} » : montants positifs ({positive}) et négatifs "
                    f"({negative}) mélangés ; impossible de distinguer un débit d’une annulation."
                )
        lines: list[_StatementLine] = []
        for row in rows:
            with localcontext(FINANCE_CONTEXT):
                if "amount" in row.amounts:
                    amount = row.amounts["amount"] or ZERO
                    if row.direction is not None:
                        if amount < ZERO and row.direction > 0:
                            raise ConnectorValidationError(
                                f"{row.where} : montant négatif avec un sens crédit "
                                f"(colonne « {layout.headers['direction']} »)."
                            )
                        amount = abs(amount) if row.direction > 0 else -abs(amount)
                else:
                    debit, credit = abs(row.amounts["debit"] or ZERO), row.amounts["credit"] or ZERO
                    if credit < ZERO:
                        raise ConnectorValidationError(
                            f"{row.where} : crédit négatif inattendu (colonne « {layout.headers['credit']} »)."
                        )
                    if debit and credit:
                        raise ConnectorValidationError(f"{row.where} : débit et crédit renseignés sur la même ligne.")
                    amount = credit - debit
            if not amount:
                continue
            label = _merged_label(row.label, row.detail)
            reference = _clean_text(row.reference, 160) or None
            lines.append(_StatementLine(row.where, row.day, label, amount, reference, {
                "date": row.day.isoformat(), "label": label, "amount": str(amount), "reference": reference or "",
            }))
        return lines


OFX_ROOT = re.compile(r"<OFX>", re.IGNORECASE)
OFX_STATEMENT_KIND = re.compile(r"<(STMTRS|CCSTMTRS|INVSTMTRS)>", re.IGNORECASE)
OFX_BANK_STATEMENT = re.compile(r"<STMTRS>(?P<body>.*?)</STMTRS>", re.IGNORECASE | re.DOTALL)
OFX_TRANSACTION_START = re.compile(r"<STMTTRN>", re.IGNORECASE)
OFX_TRANSACTION = re.compile(r"<STMTTRN>(?P<body>.*?)</STMTTRN>", re.IGNORECASE | re.DOTALL)
OFX_FOREIGN_CURRENCY = re.compile(r"<CURRENCY>", re.IGNORECASE)
OFX_LEDGER_BALANCE = re.compile(r"<LEDGERBAL>(?P<body>.*?)</LEDGERBAL>", re.IGNORECASE | re.DOTALL)
OFX_LEAF = re.compile(r"<(?P<tag>[A-Za-z0-9.]+)>(?P<value>[^<]*)")
OFX_DATE = re.compile(
    r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})(?:\d{4}(?:\d{2}(?:\.\d{1,3})?)?)?(?:\[[^\]]*\])?"
)
OFX_AMOUNT = re.compile(r"[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)")


def _ofx_fields(body: str) -> dict[str, str]:
    """Première valeur non vide de chaque élément : les feuilles SGML n'ont pas de balise fermante, celles du XML en ont une."""
    fields: dict[str, str] = {}
    for match in OFX_LEAF.finditer(body):
        value = " ".join(html.unescape(match["value"]).split())
        if value:
            fields.setdefault(match["tag"].upper(), value)
    return fields


def _ofx_date(value: str) -> date | None:
    match = OFX_DATE.fullmatch(value.strip())
    if match is None:
        return None
    try:
        return date(int(match["year"]), int(match["month"]), int(match["day"]))
    except ValueError:
        return None


def _ofx_amount(value: str) -> Decimal | None:
    text = "".join(value.split())
    if not OFX_AMOUNT.fullmatch(text):
        return None
    amount = Decimal(text.replace(",", "."))
    exact = money(amount)
    return exact if exact == amount else None


def _merged_label(primary: str, secondary: str) -> str:
    """Libellé court suivi de son détail (CSV), ou NAME suivi de MEMO (OFX), sans répéter un préfixe commun."""
    primary, secondary = _clean_text(primary, 1000), _clean_text(secondary, 1000)
    if primary and secondary and not secondary.startswith(primary) and not primary.startswith(secondary):
        label = f"{primary} – {secondary}"
    else:
        label = secondary if secondary.startswith(primary) else primary
    return _clean_text(label, BANK_LABEL_MAX) or BANK_EMPTY_LABEL


class BankStatementOFXAdapter(_BankStatementAdapter):
    """Relevé OFX/Money (SGML 1.x ou XML 2.x) d'un seul compte bancaire ; le FITID fournit une identité stable."""

    source = FinanceIngestionSource.BANK_STATEMENT_OFX
    id_prefix = "ofx"

    def parse_payload(self, raw_data: dict | bytes) -> list[StandardizedTransaction]:
        text = _statement_text(raw_data, "OFX")
        if not OFX_ROOT.search(text):
            raise ConnectorValidationError("Fichier OFX invalide : balise <OFX> absente.")
        kinds = Counter(match[1].upper() for match in OFX_STATEMENT_KIND.finditer(text))
        if kinds["CCSTMTRS"] or kinds["INVSTMTRS"]:
            raise ConnectorValidationError(
                "Relevé de carte ou de titres refusé : importez le relevé du compte courant, "
                "où les débits de carte figurent déjà."
            )
        if kinds["STMTRS"] != 1:
            raise ConnectorValidationError(
                "Le fichier OFX contient plusieurs comptes : exportez un compte à la fois."
                if kinds["STMTRS"] else "Aucun relevé de compte bancaire (STMTRS) dans le fichier OFX."
            )
        statement = OFX_BANK_STATEMENT.search(text)
        if statement is None:
            raise ConnectorValidationError("Relevé OFX tronqué : balise </STMTRS> absente.")
        body = statement["body"]
        transactions = list(OFX_TRANSACTION.finditer(body))
        if len(transactions) != len(OFX_TRANSACTION_START.findall(body)):
            raise ConnectorValidationError("Transactions OFX mal formées : balise </STMTTRN> manquante.")
        if len(transactions) > MAX_CONNECTOR_ROWS:
            raise ConnectorValidationError(f"Plus de {MAX_CONNECTOR_ROWS} écritures : découpez le relevé par période.")
        header = _ofx_fields(OFX_TRANSACTION.sub("", body))
        if header.get("CURDEF"):
            self._company_currency(_currency_code(header["CURDEF"]))
        account = header.get("ACCTID", "")
        lines: list[_StatementLine] = []
        zeros = 0
        for number, transaction in enumerate(transactions, 1):
            content = transaction["body"]
            fields = _ofx_fields(content)
            fitid = fields.get("FITID", "")
            where = f"Transaction OFX {number}" + (f" (FITID {fitid[:40]})" if fitid else "")
            foreign = OFX_FOREIGN_CURRENCY.search(content)
            if foreign is not None:
                symbol = _ofx_fields(content[foreign.end():]).get("CURSYM", "")
                if _currency_code(symbol) != self.currency:
                    raise ConnectorValidationError(
                        f"{where} : montant exprimé en {symbol or 'devise inconnue'}, attendu {self.currency}."
                    )
            day = _ofx_date(fields.get("DTPOSTED", ""))
            if day is None:
                raise ConnectorValidationError(f"{where} : date DTPOSTED absente ou invalide.")
            amount = _ofx_amount(fields.get("TRNAMT", ""))
            if amount is None:
                raise ConnectorValidationError(f"{where} : montant TRNAMT absent ou non exprimé au centime.")
            if not amount:
                zeros += 1
                continue
            label = _merged_label(fields.get("NAME", ""), fields.get("MEMO", ""))
            reference = _clean_text(
                f"Chèque {fields['CHECKNUM']}" if fields.get("CHECKNUM") else fields.get("REFNUM", ""), 160,
            ) or None
            identity = (
                {"account": account, "fitid": fitid, "date": day.isoformat(), "amount": str(amount)} if fitid
                else {"date": day.isoformat(), "label": label, "amount": str(amount), "reference": reference or ""}
            )
            lines.append(_StatementLine(where, day, label, amount, reference, identity))
        notes = [_plural(zeros, "transaction à montant nul ignorée", "transactions à montant nul ignorées") + "."] if zeros else []
        if (ledger := OFX_LEDGER_BALANCE.search(body)) is not None:
            balance_fields = _ofx_fields(ledger["body"])
            balance = _ofx_amount(balance_fields.get("BALAMT", ""))
            as_of = _ofx_date(balance_fields.get("DTASOF", ""))
            if balance is not None:
                notes.append(
                    f"Solde comptable déclaré par la banque : {_fr_money(balance, self.currency)}"
                    + (f" au {as_of:%d/%m/%Y}." if as_of else ".")
                )
        return self._movements(raw_data, lines, notes=notes)


class InvoiceLine(StrictModel):
    line_id: Reference
    amount_ht: Money
    amount_vat: Money
    category: CategorieExpense = Field(strict=False)
    allocation: AllocationEnum = Field(default=AllocationEnum.OTHER, strict=False)
    business_reference: Reference | None = None
    deductible_vat: Money = ZERO

    @model_validator(mode="after")
    def coherent(self):
        with localcontext(FINANCE_CONTEXT):
            if self.amount_ht * self.amount_vat < ZERO:
                raise ValueError("La TVA doit avoir le même signe que le HT.")
            if self.amount_vat * self.deductible_vat < ZERO or abs(self.deductible_vat) > abs(self.amount_vat):
                raise ValueError("TVA déductible hors bornes.")
        if self.allocation != AllocationEnum.OTHER and self.category != CategorieExpense.MATIERE_PREMIERE:
            raise ValueError("Ventilation de stock réservée aux achats de matières ou de marchandises.")
        return self


class InvoiceTotals(StrictModel):
    amount_ht: Money
    amount_vat: Money
    amount_ttc: Money

    @model_validator(mode="after")
    def coherent(self):
        with localcontext(FINANCE_CONTEXT):
            if self.amount_ht + self.amount_vat != self.amount_ttc:
                raise ValueError("HT + TVA doit être égal au TTC.")
        return self


class InvoiceOCRPayload(StrictModel):
    invoice_id: Reference
    supplier: str = Field(min_length=1, max_length=160)
    date: IsoDate
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    lines: list[InvoiceLine] = Field(min_length=1, max_length=500)
    totals: InvoiceTotals
    checksum: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class InvoiceOCRAdapter(BaseDataConnector):
    """Importe les valeurs OCR comme achats à vérifier ; l'OCR n'autorise jamais la déduction de TVA."""

    source = FinanceIngestionSource.INVOICE_OCR

    def __init__(self, company_id: str, currency: str):
        super().__init__(company_id, currency)
        self._declared_totals: InvoiceTotals | None = None
        self._warning_checksum: str | None = None
        self._expected_payload_checksum: str | None = None

    def parse_payload(self, raw_data: dict | bytes) -> list[StandardizedTransaction]:
        payload = _validate_model(InvoiceOCRPayload, _document(raw_data))
        self._company_currency(payload.currency)
        canonical = payload.model_dump(mode="json", exclude={"checksum"})
        expected = hashlib.sha256(_canonical_json(canonical)).hexdigest()
        if payload.checksum is not None and not hmac.compare_digest(payload.checksum, expected):
            raise ConnectorValidationError("Checksum de facture invalide.")
        ids = [line.line_id for line in payload.lines]
        if len(set(ids)) != len(ids):
            raise ConnectorValidationError("Identifiants de lignes de facture dupliqués.")
        transactions = _validated_transactions([
            PurchaseExpenseIn(
                company_id=self.company_id, date=payload.date, supplier=payload.supplier,
                amount_ht=line.amount_ht, amount_vat=line.amount_vat,
                amount_ttc=money(line.amount_ht + line.amount_vat),
                deductible_vat=line.deductible_vat, category=line.category,
                allocation=line.allocation, business_reference=line.business_reference,
                source_transaction_id="ocr-" + hashlib.sha256(
                    f"{payload.invoice_id}:{line.line_id}".encode("utf-8")
                ).hexdigest(),
            )
            for line in payload.lines
        ])
        self._declared_totals = payload.totals
        self._warning_checksum = payload.checksum
        self._expected_payload_checksum = expected
        self._idempotency_key = "ocr-" + hashlib.sha256(payload.invoice_id.encode("utf-8")).hexdigest()
        self._remember(transactions, payload.checksum)
        return transactions

    def validate_checksum_and_totals(self, transactions: list[StandardizedTransaction]) -> bool:
        if not self._validate_fingerprint(transactions) or self._declared_totals is None:
            return False
        if self._warning_checksum is not None and not hmac.compare_digest(
            self._warning_checksum, self._expected_payload_checksum or "",
        ):
            return False
        with localcontext(FINANCE_CONTEXT):
            purchases = [row for row in transactions if isinstance(row, PurchaseExpenseIn)]
            return (
                sum((row.amount_ht for row in purchases), ZERO) == self._declared_totals.amount_ht
                and sum((row.amount_vat for row in purchases), ZERO) == self._declared_totals.amount_vat
                and sum((row.amount_ttc for row in purchases), ZERO) == self._declared_totals.amount_ttc
            )


CONNECTORS: dict[FinanceIngestionSource, type[BaseDataConnector]] = {
    FinanceIngestionSource.POS_WEBHOOK: POSWebhookAdapter,
    FinanceIngestionSource.BANK_STATEMENT_CSV: BankStatementCSVAdapter,
    FinanceIngestionSource.BANK_STATEMENT_OFX: BankStatementOFXAdapter,
    FinanceIngestionSource.INVOICE_OCR: InvoiceOCRAdapter,
}


def connector_factory(source: FinanceIngestionSource, company_id: CompanyId, currency: str) -> BaseDataConnector:
    try:
        connector = CONNECTORS[source]
    except KeyError as error:
        raise ConnectorValidationError("Source d'ingestion non prise en charge.") from error
    return connector(company_id, currency)
