"""Entreprises fictives de démonstration : données déterministes et comptablement cohérentes.

Un petit grand livre en partie double produit, pour chaque secteur, trois exercices complets (2023 à 2025) :
ventes, achats, stocks, salaires, loyers, emprunts, TVA, impôt sur les sociétés, dividendes et amortissements.
Les pièces exposées au moteur sont lues dans ce grand livre : la trésorerie du tableau de bord égale celle
des bilans et l'actif égale le passif. Aucun flottant ; l'aléa est dérivé de SHA-256, donc reproductible.
"""
import hashlib
import threading
from collections import defaultdict
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, localcontext
from functools import lru_cache

from kpi_engine import FinanceDataset, add_months, build_report, month_end
from schemas.finance import (
    AllocationEnum, BalanceSheetSnapshotIn, CashBalanceIn, CashMovementIn, CategorieExpense, CompanyProfileIn,
    ComparisonMode, DemoCatalog, DemoCompanySummary, FINANCE_CONTEXT, FinanceDashboard, HUNDRED, InventorySnapshotIn,
    OverheadCategory, PaymentMethod, Period, PurchaseExpenseIn, RecurringOverheadIn, SectorEnum, TransactionRevenueIn,
    ZERO, money,
)

DEMO_START = date(2023, 1, 1)
DEMO_END = date(2025, 12, 31)
OPENING_DATE = date(2022, 12, 31)
YEARS = (2023, 2024, 2025)
ONE = Decimal("1")
TWO = Decimal("2")
TWELVE = Decimal("12")
REDUCED_TAX_CEILING = Decimal("42500")
REDUCED_TAX_RATE = Decimal("0.15")
STANDARD_TAX_RATE = Decimal("0.25")
TAX_INSTALMENT_THRESHOLD = Decimal("3000")
NET_SALARY_RATE = Decimal("0.78")
TAX_ACCOUNTS = ("vat", "vat_pending", "social", "corporate_tax")
BALANCE_ACCOUNTS = (
    "fixed_assets", "inventory", "receivables", "cash", "payables", *TAX_ACCOUNTS, "loans", "equity",
)
INCOME_ACCOUNTS = (
    "revenue", "purchases", "subcontracting", "supplies", "stock_variation", "external", "payroll",
    "social_charges", "interest", "depreciation", "income_tax",
)
OPERATING_ACCOUNTS = tuple(a for a in INCOME_ACCOUNTS if a not in ("interest", "depreciation", "income_tax"))
EXPENSE_ACCOUNTS = {
    CategorieExpense.MATIERE_PREMIERE: "purchases", CategorieExpense.SOUS_TRAITANCE: "subcontracting",
    CategorieExpense.FOURNITURES: "supplies", CategorieExpense.FRAIS_GENERAUX: "external",
    CategorieExpense.EQUIPEMENT: "fixed_assets",
}
MONTH_NAMES = (
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
)


def unit(*parts: object) -> Decimal:
    """Valeur reproductible dans [0 ; 1], au pas de 1/10 000."""
    digest = hashlib.sha256("|".join(map(str, parts)).encode("utf-8")).digest()
    return Decimal(int.from_bytes(digest[:8], "big") % 10001) / Decimal(10000)


def jitter(permille: int, *parts: object) -> Decimal:
    """Facteur reproductible dans [1 − p/1000 ; 1 + p/1000]."""
    with localcontext(FINANCE_CONTEXT):
        return ONE + Decimal(permille) * (TWO * unit(*parts) - ONE) / Decimal(1000)


def easter(year: int) -> date:
    """Dimanche de Pâques grégorien (algorithme anonyme de Meeus, Jones et Butcher)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


@lru_cache(maxsize=None)
def public_holidays(year: int) -> frozenset[date]:
    sunday = easter(year)
    return frozenset({
        date(year, 1, 1), sunday + timedelta(days=1), date(year, 5, 1), date(year, 5, 8),
        sunday + timedelta(days=39), sunday + timedelta(days=50), date(year, 7, 14), date(year, 8, 15),
        date(year, 11, 1), date(year, 11, 11), date(year, 12, 25),
    })


def days_between(start: date, end: date) -> Iterator[date]:
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def month_starts(start: date, end: date) -> Iterator[date]:
    current = date(start.year, start.month, 1)
    while current <= end:
        yield current
        current = add_months(current, 1)


def working_days(month: date) -> list[date]:
    holidays = public_holidays(month.year)
    return [d for d in days_between(month, month_end(month)) if d.weekday() < 5 and d not in holidays]


def last_working_day(month: date) -> date:
    return working_days(month)[-1]


def business_day(day: date) -> date:
    """Premier jour ouvré bancaire à partir de cette date (week-ends et jours fériés exclus)."""
    while day.weekday() >= 5 or day in public_holidays(day.year):
        day += timedelta(days=1)
    return day


def weekday_in_month(year: int, month: int, weekday: int, occurrence: int) -> date:
    """occurrence 1 = premier jour de ce type dans le mois ; -1 = dernier."""
    if occurrence > 0:
        first = date(year, month, 1)
        return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (occurrence - 1))
    last = month_end(date(year, month, 1))
    return last - timedelta(days=(last.weekday() - weekday) % 7 + 7 * (-occurrence - 1))


def month_label(month: date) -> str:
    return f"{MONTH_NAMES[month.month - 1]} {month.year}"


def split_amount(total: Decimal, weights: Sequence[Decimal]) -> list[Decimal]:
    """Répartit un montant au centime près ; la dernière part absorbe l'arrondi."""
    with localcontext(FINANCE_CONTEXT):
        whole = sum(weights, ZERO)
        parts = [money(total * weight / whole) for weight in weights[:-1]]
        parts.append(total - sum(parts, ZERO))
    return parts


def half_days(value: Decimal) -> Decimal:
    with localcontext(FINANCE_CONTEXT):
        return (value * TWO).quantize(ONE) / TWO


def corporate_tax(profit: Decimal) -> Decimal:
    """IS français des PME : 15 % jusqu'à 42 500 €, 25 % au-delà ; aucun impôt sur une perte."""
    if profit <= ZERO:
        return ZERO
    with localcontext(FINANCE_CONTEXT):
        reduced = min(profit, REDUCED_TAX_CEILING)
        return money(reduced * REDUCED_TAX_RATE + (profit - reduced) * STANDARD_TAX_RATE)


@dataclass(frozen=True)
class Instalment:
    number: int
    due: date
    payment: Decimal
    interest: Decimal
    principal: Decimal
    remaining: Decimal


def amortization(principal: Decimal, annual_rate_pct: Decimal, months: int, first_due: date) -> tuple[Instalment, ...]:
    """Échéances constantes ; intérêts arrondis au centime, dernière échéance ajustée au capital restant."""
    rows: list[Instalment] = []
    with localcontext(FINANCE_CONTEXT):
        rate = annual_rate_pct / HUNDRED / TWELVE
        payment = money(principal * rate / (ONE - (ONE + rate) ** -months)) if rate else money(principal / months)
        remaining = principal
        for number in range(1, months + 1):
            interest = money(remaining * rate)
            amortized = payment - interest if number < months else remaining
            remaining -= amortized
            rows.append(Instalment(number, add_months(first_due, number - 1), interest + amortized, interest, amortized, remaining))
    return tuple(rows)


@dataclass(frozen=True)
class FixedAsset:
    label: str
    acquired: date
    cost: Decimal
    years: int | None

    def depreciation_to(self, year_end: date) -> Decimal:
        """Amortissement linéaire cumulé, mois d'acquisition compris ; un fonds de commerce n'est pas amorti."""
        if self.years is None or year_end < self.acquired:
            return ZERO
        months = (year_end.year - self.acquired.year) * 12 + year_end.month - self.acquired.month + 1
        with localcontext(FINANCE_CONTEXT):
            return min(self.cost, money(self.cost * Decimal(months) / Decimal(self.years * 12)))


@dataclass(frozen=True)
class Posting:
    day: date
    phase: int
    lines: tuple[tuple[str, Decimal], ...]
    label: str
    reference: str | None


class Ledger:
    """Grand livre en partie double ; soldes signés au débit (un passif est négatif)."""

    def __init__(self) -> None:
        self.postings: list[Posting] = []

    def post(
        self, day: date, label: str, lines: Mapping[str, Decimal], *, reference: str | None = None, phase: int = 0,
    ) -> None:
        cleaned = tuple((account, amount) for account, amount in lines.items() if amount)
        if not DEMO_START <= day <= DEMO_END:
            raise ValueError(f"Écriture hors de la fenêtre de démonstration : {label} au {day}")
        if any(account not in BALANCE_ACCOUNTS and account not in INCOME_ACCOUNTS for account, _ in cleaned):
            raise ValueError(f"Compte inconnu : {label}")
        if any(amount != money(amount) for _, amount in cleaned):
            raise ValueError(f"Montant non arrondi au centime : {label}")
        if sum((amount for _, amount in cleaned), ZERO) != ZERO:
            raise ValueError(f"Écriture déséquilibrée : {label}")
        if cleaned:
            self.postings.append(Posting(day, phase, cleaned, label[:160], reference))


@dataclass(frozen=True)
class DemoYear:
    """Comptes annuels issus du grand livre en partie double (contrôle indépendant du moteur de KPI)."""
    year: int
    revenue_ht: Decimal
    ebe: Decimal
    depreciation: Decimal
    pretax_income: Decimal
    income_tax: Decimal
    net_income: Decimal
    dividends_paid: Decimal
    dividends_declared: Decimal


@dataclass(frozen=True)
class DemoCompany:
    dataset: FinanceDataset
    description: str
    years: tuple[DemoYear, ...]
    minimum_cash: Decimal
    minimum_cash_date: date


def negate(value: Decimal) -> Decimal:
    """Opposé sans zéro négatif."""
    return ZERO - value


class DemoBuilder:
    """Enregistre chaque pièce exposée au moteur et son écriture comptable, puis clôture les exercices."""

    def __init__(self, company: CompanyProfileIn, opening: Mapping[str, Decimal], assets: Sequence[FixedAsset] = ()):
        self.company = company
        self.opening: defaultdict[str, Decimal] = defaultdict(lambda: ZERO, opening)
        self.ledger = Ledger()
        self.revenues: list[TransactionRevenueIn] = []
        self.expenses: list[PurchaseExpenseIn] = []
        self.overheads: list[RecurringOverheadIn] = []
        self.inventories: list[InventorySnapshotIn] = []
        self.assets: list[FixedAsset] = list(assets)
        self.receipts: defaultdict[tuple[date, str, str | None], Decimal] = defaultdict(lambda: ZERO)
        self.receipt_vat: defaultdict[tuple[date, str, str | None], Decimal] = defaultdict(lambda: ZERO)

    def sale(
        self, day: date, amount_ht: Decimal, vat_rate: Decimal, method: PaymentMethod, *, settle_on: date,
        receipt: str, allocation: AllocationEnum = AllocationEnum.OTHER, reference: str | None = None,
        tickets: int | None = None, hours: Decimal | None = None, days: Decimal | None = None,
        vat_on_receipt: bool = False,
    ) -> None:
        """Vente HT au taux donné ; l'encaissement est regroupé par jour ouvré, libellé et référence.

        Avec vat_on_receipt (prestations de services, travaux), la TVA devient exigible à l'encaissement.
        """
        with localcontext(FINANCE_CONTEXT):
            vat = money(amount_ht * vat_rate / HUNDRED)
            ttc = amount_ht + vat
        self.revenues.append(TransactionRevenueIn(
            company_id=self.company.id, date=day, amount_ht=amount_ht, amount_ttc=ttc, vat_rate=vat_rate,
            payment_method=method, business_reference=reference, allocation=allocation,
            ticket_count=tickets, hours=hours, days=days,
        ))
        vat_account = "vat_pending" if vat_on_receipt else "vat"
        self.ledger.post(day, "Vente", {"receivables": ttc, "revenue": negate(amount_ht), vat_account: negate(vat)}, reference=reference)
        settle = business_day(settle_on)
        if settle <= DEMO_END:
            self.receipts[(settle, receipt, reference)] += ttc
            if vat_on_receipt:
                self.receipt_vat[(settle, receipt, reference)] += vat

    def purchase(
        self, day: date, supplier: str, amount_ht: Decimal, category: CategorieExpense, *, pay_on: date,
        vat_rate: Decimal = ZERO, allocation: AllocationEnum = AllocationEnum.OTHER, reference: str | None = None,
        asset_label: str | None = None, asset_years: int | None = None,
    ) -> None:
        """Facture fournisseur à TVA entièrement déductible, réglée à l'échéance donnée."""
        with localcontext(FINANCE_CONTEXT):
            vat = money(amount_ht * vat_rate / HUNDRED)
            ttc = amount_ht + vat
        self.expenses.append(PurchaseExpenseIn(
            company_id=self.company.id, date=day, supplier=supplier, amount_ht=amount_ht, amount_vat=vat,
            amount_ttc=ttc, deductible_vat=vat, category=category, allocation=allocation, business_reference=reference,
        ))
        account = EXPENSE_ACCOUNTS[category]
        self.ledger.post(day, f"Facture {supplier}", {account: amount_ht, "vat": vat, "payables": negate(ttc)}, reference=reference)
        if category == CategorieExpense.EQUIPEMENT:
            self.assets.append(FixedAsset(asset_label or supplier, day, amount_ht, asset_years))
        payment = business_day(pay_on)
        if payment <= DEMO_END:
            self.ledger.post(payment, f"Règlement {supplier}", {"payables": ttc, "cash": negate(ttc)}, reference=reference)

    def overhead(
        self, label: str, category: OverheadCategory, monthly_ht: Decimal, start: date, end: date, *,
        vat_rate: Decimal = ZERO, employer: Decimal = ZERO, pay_day: int = 5,
    ) -> None:
        """Charge récurrente sur des mois entiers : mêmes montants que la proratisation du moteur."""
        if start.day != 1 or end != month_end(end):
            raise ValueError("Les charges de démonstration couvrent des mois entiers.")
        self.overheads.append(RecurringOverheadIn(
            company_id=self.company.id, label=label, category=category, monthly_amount_ht=monthly_ht,
            vat_rate=vat_rate, vat_recoverable=vat_rate > ZERO, employer_charges=employer,
            active_from=start, active_to=end,
        ))
        with localcontext(FINANCE_CONTEXT):
            for month in month_starts(start, end):
                if category == OverheadCategory.PAYROLL:
                    net = money(monthly_ht * NET_SALARY_RATE)
                    contributions = monthly_ht - net + employer
                    self.ledger.post(last_working_day(month), f"Salaires nets de {month_label(month)} — {label}", {
                        "payroll": monthly_ht, "social_charges": employer,
                        "cash": negate(net), "social": negate(contributions),
                    })
                    due = business_day(add_months(month, 1).replace(day=15))
                    if due <= DEMO_END:
                        self.ledger.post(due, f"Cotisations sociales et prélèvement à la source de {month_label(month)}", {
                            "social": contributions, "cash": negate(contributions),
                        })
                else:
                    vat = money(monthly_ht * vat_rate / HUNDRED)
                    self.ledger.post(business_day(month.replace(day=pay_day)), f"{label} — {month_label(month)}", {
                        "external": monthly_ht, "vat": vat, "cash": negate(monthly_ht + vat),
                    })

    def loan(
        self, label: str, principal: Decimal, rate_pct: Decimal, months: int, first_due: date, *, disbursed: date,
    ) -> tuple[Instalment, ...]:
        """Emprunt amortissable : une charge LOAN par échéance, capital et intérêts exacts."""
        schedule = amortization(principal, rate_pct, months, first_due)
        if disbursed < DEMO_START:
            outstanding = principal
            for item in schedule:
                if item.due < DEMO_START:
                    outstanding = item.remaining
            self.opening["loans"] -= outstanding
        elif disbursed <= DEMO_END:
            self.ledger.post(disbursed, f"Déblocage {label}", {"cash": principal, "loans": negate(principal)})
        for item in schedule:
            if DEMO_START <= item.due <= DEMO_END:
                start = item.due.replace(day=1)
                self.overheads.append(RecurringOverheadIn(
                    company_id=self.company.id, label=f"{label} — échéance {item.number}/{months}",
                    category=OverheadCategory.LOAN, monthly_amount_ht=item.payment, loan_principal=item.principal,
                    active_from=start, active_to=month_end(start),
                ))
                self.ledger.post(business_day(item.due), f"Échéance {item.number}/{months} — {label}", {
                    "loans": item.principal, "interest": item.interest, "cash": negate(item.payment),
                })
        return schedule

    def credit_line(self, label: str, principal: Decimal, rate_pct: Decimal, disbursed: date, repaid: date) -> None:
        """Crédit court terme in fine : intérêts mensuels en frais financiers, capital hors annuités d'emprunt."""
        with localcontext(FINANCE_CONTEXT):
            interest = money(principal * rate_pct / HUNDRED / TWELVE)
        self.ledger.post(disbursed, f"Déblocage {label}", {"cash": principal, "loans": negate(principal)})
        for month in month_starts(disbursed, repaid):
            self.overheads.append(RecurringOverheadIn(
                company_id=self.company.id, label=f"{label} — intérêts de {month_label(month)}",
                category=OverheadCategory.LOAN, monthly_amount_ht=interest, active_from=month, active_to=month_end(month),
            ))
            self.ledger.post(last_working_day(month), f"Intérêts {label} — {month_label(month)}", {
                "interest": interest, "cash": negate(interest),
            })
        self.ledger.post(business_day(repaid), f"Remboursement {label}", {"loans": principal, "cash": negate(principal)})

    def stock_level(self, day: date, allocation: AllocationEnum, value: Decimal) -> None:
        self.inventories.append(InventorySnapshotIn(company_id=self.company.id, date=day, allocation=allocation, value=value))

    def stock_change(self, day: date, allocation: AllocationEnum, change: Decimal) -> None:
        self.ledger.post(day, f"Variation de stock {allocation.value}", {"inventory": change, "stock_variation": negate(change)})

    def collect(self, day: date, amount: Decimal, label: str, vat_part: Decimal = ZERO) -> None:
        """Encaissement d'une créance ; vat_part rend exigible la TVA attachée (TVA sur les encaissements)."""
        self.ledger.post(business_day(day), label, {
            "cash": amount, "receivables": negate(amount), "vat_pending": vat_part, "vat": negate(vat_part),
        })

    def pay(self, day: date, amount: Decimal, label: str, account: str = "payables") -> None:
        self.ledger.post(business_day(day), label, {account: amount, "cash": negate(amount)})

    def balance_sheet(self, day: date, balances: Mapping[str, Decimal]) -> BalanceSheetSnapshotIn:
        """Bilan simplifié lu dans le grand livre : soldes débiteurs à l'actif, créditeurs au passif."""
        if any(balances[account] for account in INCOME_ACCOUNTS):
            raise ValueError(f"Comptes de résultat non soldés au {day}.")
        if balances["receivables"] < ZERO or balances["payables"] > ZERO or balances["loans"] > ZERO:
            raise ValueError(f"Solde de tiers inattendu au {day}.")
        with localcontext(FINANCE_CONTEXT):
            tax_social = sum((negate(balances[a]) for a in TAX_ACCOUNTS if balances[a] < ZERO), ZERO)
            other_assets = sum((balances[a] for a in TAX_ACCOUNTS if balances[a] > ZERO), ZERO)
            total = balances["fixed_assets"] + balances["inventory"] + balances["receivables"] + balances["cash"] + other_assets
            sheet = BalanceSheetSnapshotIn(
                company_id=self.company.id, date=day, equity=negate(balances["equity"]),
                financial_debt=negate(balances["loans"]), inventory=balances["inventory"],
                trade_receivables=balances["receivables"], trade_payables=negate(balances["payables"]),
                tax_social_payables=tax_social, cash=balances["cash"], total_assets=total,
            )
            if sheet.equity + sheet.financial_debt + sheet.trade_payables + sheet.tax_social_payables != total:
                raise ValueError(f"Bilan déséquilibré au {day}.")
        return sheet

    def year_result(self, year: int) -> Decimal:
        """Résultat avant impôt de l'exercice : opposé de la somme des comptes de gestion."""
        with localcontext(FINANCE_CONTEXT):
            return negate(sum((
                amount for posting in self.ledger.postings if posting.day.year == year and posting.phase < 2
                for account, amount in posting.lines if account in INCOME_ACCOUNTS and account != "income_tax"
            ), ZERO))

    def finish(
        self, description: str, *, prior_profit: Decimal, prior_instalments: Decimal, payout: Decimal,
        prior_payout: Decimal | None = None,
    ) -> DemoCompany:
        """Encaissements, TVA, IS, amortissements, clôtures et dividendes ; puis relecture chronologique."""
        for key, amount in sorted(self.receipts.items(), key=lambda item: (item[0][0], item[0][1], item[0][2] or "")):
            day, label, reference = key
            vat = self.receipt_vat.get(key, ZERO)
            self.ledger.post(day, label, {
                "cash": amount, "receivables": negate(amount), "vat_pending": vat, "vat": negate(vat),
            }, reference=reference)
        with localcontext(FINANCE_CONTEXT):
            self.settle_vat()
            prior_tax = corporate_tax(prior_profit)
            prior_dividends = money((prior_profit - prior_tax) * (payout if prior_payout is None else prior_payout))
            self.opening["corporate_tax"] = negate(prior_tax - prior_instalments)
            self.pay(date(2023, 1, 15), negate(self.opening["social"]), "Cotisations sociales de décembre 2022", "social")
            self.pay(date(2023, 5, 15), prior_tax - prior_instalments, "Solde de l'impôt sur les sociétés 2022", "corporate_tax")
            self.pay(date(2023, 6, 30), prior_dividends, "Dividendes de l'exercice 2022", "equity")
            years: list[DemoYear] = []
            previous_tax = prior_tax
            for year in YEARS:
                instalments = ZERO
                if previous_tax > TAX_INSTALMENT_THRESHOLD:
                    for month, amount in zip((3, 6, 9, 12), split_amount(previous_tax, [ONE] * 4)):
                        self.pay(date(year, month, 15), amount, f"Acompte d'impôt sur les sociétés {year}", "corporate_tax")
                        instalments += amount
                closing_day = date(year, 12, 31)
                depreciation = sum((
                    asset.depreciation_to(closing_day) - asset.depreciation_to(date(year - 1, 12, 31)) for asset in self.assets
                ), ZERO)
                self.ledger.post(closing_day, f"Dotation aux amortissements {year}", {
                    "depreciation": depreciation, "fixed_assets": negate(depreciation),
                }, phase=1)
                pretax = self.year_result(year)
                tax = corporate_tax(pretax)
                self.ledger.post(closing_day, f"Impôt sur les sociétés {year}", {
                    "income_tax": tax, "corporate_tax": negate(tax),
                }, phase=1)
                totals: defaultdict[str, Decimal] = defaultdict(lambda: ZERO)
                for posting in self.ledger.postings:
                    if posting.day.year == year:
                        for account, amount in posting.lines:
                            if account in INCOME_ACCOUNTS:
                                totals[account] += amount
                closing = {account: negate(amount) for account, amount in totals.items()}
                closing["equity"] = sum(totals.values(), ZERO)
                self.ledger.post(closing_day, f"Affectation du résultat {year} aux capitaux propres", closing, phase=2)
                net = pretax - tax
                dividends = money(net * payout) if net > ZERO else ZERO
                if date(year + 1, 5, 15) <= DEMO_END:
                    balance = tax - instalments
                    if balance >= ZERO:
                        self.pay(date(year + 1, 5, 15), balance, f"Solde de l'impôt sur les sociétés {year}", "corporate_tax")
                    else:
                        self.ledger.post(date(year + 1, 5, 15), f"Remboursement d'excédent d'IS {year}", {
                            "cash": negate(balance), "corporate_tax": balance,
                        })
                    self.pay(date(year + 1, 6, 30), dividends, f"Dividendes de l'exercice {year}", "equity")
                paid = prior_dividends if year == DEMO_START.year else years[-1].dividends_declared
                years.append(DemoYear(
                    year=year, revenue_ht=negate(totals["revenue"]),
                    ebe=negate(sum((totals[account] for account in OPERATING_ACCOUNTS), ZERO)),
                    depreciation=depreciation, pretax_income=pretax,
                    income_tax=tax, net_income=net, dividends_paid=paid, dividends_declared=dividends,
                ))
                previous_tax = tax
            self.opening["fixed_assets"] = sum((
                asset.cost - asset.depreciation_to(OPENING_DATE) for asset in self.assets if asset.acquired <= OPENING_DATE
            ), ZERO)
            self.opening["equity"] = ZERO
            self.opening["equity"] = negate(sum((self.opening[account] for account in BALANCE_ACCOUNTS), ZERO))
        return self.replay(description, tuple(years))

    def settle_vat(self) -> None:
        """TVA nette du mois payée le 20 du mois suivant ; un crédit est imputé sur les mois suivants."""
        owed: defaultdict[date, Decimal] = defaultdict(lambda: ZERO)
        for posting in self.ledger.postings:
            for account, amount in posting.lines:
                if account == "vat":
                    owed[posting.day.replace(day=1)] -= amount
        self.pay(date(2023, 1, 20), negate(self.opening["vat"]), "TVA de décembre 2022", "vat")
        credit = ZERO
        for month in month_starts(DEMO_START, DEMO_END):
            due = add_months(month, 1).replace(day=20)
            balance = owed[month] - credit
            credit = negate(balance) if balance < ZERO else ZERO
            if balance > ZERO and due <= DEMO_END:
                self.pay(due, balance, f"TVA de {month_label(month)}", "vat")

    def replay(self, description: str, years: tuple[DemoYear, ...]) -> DemoCompany:
        """Rejoue le grand livre dans l'ordre : mouvements bancaires, soldes mensuels et bilans annuels."""
        company_id = self.company.id
        balances: defaultdict[str, Decimal] = defaultdict(lambda: ZERO, self.opening)
        stock_by_day: defaultdict[date, Decimal] = defaultdict(lambda: ZERO)
        for row in self.inventories:
            stock_by_day[row.date] += row.value
        cash_days = list(month_starts(DEMO_START, DEMO_END))
        sheet_days = [date(year, 12, 31) for year in YEARS]
        sheets = [self.balance_sheet(OPENING_DATE, balances)]
        cash_balances: list[CashBalanceIn] = []
        movements: list[CashMovementIn] = []
        minimum = (balances["cash"], OPENING_DATE)
        current: date | None = None

        def close_day() -> None:
            nonlocal minimum
            if current is not None and balances["cash"] < minimum[0]:
                minimum = (balances["cash"], current)

        def flush(until: date) -> None:
            while cash_days and cash_days[0] <= until:
                day = cash_days.pop(0)
                if stock_by_day and balances["inventory"] != stock_by_day[day]:
                    raise ValueError(f"Inventaire incohérent avec le grand livre au {day}.")
                cash_balances.append(CashBalanceIn(company_id=company_id, date=day, amount=balances["cash"]))
            while sheet_days and sheet_days[0] < until:
                sheets.append(self.balance_sheet(sheet_days.pop(0), balances))

        ordered = sorted(enumerate(self.ledger.postings), key=lambda item: (item[1].day, item[1].phase, item[0]))
        with localcontext(FINANCE_CONTEXT):
            for _, posting in ordered:
                if posting.day != current:
                    close_day()
                    flush(posting.day)
                    current = posting.day
                for account, amount in posting.lines:
                    balances[account] += amount
                    if account == "cash":
                        movements.append(CashMovementIn(
                            company_id=company_id, date=posting.day, amount=amount, label=posting.label,
                            business_reference=posting.reference,
                        ))
            close_day()
            flush(DEMO_END + timedelta(days=1))
        if stock_by_day and balances["inventory"] != stock_by_day[DEMO_END + timedelta(days=1)]:
            raise ValueError("Inventaire de clôture incohérent avec le grand livre.")
        dataset = FinanceDataset(
            company=self.company, revenues=tuple(self.revenues), expenses=tuple(self.expenses),
            overheads=tuple(self.overheads), inventories=tuple(self.inventories), cash_balances=tuple(cash_balances),
            cash_movements=tuple(movements), balance_sheets=tuple(sheets),
        )
        return DemoCompany(dataset, description, years, minimum[0], minimum[1])

    def monthly_invoices(self, month: date, items: Sequence[tuple[str, Decimal, Decimal, int, int]]) -> None:
        """Frais généraux du mois : (fournisseur, HT, taux de TVA, jour de facture, délai de règlement en jours)."""
        for supplier, amount, rate, day, delay in items:
            invoice = month.replace(day=min(day, month_end(month).day))
            if money(amount) > ZERO:
                self.purchase(invoice, supplier, money(amount), CategorieExpense.FRAIS_GENERAUX,
                              pay_on=invoice + timedelta(days=delay), vat_rate=rate)

    def restock(
        self, month: date, allocation: AllocationEnum, opening: Decimal, consumption: Decimal, target: Decimal,
        deliveries: Sequence[tuple[date, str, Decimal, Decimal]], *, payment_days: int,
    ) -> Decimal:
        """Achats du mois = consommation + stock cible − stock initial (au moins 30 % de la consommation).

        deliveries : (date, fournisseur, taux de TVA, poids). Retourne le stock de clôture réellement atteint.
        """
        with localcontext(FINANCE_CONTEXT):
            purchases = consumption + target - opening
            floor = money(consumption * Decimal("0.3"))
            if purchases < floor:
                purchases = floor
            closing = opening + purchases - consumption
        if closing < ZERO or not deliveries:
            raise ValueError(f"Réassort impossible en {month_label(month)}.")
        for (day, supplier, rate, _), amount in zip(deliveries, split_amount(purchases, [w for *_, w in deliveries])):
            self.purchase(day, supplier, amount, CategorieExpense.MATIERE_PREMIERE, pay_on=day + timedelta(days=payment_days),
                          vat_rate=rate, allocation=allocation)
        self.stock_change(month_end(month), allocation, closing - opening)
        self.stock_level(add_months(month, 1), allocation, closing)
        return closing


def amounts(*values: str) -> tuple[Decimal, ...]:
    return tuple(Decimal(value) for value in values)


ENERGY_SEASON = amounts("1.30", "1.22", "1.06", "0.94", "0.84", "0.80", "0.86", "0.82", "0.86", "0.98", "1.12", "1.20")
VAT_20, VAT_10, VAT_55 = Decimal("20"), Decimal("10"), Decimal("5.5")
HOSPITALITY_WEEKDAYS = dict(zip(range(1, 7), amounts("0.80", "0.86", "0.96", "1.26", "1.42", "1.02")))
HOSPITALITY_MONTHS = amounts("0.86", "0.92", "0.98", "1.02", "1.06", "1.08", "1.05", "0.90", "1.03", "1.00", "0.96", "1.12")
HOSPITALITY_LINES = (
    (AllocationEnum.FOOD, VAT_10, Decimal("0.66")),
    (AllocationEnum.BEVERAGE, VAT_20, Decimal("0.25")),
    (AllocationEnum.BEVERAGE, VAT_10, Decimal("0.09")),
)


def brasserie_open(day: date) -> bool:
    """Fermée le lundi, du 2 au 15 janvier, le 25 décembre et le 1er janvier."""
    return day.weekday() != 0 and not (day.month == 1 and day.day <= 15) and (day.month, day.day) != (12, 25)


def build_hospitality() -> DemoCompany:
    profile = DEMO_PROFILES[SectorEnum.HOSPITALITY]
    stock = {AllocationEnum.FOOD: Decimal("4100.00"), AllocationEnum.BEVERAGE: Decimal("9800.00")}
    builder = DemoBuilder(profile.company, {
        "cash": Decimal("92000.00"), "receivables": Decimal("4850.00"), "payables": Decimal("-24000.00"),
        "vat": Decimal("-10800.00"), "social": Decimal("-10900.00"), "inventory": sum(stock.values(), ZERO),
    }, (
        FixedAsset("Fonds de commerce", date(2021, 7, 1), Decimal("420000"), None),
        FixedAsset("Agencements de la salle et de la terrasse", date(2021, 7, 1), Decimal("60000"), 10),
        FixedAsset("Matériel de cuisine", date(2021, 7, 1), Decimal("85000"), 7),
    ))
    builder.collect(date(2023, 1, 2), Decimal("4850.00"), "Remises carte bancaire des 30 et 31 décembre 2022")
    builder.pay(date(2023, 1, 10), Decimal("14000.00"), "Règlement fournisseurs — factures de décembre 2022")
    builder.pay(date(2023, 1, 25), Decimal("10000.00"), "Règlement fournisseurs — factures de décembre 2022")
    for allocation, value in stock.items():
        builder.stock_level(DEMO_START, allocation, value)
    builder.loan("Prêt fonds de commerce", Decimal("380000"), Decimal("1.65"), 84, date(2021, 8, 5), disbursed=date(2021, 7, 20))
    builder.loan("Prêt matériel de cuisine", Decimal("65000"), Decimal("4.6"), 60, date(2024, 4, 5), disbursed=date(2024, 3, 8))
    builder.purchase(date(2024, 3, 8), "Équipements Cuisine Rival (fictif)", Decimal("65000.00"), CategorieExpense.EQUIPEMENT,
                     pay_on=date(2024, 3, 8), vat_rate=VAT_20, asset_label="Four mixte et cellule de refroidissement", asset_years=7)
    sales: defaultdict[tuple[date, AllocationEnum], Decimal] = defaultdict(lambda: ZERO)
    card_ttc: defaultdict[date, Decimal] = defaultdict(lambda: ZERO)
    for year, target in zip(YEARS, amounts("880000", "915000", "948000")):
        days = [day for day in days_between(date(year, 1, 1), date(year, 12, 31)) if brasserie_open(day)]
        weights = [HOSPITALITY_WEEKDAYS[d.weekday()] * HOSPITALITY_MONTHS[d.month - 1] * jitter(150, "brasserie", d) for d in days]
        for day, total in zip(days, split_amount(target, weights)):
            reference = f"Z de caisse du {day:%d/%m/%Y}"
            lines = split_amount(total, [share * jitter(60, "mix", day, rate) for _, rate, share in HOSPITALITY_LINES])
            for (allocation, rate, _), amount in zip(HOSPITALITY_LINES, lines):
                card, cash = split_amount(amount, [Decimal("0.87") * jitter(30, "card", day), Decimal("0.13")])
                sales[(day.replace(day=1), allocation)] += amount
                card_ttc[day.replace(day=1)] += card + money(card * rate / HUNDRED)
                builder.sale(day, card, rate, PaymentMethod.CARD, settle_on=day + timedelta(days=1),
                             receipt="Remise carte bancaire", allocation=allocation, reference=reference)
                builder.sale(day, cash, rate, PaymentMethod.CASH, settle_on=day + timedelta(days=1),
                             receipt="Dépôt d'espèces", allocation=allocation, reference=reference)
    for year, rent, insurance, payroll in zip(YEARS, amounts("6900", "7120", "7290"), amounts("540", "565", "590"),
                                              amounts("21600", "22350", "23050")):
        start, end = date(year, 1, 1), date(year, 12, 31)
        builder.overhead("Loyer commercial", OverheadCategory.RENT, rent, start, end, vat_rate=VAT_20, pay_day=5)
        builder.overhead("Assurance multirisque professionnelle", OverheadCategory.INSURANCE, insurance, start, end, pay_day=10)
        builder.overhead("Salaires de l'équipe salle et cuisine", OverheadCategory.PAYROLL, payroll, start, end,
                         employer=money(payroll * Decimal("0.29")))
    deliveries = {
        AllocationEnum.FOOD: ((1, "Marée et Primeurs Delmas (fictif)", VAT_55, Decimal("0.5")),
                              (4, "Boucherie Ferrand en gros (fictive)", VAT_55, Decimal("0.5"))),
        AllocationEnum.BEVERAGE: ((2, "Cave et Spiritueux Vidal (fictif)", VAT_20, Decimal("0.8")),
                                  (2, "Boissons du Val (fictif)", VAT_55, Decimal("0.2"))),
    }
    costs = {AllocationEnum.FOOD: (Decimal("0.300"), Decimal("0.28")), AllocationEnum.BEVERAGE: (Decimal("0.235"), Decimal("1.6"))}
    for month in month_starts(DEMO_START, DEMO_END):
        open_days = [day for day in days_between(month, month_end(month)) if brasserie_open(day)]
        revenue = sum((sales[(month, allocation)] for allocation in stock), ZERO)
        for allocation, (cost_rate, cover) in costs.items():
            consumption = money(sales[(month, allocation)] * cost_rate * jitter(40, "cost", allocation, month))
            target = money(consumption * cover * jitter(120, "stock", allocation, month))
            planned = [
                (day, supplier, rate, share * jitter(250, "delivery", day, supplier))
                for day in open_days for weekday, supplier, rate, share in deliveries[allocation] if day.weekday() == weekday
            ]
            stock[allocation] = builder.restock(month, allocation, stock[allocation], consumption, target, planned, payment_days=30)
        builder.purchase(month.replace(day=8), "Hygiène Pro Services (fictif)", money(revenue * Decimal("0.007") * jitter(150, "supplies", month)),
                         CategorieExpense.FOURNITURES, pay_on=month.replace(day=8) + timedelta(days=30), vat_rate=VAT_20)
        builder.monthly_invoices(month, (
            ("Énergie Ouest — électricité et gaz (fictif)", Decimal("2150") * ENERGY_SEASON[month.month - 1] * jitter(60, "energy", month), VAT_20, 12, 10),
            ("Cabinet comptable Arnaud (fictif)", Decimal("820"), VAT_20, 25, 15),
            ("Blanchisserie du Port (fictive)", Decimal("1450") * jitter(80, "linen", month), VAT_20, 28, 30),
            ("Froid et Cuisson Services — maintenance (fictif)", Decimal("380"), VAT_20, 15, 30),
            ("Logiciel de caisse Orion (fictif)", Decimal("189"), VAT_20, 1, 0),
            ("Agence Com'Locale — réseaux sociaux (fictive)", Decimal("300"), VAT_20, 20, 30),
            ("Eau et assainissement (fictif)", Decimal("260") * jitter(100, "water", month), VAT_55, 18, 20),
            ("Commissions monétiques — banque (fictive)", card_ttc[month] * Decimal("0.0045"), ZERO, 31, 5),
        ))
    return builder.finish(
        profile.description, prior_profit=Decimal("102000"), prior_instalments=Decimal("17200"), payout=Decimal("0.30"),
    )


def pick(count: int, *parts: object) -> int:
    """Indice reproductible dans [0 ; count − 1]."""
    return min(count - 1, int(unit(*parts) * count))


def hundreds(value: Decimal) -> Decimal:
    with localcontext(FINANCE_CONTEXT):
        return money((value / HUNDRED).quantize(ONE) * HUNDRED)


CONSTRUCTION_WORKS = (
    ("Rénovation complète de salle de bains", "Cuisine ouverte et reprise des sols", "Aménagement de combles",
     "Isolation et remplacement des menuiseries", "Rénovation d'un appartement ancien", "Extension en ossature bois"),
    ("Réaménagement de bureaux", "Rénovation de boutique", "Mise aux normes d'un restaurant",
     "Réfection d'un cabinet médical", "Aménagement d'un plateau tertiaire", "Rénovation d'un hall d'immeuble"),
)
CONSTRUCTION_VOLUME = {  # Volume HT des chantiers ouverts dans l'année (de septembre à décembre pour 2022).
    2022: Decimal("480000"), 2023: Decimal("1440000"), 2024: Decimal("1530000"), 2025: Decimal("1600000"),
}
SUBCONTRACTORS = ("Plomberie Chauffage Leroux (fictif)", "Électricité Garnier (fictive)", "Plâtrerie Morel (fictive)")
LOSS_MAKING_PROJECT = "CH-2024-06 Réhabilitation d'un local commercial"
LOSS_MAKING_SLOT = (date(2024, 3, 1), 2)
LOSS_MAKING_AMOUNT = Decimal("96000.00")


@dataclass(frozen=True)
class Project:
    reference: str
    start: date
    amount_ht: Decimal
    months: int
    vat_rate: Decimal
    payment_days: int
    material: Decimal
    subcontracting: Decimal


def construction_projects() -> list[Project]:
    """Deux chantiers ouverts par mois depuis septembre 2022 : un particulier puis un professionnel.

    Les tailles relatives sont tirées au sort puis mises à l'échelle du volume annuel de chantiers ouverts."""
    slots = [(month, rank) for month in month_starts(date(2022, 9, 1), DEMO_END) for rank in (1, 2)]
    bases = {
        slot: Decimal("26000") + Decimal("22000") * unit("size", *slot) if slot[1] == 1
        else Decimal("62000") + Decimal("56000") * unit("size", *slot)
        for slot in slots
    }
    scales: dict[int, Decimal] = {}
    with localcontext(FINANCE_CONTEXT):
        for year, volume in CONSTRUCTION_VOLUME.items():
            fixed = LOSS_MAKING_AMOUNT if LOSS_MAKING_SLOT[0].year == year else ZERO
            scales[year] = (volume - fixed) / sum((
                bases[slot] for slot in slots if slot[0].year == year and slot != LOSS_MAKING_SLOT
            ), ZERO)
    projects: list[Project] = []
    for month, rank in slots:
        if (month, rank) == LOSS_MAKING_SLOT:
            projects.append(Project(LOSS_MAKING_PROJECT, month, LOSS_MAKING_AMOUNT, 3, VAT_20, 45,
                                    Decimal("0.30"), Decimal("0.40")))
            continue
        private = rank == 1
        work = CONSTRUCTION_WORKS[rank - 1][pick(6, "work", month, rank)]
        projects.append(Project(
            reference=f"CH-{month.year}-{2 * (month.month - 1) + rank:02d} {work}", start=month,
            amount_ht=hundreds(bases[(month, rank)] * scales[month.year]),
            months=1 + pick(3, "length", month, rank) if private else 2 + pick(4, "length", month, rank),
            vat_rate=VAT_10 if private else VAT_20,
            payment_days=30 if private else 45 + (20 if pick(10, "late", month, rank) >= 7 else 0),
            material=Decimal("0.26") * jitter(150, "material-rate", month, rank),
            subcontracting=Decimal("0.15") * jitter(300, "subcontracting-rate", month, rank),
        ))
    return projects


def build_construction() -> DemoCompany:
    profile = DEMO_PROFILES[SectorEnum.CONSTRUCTION]
    builder = DemoBuilder(profile.company, {
        "cash": Decimal("135000.00"), "receivables": Decimal("275000.00"), "payables": Decimal("-64000.00"),
        "vat": Decimal("-12600.00"), "vat_pending": Decimal("-42803.02"), "social": Decimal("-22100.00"),
    }, (
        FixedAsset("Véhicules et camion benne", date(2020, 3, 1), Decimal("210000"), 5),
        FixedAsset("Aménagement du dépôt", date(2019, 6, 1), Decimal("45000"), 10),
    ))
    builder.collect(date(2023, 1, 13), Decimal("95000.00"), "Encaissements clients — situations de novembre 2022", Decimal("15833.33"))
    builder.collect(date(2023, 1, 31), Decimal("72000.00"), "Encaissements clients — situations d'octobre et décembre 2022",
                    Decimal("8969.69"))
    builder.collect(date(2023, 2, 14), Decimal("108000.00"), "Encaissements clients — situations de décembre 2022", Decimal("18000.00"))
    builder.pay(date(2023, 1, 13), Decimal("26000.00"), "Règlement fournisseurs et sous-traitants — factures de décembre 2022")
    builder.pay(date(2023, 1, 24), Decimal("38000.00"), "Règlement négoce de matériaux — factures de décembre 2022")
    builder.loan("Prêt BPI de développement", Decimal("90000"), Decimal("1.9"), 60, date(2020, 11, 5), disbursed=date(2020, 10, 15))
    builder.loan("Prêt véhicules utilitaires", Decimal("160000"), Decimal("4.35"), 60, date(2023, 5, 12), disbursed=date(2023, 4, 12))
    builder.purchase(date(2023, 4, 12), "Garage Moreau — véhicules utilitaires (fictif)", Decimal("160000.00"), CategorieExpense.EQUIPEMENT,
                     pay_on=date(2023, 4, 12), vat_rate=VAT_20, asset_label="Trois fourgons et un camion benne", asset_years=5)
    revenue: defaultdict[date, Decimal] = defaultdict(lambda: ZERO)
    for project in construction_projects():
        months = [add_months(project.start, index) for index in range(project.months)]
        shares = split_amount(project.amount_ht, [jitter(300, "progress", project.reference, month) for month in months])
        for month, situation in zip(months, shares):
            if not DEMO_START <= month <= DEMO_END:
                continue
            day, work_days = last_working_day(month), working_days(month)
            revenue[month] += situation
            builder.sale(day, situation, project.vat_rate, PaymentMethod.TRANSFER, settle_on=day + timedelta(days=project.payment_days),
                         receipt="Virement client", reference=project.reference, vat_on_receipt=True)
            builder.purchase(work_days[len(work_days) // 3], "Négoce Matériaux Berthier (fictif)",
                             money(situation * project.material * jitter(80, "material", project.reference, month)),
                             CategorieExpense.MATIERE_PREMIERE, pay_on=work_days[len(work_days) // 3] + timedelta(days=45),
                             vat_rate=VAT_20, reference=project.reference)
            subcontracting = money(situation * project.subcontracting * jitter(150, "subcontracting", project.reference, month))
            if subcontracting > ZERO:
                supplier = SUBCONTRACTORS[pick(3, "subcontractor", project.reference, month)]
                builder.purchase(work_days[len(work_days) // 2], f"{supplier} — autoliquidation", subcontracting,
                                 CategorieExpense.SOUS_TRAITANCE, pay_on=work_days[len(work_days) // 2] + timedelta(days=30),
                                 reference=project.reference)
            if project.reference == LOSS_MAKING_PROJECT and month == date(2024, 4, 1):
                builder.purchase(work_days[5], "Amiante Sécurité Est — désamiantage imprévu (fictif)", Decimal("29568.00"),
                                 CategorieExpense.SOUS_TRAITANCE, pay_on=work_days[5] + timedelta(days=30), reference=project.reference)
    for year, rent, insurance, payroll in zip(YEARS, amounts("2450", "2530", "2600"), amounts("2250", "2420", "2560"),
                                              amounts("34000", "35000", "36500")):
        start, end = date(year, 1, 1), date(year, 12, 31)
        builder.overhead("Loyer du dépôt et des bureaux", OverheadCategory.RENT, rent, start, end, vat_rate=VAT_20, pay_day=5)
        builder.overhead("Assurance décennale et responsabilité civile", OverheadCategory.INSURANCE, insurance, start, end, pay_day=10)
        builder.overhead("Salaires des compagnons et de l'encadrement", OverheadCategory.PAYROLL, payroll, start, end,
                         employer=money(payroll * Decimal("0.45")))
    for month in month_starts(DEMO_START, DEMO_END):
        builder.purchase(month.replace(day=6), "Outillage et Consommables Pro (fictif)",
                         money(revenue[month] * Decimal("0.016") * jitter(200, "supplies", month)), CategorieExpense.FOURNITURES,
                         pay_on=month.replace(day=6) + timedelta(days=30), vat_rate=VAT_20)
        builder.monthly_invoices(month, (
            ("Carburant — cartes flotte (fictif)", Decimal("1900") * jitter(100, "fuel", month), VAT_20, 28, 10),
            ("Cabinet comptable Fournier (fictif)", Decimal("1100"), VAT_20, 25, 15),
            ("Télécom et logiciel de devis (fictif)", Decimal("420"), VAT_20, 3, 0),
            ("Garage Moreau — entretien des véhicules (fictif)", Decimal("650") * jitter(300, "garage", month), VAT_20, 16, 30),
            ("Location de matériel et bennes (fictif)", Decimal("900") * jitter(250, "rental", month), VAT_20, 22, 30),
        ))
    return builder.finish(
        profile.description, prior_profit=Decimal("96000"), prior_instalments=Decimal("16000"), payout=Decimal("0.25"),
    )


RETAIL_MONTHS = amounts("0.80", "0.66", "0.80", "0.86", "0.92", "0.88", "0.86", "0.72", "0.86", "0.96", "1.25", "2.20")
RETAIL_WEEKDAYS = dict(zip(range(1, 7), amounts("0.82", "0.96", "0.90", "1.08", "1.62", "1.15")))
RETAIL_STOCK = amounts(
    "118000", "104000", "108000", "116000", "120000", "122000", "110000", "106000", "124000", "142000", "166000", "158000",
)
RETAIL_GROWTH = {2023: Decimal("1.00"), 2024: Decimal("1.03"), 2025: Decimal("1.05"), 2026: Decimal("1.07")}
RETAIL_SUPPLIERS = ("Ateliers Verre et Lumière (fictifs)", "Tissages Ancelle (fictifs)", "Céramiques du Midi (fictives)")


def shop_open(day: date) -> bool:
    """Du mardi au samedi, plus les dimanches de décembre jusqu'au 24 ; fermé les jours fériés."""
    if day in public_holidays(day.year) or day.weekday() == 0:
        return False
    return day.weekday() != 6 or (day.month == 12 and day.day <= 24)


def sales_period(day: date) -> bool:
    """Soldes de quatre semaines : dès le 2e mercredi de janvier et dès le dernier mercredi de juin."""
    return any(
        start <= day < start + timedelta(days=28)
        for start in (weekday_in_month(day.year, 1, 2, 2), weekday_in_month(day.year, 6, 2, -1))
    )


def retail_stock(month: date) -> Decimal:
    return money(RETAIL_STOCK[month.month - 1] * RETAIL_GROWTH[month.year] * jitter(25, "shop-stock", month))


def build_retail() -> DemoCompany:
    profile = DEMO_PROFILES[SectorEnum.RETAIL]
    merchandise = AllocationEnum.MERCHANDISE
    stock = retail_stock(DEMO_START)
    builder = DemoBuilder(profile.company, {
        "cash": Decimal("72000.00"), "receivables": Decimal("2900.00"), "payables": Decimal("-61000.00"),
        "vat": Decimal("-16200.00"), "social": Decimal("-7200.00"), "inventory": stock,
    }, (
        FixedAsset("Droit au bail", date(2021, 3, 15), Decimal("90000"), None),
        FixedAsset("Agencements de la boutique", date(2021, 3, 15), Decimal("155000"), 10),
        FixedAsset("Mobilier et présentoirs", date(2021, 3, 15), Decimal("28000"), 5),
    ))
    builder.collect(date(2023, 1, 3), Decimal("2900.00"), "Remises carte bancaire des 30 et 31 décembre 2022")
    builder.pay(date(2023, 1, 3), Decimal("35000.00"), "Règlement fournisseurs — commandes de Noël 2022")
    builder.pay(date(2023, 2, 16), Decimal("26000.00"), "Règlement fournisseurs — commandes de Noël 2022")
    builder.stock_level(DEMO_START, merchandise, stock)
    builder.loan("Prêt d'aménagement de la boutique", Decimal("140000"), Decimal("1.35"), 84, date(2021, 4, 5), disbursed=date(2021, 3, 15))
    builder.credit_line("Crédit de campagne de fin d'année", Decimal("50000.00"), Decimal("5.2"), date(2024, 10, 1), date(2025, 1, 31))
    builder.purchase(date(2025, 4, 10), "Agencements Duval — vitrines (fictif)", Decimal("18000.00"), CategorieExpense.EQUIPEMENT,
                     pay_on=date(2025, 5, 10), vat_rate=VAT_20, asset_label="Vitrines éclairées", asset_years=5)
    consumption: defaultdict[date, Decimal] = defaultdict(lambda: ZERO)
    revenue: defaultdict[date, Decimal] = defaultdict(lambda: ZERO)
    card_ttc: defaultdict[date, Decimal] = defaultdict(lambda: ZERO)
    with localcontext(FINANCE_CONTEXT):
        for year, target in zip(YEARS, amounts("690000", "712000", "705000")):
            days = [day for day in days_between(date(year, 1, 1), date(year, 12, 31)) if shop_open(day)]
            weights = [
                RETAIL_MONTHS[d.month - 1] * RETAIL_WEEKDAYS[d.weekday()] * (Decimal("1.25") if sales_period(d) else ONE)
                * jitter(150, "shop", d) for d in days
            ]
            for day, total in zip(days, split_amount(target, weights)):
                discount = sales_period(day)
                basket = Decimal("34.00") if discount else Decimal("47.50") if day.month == 12 else Decimal("41.50")
                tickets = max(1, int((total / (basket * jitter(60, "basket", day))).quantize(ONE)))
                card, cash = split_amount(total, [Decimal("0.88") * jitter(30, "shop-card", day), Decimal("0.12")])
                card_tickets = int((Decimal(tickets) * card / total).quantize(ONE))
                margin = (Decimal("0.38") if discount else Decimal("0.555")) * jitter(20, "margin", day)
                month = day.replace(day=1)
                consumption[month] += total * (ONE - margin)
                revenue[month] += total
                card_ttc[month] += card + money(card * VAT_20 / HUNDRED)
                reference = f"Z de caisse du {day:%d/%m/%Y}"
                builder.sale(day, card, VAT_20, PaymentMethod.CARD, settle_on=day + timedelta(days=1), receipt="Remise carte bancaire",
                             allocation=merchandise, reference=reference, tickets=card_tickets)
                builder.sale(day, cash, VAT_20, PaymentMethod.CASH, settle_on=day + timedelta(days=1), receipt="Dépôt d'espèces",
                             allocation=merchandise, reference=reference, tickets=tickets - card_tickets)
    for year, rent, insurance, payroll, seasonal in zip(
        YEARS, amounts("5150", "5320", "5450"), amounts("290", "305", "320"), amounts("11200", "11550", "11850"),
        amounts("2400", "2480", "2550"),
    ):
        start, end = date(year, 1, 1), date(year, 12, 31)
        builder.overhead("Loyer de la boutique", OverheadCategory.RENT, rent, start, end, vat_rate=VAT_20, pay_day=5)
        builder.overhead("Assurance multirisque commerce", OverheadCategory.INSURANCE, insurance, start, end, pay_day=10)
        builder.overhead("Salaires de l'équipe de vente", OverheadCategory.PAYROLL, payroll, start, end,
                         employer=money(payroll * Decimal("0.31")))
        builder.overhead("Renfort de fin d'année (CDD)", OverheadCategory.PAYROLL, seasonal, date(year, 11, 1), end,
                         employer=money(seasonal * Decimal("0.31")))
    for month in month_starts(DEMO_START, DEMO_END):
        order_days = [3, 10, 17] if month.month in (9, 10, 11) else [3, 17]
        planned = [
            (month.replace(day=d), RETAIL_SUPPLIERS[pick(3, "supplier", month, d)], VAT_20, jitter(300, "order", month, d))
            for d in order_days
        ]
        stock = builder.restock(month, merchandise, stock, money(consumption[month]), retail_stock(add_months(month, 1)),
                                planned, payment_days=60)
        builder.purchase(month.replace(day=6), "Emballages Cartonnia (fictif)",
                         money(revenue[month] * Decimal("0.009") * jitter(150, "packaging", month)), CategorieExpense.FOURNITURES,
                         pay_on=month.replace(day=6) + timedelta(days=30), vat_rate=VAT_20)
        builder.monthly_invoices(month, (
            ("Électricité Lumen Énergie (fictive)", Decimal("420") * ENERGY_SEASON[month.month - 1] * jitter(60, "shop-energy", month), VAT_20, 12, 10),
            ("Cabinet comptable Lefèvre (fictif)", Decimal("650"), VAT_20, 25, 15),
            ("Logiciel de caisse et site marchand (fictif)", Decimal("290"), VAT_20, 1, 0),
            ("Publicité locale et réseaux sociaux (fictif)",
             Decimal("600") * (Decimal("1.6") if month.month in (11, 12) else ONE) * jitter(200, "ads", month), VAT_20, 20, 30),
            ("Entretien et nettoyage du magasin (fictif)", Decimal("440"), VAT_20, 28, 30),
            ("Commissions monétiques — banque (fictive)", card_ttc[month] * Decimal("0.0040"), ZERO, 31, 5),
        ))
    return builder.finish(
        profile.description, prior_profit=Decimal("52000"), prior_instalments=Decimal("6800"),
        payout=Decimal("0.50"), prior_payout=ZERO,
    )


SERVICES_OCCUPATION = amounts("0.84", "0.86", "0.86", "0.85", "0.80", "0.85", "0.74", "0.42", "0.86", "0.86", "0.84", "0.72")
SERVICE_CLIENTS = (
    ("A", "Groupe Transports Alpins (fictif)", Decimal("790"), 58),
    ("B", "Mutuelle Santé Horizon (fictive)", Decimal("830"), 45),
    ("C", "Communauté de communes du Val-de-Sorne (fictive)", Decimal("660"), 52),
    ("D", "Industries Mécaniques du Vercors (fictives)", Decimal("710"), 60),
    ("E", "Laboratoires Cerise (fictifs)", Decimal("730"), 75),
)
TJM_INDEXATION = Decimal("1.03")
HOURS_PER_DAY = Decimal("7")


def staffed_consultants(code: str, month: date) -> int:
    if code in ("A", "B"):
        return 2
    return 2 if code == "E" and month >= date(2024, 9, 1) else 1


def build_services() -> DemoCompany:
    profile = DEMO_PROFILES[SectorEnum.SERVICES]
    builder = DemoBuilder(profile.company, {
        "cash": Decimal("165000.00"), "receivables": Decimal("190000.00"), "payables": Decimal("-9500.00"),
        "vat": Decimal("-13500.00"), "vat_pending": Decimal("-31666.67"), "social": Decimal("-29800.00"),
    }, (
        FixedAsset("Matériel informatique", date(2021, 9, 1), Decimal("36000"), 3),
        FixedAsset("Mobilier de bureau", date(2020, 1, 1), Decimal("18000"), 10),
    ))
    builder.collect(date(2023, 1, 20), Decimal("104500.00"), "Encaissements clients — factures de fin 2022", Decimal("17416.67"))
    builder.collect(date(2023, 2, 20), Decimal("85500.00"), "Encaissements clients — factures de fin 2022", Decimal("14250.00"))
    builder.pay(date(2023, 1, 15), Decimal("9500.00"), "Règlement fournisseurs — factures de décembre 2022")
    builder.loan("Prêt informatique", Decimal("30000"), Decimal("3.9"), 36, date(2023, 3, 6), disbursed=date(2023, 2, 6))
    builder.purchase(date(2023, 2, 6), "Informatique Delta Systèmes (fictif)", Decimal("30000.00"), CategorieExpense.EQUIPEMENT,
                     pay_on=date(2023, 2, 6), vat_rate=VAT_20, asset_label="Ordinateurs portables et serveur", asset_years=3)
    builder.purchase(date(2025, 9, 15), "Informatique Delta Systèmes (fictif)", Decimal("12000.00"), CategorieExpense.EQUIPEMENT,
                     pay_on=date(2025, 10, 15), vat_rate=VAT_20, asset_label="Renouvellement des postes de travail", asset_years=3)
    for month in month_starts(DEMO_START, DEMO_END):
        open_days, invoice_day = len(working_days(month)), last_working_day(month)
        revenue = ZERO
        with localcontext(FINANCE_CONTEXT):
            for code, client, rate, delay in SERVICE_CLIENTS:
                days = half_days(
                    Decimal(staffed_consultants(code, month) * open_days) * SERVICES_OCCUPATION[month.month - 1]
                    * jitter(50, "staffing", code, month)
                )
                if days <= ZERO:
                    continue
                amount = money(days * money(rate * TJM_INDEXATION ** (month.year - DEMO_START.year)))
                revenue += amount
                builder.sale(invoice_day, amount, VAT_20, PaymentMethod.TRANSFER, settle_on=invoice_day + timedelta(days=delay),
                             receipt=f"Virement {client}", reference=f"FAC-{month:%Y%m}-{code}",
                             hours=days * HOURS_PER_DAY, days=days, vat_on_receipt=True)
        builder.monthly_invoices(month, (
            ("Agence de voyages Atlas — déplacements (fictive)", revenue * Decimal("0.019") * jitter(200, "travel", month), VAT_10, 28, 30),
            ("Cabinet comptable et juridique Perrin (fictif)", Decimal("1350"), VAT_20, 25, 15),
            ("Logiciels et licences (fictif)", Decimal("1150"), VAT_20, 2, 0),
            ("Télécom et internet (fictif)", Decimal("380"), VAT_20, 6, 0),
            ("Organisme de formation Savoirs (fictif)", Decimal("900") * jitter(400, "training", month), VAT_20, 15, 30),
            ("Recrutement et frais divers (fictif)", Decimal("920") * jitter(300, "misc", month), VAT_20, 20, 30),
        ))
    for year, rent, insurance, consultants, management in zip(
        YEARS, amounts("3650", "3770", "3860"), amounts("360", "375", "390"), amounts("34300", "35350", "41600"),
        amounts("11500", "11850", "12200"),
    ):
        start, end = date(year, 1, 1), date(year, 12, 31)
        builder.overhead("Loyer des bureaux", OverheadCategory.RENT, rent, start, end, vat_rate=VAT_20, pay_day=5)
        builder.overhead("Responsabilité civile professionnelle", OverheadCategory.INSURANCE, insurance, start, end, pay_day=10)
        builder.overhead("Salaires des consultants", OverheadCategory.PAYROLL, consultants, start, end,
                         employer=money(consultants * Decimal("0.43")))
        builder.overhead("Salaires direction et assistanat", OverheadCategory.PAYROLL, management, start, end,
                         employer=money(management * Decimal("0.43")))
    builder.overhead("Salaire du consultant recruté en septembre 2024", OverheadCategory.PAYROLL, Decimal("4300"),
                     date(2024, 9, 1), date(2024, 12, 31), employer=money(Decimal("4300") * Decimal("0.43")))
    return builder.finish(
        profile.description, prior_profit=Decimal("128000"), prior_instalments=Decimal("24000"), payout=Decimal("0.50"),
    )


@dataclass(frozen=True)
class DemoProfile:
    company: CompanyProfileIn
    description: str


DEMO_NOTICE = (
    "Entreprises entièrement fictives : aucun chiffre client, aucune entreprise réelle. Pièces générées de façon "
    "déterministe à partir d'un grand livre en partie double (bilans équilibrés, trésorerie rapprochée)."
)
DEMO_PROFILES: dict[SectorEnum, DemoProfile] = {
    SectorEnum.HOSPITALITY: DemoProfile(
        CompanyProfileIn(id="demo-hospitality", name="Brasserie Le Grand Comptoir (fictive)", sector=SectorEnum.HOSPITALITY),
        "Brasserie de centre-ville (95 couverts), fermée le lundi et deux semaines en janvier. Fonds de commerce acquis "
        "en 2021 grâce à un prêt bancaire ; matériel de cuisine financé à crédit en mars 2024.",
    ),
    SectorEnum.CONSTRUCTION: DemoProfile(
        CompanyProfileIn(id="demo-construction", name="Durand Rénovation (fictive)", sector=SectorEnum.CONSTRUCTION),
        "Entreprise de rénovation tous corps d'état (une douzaine de salariés), clientèle de particuliers et de "
        "professionnels, deux chantiers ouverts par mois et facturés en situations mensuelles. TVA sur les encaissements ; "
        "un chantier déficitaire en 2024 à cause d'un désamiantage imprévu.",
    ),
    SectorEnum.RETAIL: DemoProfile(
        CompanyProfileIn(id="demo-retail", name="Maison Lumière — décoration (fictive)", sector=SectorEnum.RETAIL),
        "Boutique de décoration et de luminaires en centre-ville, ouverte du mardi au samedi et les dimanches de décembre. "
        "Forte saisonnalité de Noël, soldes d'hiver et d'été ; après une fin d'année 2023 tendue, le stock de Noël 2024 "
        "est financé par un crédit de campagne. Résultat 2022 mis en réserve, puis la moitié des bénéfices distribuée.",
    ),
    SectorEnum.SERVICES: DemoProfile(
        CompanyProfileIn(id="demo-services", name="Altitude Conseil (fictive)", sector=SectorEnum.SERVICES),
        "Cabinet de conseil en organisation de huit consultants, cinq clients grands comptes et publics facturés au temps "
        "passé (taux journalier indexé de 3 % par an). Délais de paiement de 45 à 75 jours ; TVA sur les encaissements.",
    ),
}
DEMO_BUILDERS = {
    SectorEnum.HOSPITALITY: build_hospitality,
    SectorEnum.CONSTRUCTION: build_construction,
    SectorEnum.RETAIL: build_retail,
    SectorEnum.SERVICES: build_services,
}
_DEMO_CACHE: dict[SectorEnum, DemoCompany] = {}
_DEMO_LOCKS = {sector: threading.Lock() for sector in DEMO_BUILDERS}


def demo_catalog() -> DemoCatalog:
    """Catalogue statique : n'exige la construction d'aucune entreprise."""
    return DemoCatalog(
        period=Period(start_date=DEMO_START, end_date=DEMO_END), notice=DEMO_NOTICE,
        companies=[DemoCompanySummary(company=p.company, description=p.description) for p in DEMO_PROFILES.values()],
    )


def demo_company(sector: SectorEnum) -> DemoCompany:
    """Entreprise fictive du secteur, construite une seule fois par processus, même sous requêtes concurrentes."""
    company = _DEMO_CACHE.get(sector)
    if company is None:
        with _DEMO_LOCKS[sector]:
            company = _DEMO_CACHE.get(sector)
            if company is None:
                company = _DEMO_CACHE[sector] = DEMO_BUILDERS[sector]()
    return company


def prewarm_demo_companies(stop: threading.Event | None = None) -> None:
    """Construit les démonstrations à l'avance (quelques secondes chacune) ; s'arrête entre deux secteurs si demandé."""
    for sector in DEMO_BUILDERS:
        if stop is not None and stop.is_set():
            return
        demo_company(sector)


@lru_cache(maxsize=64)
def demo_report(sector: SectorEnum, start: date, end: date, comparison: ComparisonMode) -> FinanceDashboard:
    """Tableau de bord (immuable) d'une démonstration ; les mêmes paramètres renvoient le même objet."""
    return build_report(demo_company(sector).dataset, Period(start_date=start, end_date=end), comparison, demo=True)
