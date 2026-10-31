"""Relevés bancaires réels : exports CSV des banques françaises, OFX, doublons, journal et annulation des imports."""
import codecs
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import URL, func, select
from sqlalchemy.orm import Session

from finance_connectors import BankStatementCSVAdapter, BankStatementOFXAdapter, ConnectorValidationError
from finance_database import create_finance_engine, get_db
from models.finance import CashMovement, CompanyProfile, FinanceIngestionBatch, FinanceIngestionItem
from routers.finance import make_company_finance_router
from schemas.finance import SectorEnum

NNBSP, NBSP = "\u202f", "\u00a0"
MEMBERS = {("u1", "a"): "manager", ("u2", "b"): "admin", ("viewer", "a"): "viewer"}
USER = {"x-test-user": "u1"}
CSV = {"Content-Type": "text/csv"} | USER
OFX = {"Content-Type": "application/x-ofx"} | USER


def parse_csv(text, *, encoding="utf-8", currency="EUR"):
    adapter = BankStatementCSVAdapter("a", currency)
    rows = adapter.parse_payload(text.encode(encoding) if isinstance(text, str) else text)
    assert adapter.validate_checksum_and_totals(rows)
    return adapter, rows


def parse_ofx(raw, *, currency="EUR"):
    adapter = BankStatementOFXAdapter("a", currency)
    rows = adapter.parse_payload(raw)
    assert adapter.validate_checksum_and_totals(rows)
    return adapter, rows


def lines(rows):
    return [(row.date.isoformat(), row.label, str(row.amount), row.business_reference) for row in rows]


# --- Exports CSV des banques françaises -----------------------------------------------------------------------------


def test_credit_agricole_export_in_windows_1252_with_preamble_multiline_label_and_trailing_separator():
    text = (
        "Téléchargement du 31/10/2026;\r\n"
        "\r\n"
        "Compte courant professionnel n° 12345678901;\r\n"
        "Solde au 31/10/2026 12 345,67 €;\r\n"
        "\r\n"
        "Liste des opérations du compte entre le 01/10/2026 et le 31/10/2026;\r\n"
        "\r\n"
        "Date;Libellé;Débit Euros;Crédit Euros;\r\n"
        '02/10/2026;"PRLV SEPA EDF ENTREPRISES\r\nRUM FR12ZZZ123456";1 234,50;;\r\n'
        "03/10/2026;VIR SEPA RECU /FRM SARL DUPONT;;2 000,00;\r\n"
        "04/10/2026;CARTE X1234 03/10 TOTALENERGIES;45,20;;\r\n"
    )
    adapter, rows = parse_csv(text, encoding="cp1252")
    assert lines(rows) == [
        ("2026-10-02", "PRLV SEPA EDF ENTREPRISES RUM FR12ZZZ123456", "-1234.50", None),
        ("2026-10-03", "VIR SEPA RECU /FRM SARL DUPONT", "2000.00", None),
        ("2026-10-04", "CARTE X1234 03/10 TOTALENERGIES", "-45.20", None),
    ]
    assert adapter.import_notes == (
        f"Relevé du 02/10/2026 au 04/10/2026 : 3 écritures lues — débits 1{NNBSP}279,70{NBSP}€, "
        f"crédits 2{NNBSP}000,00{NBSP}€.",
    )
    assert adapter.import_warnings == ()


def test_societe_generale_export_with_excel_wrapped_cells_detail_column_and_signed_amount():
    text = (
        '="00012345678";Compte courant;Solde au 31/10/2026;12 345,67 EUR\n'
        "\n"
        "Date de l'opération;Libellé;Détail de l'écriture;Montant de l'opération;Devise\n"
        '31/10/2026;="CARTE X1234";="CARTE X1234 30/10 CARREFOUR CITY";-45,20;EUR\n'
        "30/10/2026;VIR RECU 0123;DE: SARL DUPONT MOTIF: FACTURE 2026-104;+1 500,00;EUR\n"
    )
    _, rows = parse_csv(text)
    assert lines(rows) == [
        ("2026-10-31", "CARTE X1234 30/10 CARREFOUR CITY", "-45.20", None),
        ("2026-10-30", "VIR RECU 0123 – DE: SARL DUPONT MOTIF: FACTURE 2026-104", "1500.00", None),
    ]


def test_caisse_epargne_export_prefers_operation_date_and_label_and_keeps_the_reference():
    text = (
        "Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;"
        "Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation\n"
        "02/10/2026;PRLV EDF;PRLV SEPA EDF ENTREPRISES;0123456789;;Prélèvement;Énergie;Électricité;"
        "-1 234,50;;01/10/2026;02/10/2026;0\n"
        "03/10/2026;VIR SARL DUPONT;VIR SEPA SARL DUPONT FACTURE 104;0123456790;;Virement reçu;;;"
        ";+2 000,00;03/10/2026;03/10/2026;0\n"
    )
    _, rows = parse_csv(text)
    assert lines(rows) == [
        ("2026-10-01", "PRLV SEPA EDF ENTREPRISES", "-1234.50", "0123456789"),
        ("2026-10-03", "VIR SEPA SARL DUPONT FACTURE 104", "2000.00", "0123456790"),
    ]


def test_former_caisse_epargne_export_with_balance_lines_two_digit_years_and_detail():
    text = (
        "Code de la banque : 17515;Code de l'agence : 90000;Date de début de téléchargement : 01/10/2026;"
        "Date de fin de téléchargement : 31/10/2026;;\n"
        "Numéro de compte : 01234567890;Nom du compte : COMPTE COURANT;Devise : EUR;;;\n"
        ";;;;;\n"
        "Solde en fin de période;;;;+12 345,67;\n"
        ";;;;;\n"
        "Date;Numéro d'opération;Libellé;Débit;Crédit;Détail;\n"
        "31/10/26;1234567;PRLV EDF;-45,20;;PRLV SEPA EDF ENTREPRISES;\n"
        "30/10/26;1234568;VIR DUPONT;;+1 500,00;VIR DUPONT;\n"
        ";;;;;\n"
        "Solde en début de période;;;;+10 890,87;\n"
    )
    adapter, rows = parse_csv(text)
    assert lines(rows) == [
        ("2026-10-31", "PRLV EDF – PRLV SEPA EDF ENTREPRISES", "-45.20", "1234567"),
        ("2026-10-30", "VIR DUPONT", "1500.00", "1234568"),
    ]
    assert adapter.import_notes[1:] == ("1 ligne de solde ou de total ignorée.",)


def test_boursorama_export_with_iso_dates_and_short_decimals():
    text = (
        "dateOp;dateVal;label;category;categoryParent;supplierFound;amount;comment;accountNum;accountLabel;accountbalance\n"
        '2026-10-02;2026-10-03;"CARTE 01/10/26 AMAZON";"Achats";"Divers";"amazon";-12,5;;00040123456;"BoursoBank";1234,56\n'
        '2026-10-05;2026-10-05;"VIR SEPA CLIENT";"Virements";"Virements reçus";;250;;00040123456;"BoursoBank";1484,56\n'
    )
    _, rows = parse_csv(text)
    assert lines(rows) == [
        ("2026-10-02", "CARTE 01/10/26 AMAZON", "-12.50", None),
        ("2026-10-05", "VIR SEPA CLIENT", "250.00", None),
    ]


def test_la_banque_postale_export_with_key_value_preamble_and_euro_amount_header():
    text = (
        "Numéro Compte   ;0123456X020\n"
        "Type ;CCP\n"
        "Compte tenu en  ;euros\n"
        "Date;31/10/2026\n"
        "Solde (EUROS);1 234,56\n"
        "\n"
        "Date;Libellé;Montant(EUROS)\n"
        '31/10/2026;"PRELEVEMENT DE EDF";-45,20\n'
        '30/10/2026;"VIREMENT DE M DUPONT";1 500,00\n'
    )
    _, rows = parse_csv(text)
    assert lines(rows) == [
        ("2026-10-31", "PRELEVEMENT DE EDF", "-45.20", None),
        ("2026-10-30", "VIREMENT DE M DUPONT", "1500.00", None),
    ]
    with pytest.raises(ConnectorValidationError, match="Devise incompatible : EUR, attendue CHF"):
        parse_csv(text, currency="CHF")


def test_unsigned_amount_with_a_direction_column():
    text = (
        "Date;Libellé;Montant;Sens\n"
        "02/10/2026;Loyer octobre;1 200,00;D\n"
        "03/10/2026;Règlement client;300,00;C\n"
        "04/10/2026;Frais tenue de compte;-20,00;Débit\n"
        "05/10/2026;Remise chèques;80,00;Crédit\n"
    )
    _, rows = parse_csv(text)
    assert [str(row.amount) for row in rows] == ["-1200.00", "300.00", "-20.00", "80.00"]


@pytest.mark.parametrize(("row", "message"), [
    ("02/10/2026;Loyer;1 200,00;X", "Ligne 2 : sens « X » non reconnu"),
    ("02/10/2026;Loyer;1 200,00;", "Ligne 2 : sens absent"),
    ("02/10/2026;Loyer;-1 200,00;C", "Ligne 2 : montant négatif avec un sens crédit"),
])
def test_direction_column_errors(row, message):
    with pytest.raises(ConnectorValidationError, match=message):
        parse_csv(f"Date;Libellé;Montant;Sens\n{row}\n")


def test_operation_date_wins_over_value_and_accounting_dates_whatever_the_column_order():
    text = (
        "Date de valeur;Date comptable;Date;Libellé;Montant\n"
        "05/10/2026;04/10/2026;03/10/2026;Achat;-10,00\n"
    )
    assert parse_csv(text)[1][0].date.isoformat() == "2026-10-03"


@pytest.mark.parametrize(("text", "currency", "message"), [
    ("Date;Libellé;Débit;Crédit\n01/10/2026;A;-10,00;\n02/10/2026;B;20,00;\n", "EUR",
     r"Colonne « Débit » : montants positifs \(Ligne 3\) et négatifs \(Ligne 2\) mélangés"),
    ("Date;Libellé;Débit;Crédit\n01/10/2026;A;;-10,00\n", "EUR", "Ligne 2 : crédit négatif inattendu"),
    ("Date;Libellé;Débit;Crédit\n01/10/2026;A;10,00;5,00\n", "EUR", "Ligne 2 : débit et crédit renseignés"),
    ("Date;Libellé;Intitulé;Montant\n01/10/2026;A;B;1,00\n", "EUR", "En-têtes ambigus : « Libellé » / « Intitulé »"),
    ("Opération;Valeur\n01/10/2026;1,00\n", "EUR", "En-tête introuvable dans les 30 premières lignes"),
    ("Date;Libellé;Montant\n;Achat;12,00\n", "EUR", "Ligne 2 : date absente"),
    ("Date;Libellé;Montant\n31/02/2026;Achat;12,00\n", "EUR", "Ligne 2 : date invalide « 31/02/2026 »"),
    ("Date;Libellé;Montant\n01/10/2026;Achat;\n", "EUR", "Ligne 2 : montant absent"),
    ("Date;Libellé;Montant\n01/10/2026;Achat;1,234\n", "EUR", "colonne « Montant » : montant invalide « 1,234 »"),
    ("Date;Libellé;Montant\n01/10/2026;Achat;+-12,00\n", "EUR", "montant invalide"),
    ("Date;Libellé;Montant\n01/10/2026;Achat;12,00;extra\n", "EUR", "Ligne 2 : plus de colonnes que l’en-tête"),
    ("Date;Libellé;Montant\n01/10/2026;Achat\n", "EUR", "Ligne 2 : colonnes manquantes"),
    ("Date;Libellé;Montant;Devise\n01/10/2026;Achat;12,00;USD\n", "EUR", "Devise incompatible : USD, attendue EUR"),
    ("Date;Libellé;Montant\n01/10/2026;Achat;12,00 €\n", "CHF", "Devise incompatible : EUR, attendue CHF"),
    ("Date;Libellé;Débit EUR;Crédit EUR\n01/10/2026;Achat;12,00;\n", "CHF", "Devise incompatible : EUR, attendue CHF"),
    ("Date;Libellé;Montant\n", "EUR", "aucune écriture exploitable"),
    ("Date;Libellé;Montant\n01/10/2026;Achat;0,00\n", "EUR", "aucune écriture exploitable"),
])
def test_csv_errors_are_explicit_and_located(text, currency, message):
    with pytest.raises(ConnectorValidationError, match=message):
        parse_csv(text, currency=currency)


@pytest.mark.parametrize(("raw", "message"), [
    (b"PK\x03\x04 classeur", "Classeur Excel détecté : exportez le relevé au format CSV"),
    (b"\xd0\xcf\x11\xe0 ancien classeur", "Classeur Excel détecté"),
    (b"Date;Libell\x00;Montant\n", "Octet NUL"),
    (b"Date;Libelle;Montant\n01/10/2026;\x81;1,00\n", "Encodage du relevé non reconnu"),
    (b"", "non vide de 5 Mio au plus"),
])
def test_binary_or_unreadable_files_are_refused(raw, message):
    with pytest.raises(ConnectorValidationError, match=message):
        parse_csv(raw)


def test_balance_total_and_zero_lines_are_skipped_and_reported_but_merchants_named_total_are_kept():
    text = (
        "Date;Libellé;Débit;Crédit\n"
        "01/10/2026;Solde au 30/09/2026;;\n"
        "02/10/2026;TOTAL MARKETING FRANCE;60,00;\n"
        "03/10/2026;TOTALENERGIES RELAIS;40,00;\n"
        "04/10/2026;Commission annulée;0,00;\n"
        "Total des opérations;;100,00;0,00\n"
        "Nouveau solde;;;1 900,00\n"
    )
    adapter, rows = parse_csv(text)
    assert [row.label for row in rows] == ["TOTAL MARKETING FRANCE", "TOTALENERGIES RELAIS"]
    assert adapter.import_notes[1:] == (
        "3 lignes de solde ou de total ignorées.", "1 ligne à montant nul ignorée.",
    )


def test_utf16_tab_separated_export():
    raw = "Date\tLibellé\tMontant\r\n02/10/2026\tCafé du Port\t-3,50\r\n".encode("utf-16")
    assert raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))
    assert lines(parse_csv(raw)[1]) == [("2026-10-02", "Café du Port", "-3.50", None)]


def test_labels_are_cleaned_truncated_or_given_a_default():
    long_label = "VIR SEPA " + "X" * 200
    text = (
        "Date;Libellé;Montant\n"
        f"01/10/2026;{long_label};-1,00\n"
        "02/10/2026;  Paiement\tcarte  ;-2,00\n"
        "03/10/2026;;-3,00\n"
    )
    labels = [row.label for row in parse_csv(text)[1]]
    assert len(labels[0]) == 160 and labels[0].endswith("…") and labels[0].startswith("VIR SEPA XXX")
    assert labels[1:] == ["Paiement carte", "Opération bancaire sans libellé"]


def test_transaction_identity_ignores_column_layout_and_number_format_but_counts_identical_lines():
    debit_credit = parse_csv("Date;Libellé;Débit;Crédit\n02/10/2026;Café;12,5;\n02/10/2026;Café;12,5;\n")[1]
    signed = parse_csv("Libellé;Date;Montant\nCafé;2026-10-02;-12,50\nCafé;02/10/2026;-12.50\n")[1]
    ids = [row.source_transaction_id for row in debit_credit]
    assert ids == [row.source_transaction_id for row in signed]
    assert len(set(ids)) == 2 and all(value.startswith("bank-") for value in ids)
    with_reference = parse_csv("Date;Libellé;Montant;Référence\n02/10/2026;Café;-12,50;R1\n")[1]
    assert with_reference[0].source_transaction_id not in ids


def test_reported_line_numbers_are_physical_lines_despite_preamble_and_multiline_labels():
    text = (
        "Relevé de compte;\n"
        "\n"
        "Date;Libellé;Montant\n"
        '01/10/2026;"Libellé\nsur deux lignes";-1,00\n'
        "02/10/2026;Achat;-2,00\n"
        "32/10/2026;Achat;-3,00\n"
    )
    with pytest.raises(ConnectorValidationError, match="^Ligne 7 : date invalide"):
        parse_csv(text)


@pytest.mark.parametrize(("amounts", "warned"), [
    (["10,00", "20,00", "30,00", "40,00", "50,00"], True),
    (["10,00", "20,00", "30,00", "40,00"], False),
    (["10,00", "20,00", "30,00", "40,00", "-50,00"], False),
])
def test_a_signed_amount_column_without_any_debit_is_flagged_for_review(amounts, warned):
    body = "".join(f"0{day}/10/2026;Opération {day};{amount}\n" for day, amount in enumerate(amounts, 1))
    adapter, _ = parse_csv("Date;Libellé;Montant\n" + body)
    assert bool(adapter.import_warnings) is warned
    if warned:
        assert adapter.import_warnings[0].startswith("Aucun montant négatif dans la colonne « Montant » sur 5 écritures")
    direction, _ = parse_csv("Date;Libellé;Montant;Sens\n" + body.replace("\n", ";C\n").replace("-50,00", "50,00"))
    assert direction.import_warnings == ()


# Même chaîne que BANK_CSV_TEMPLATE (frontend/src/companyFinance.js) : le modèle vierge proposé dans l’interface.
INTERFACE_TEMPLATE = "\ufeffDate;Libellé;Débit;Crédit;Référence\r\n"


def test_blank_template_downloaded_from_the_interface_is_understood_once_filled():
    with pytest.raises(ConnectorValidationError, match="aucune écriture exploitable"):
        parse_csv(INTERFACE_TEMPLATE)
    filled = INTERFACE_TEMPLATE + "03/03/2025;PRLV LOYER MARS;1 200,00;;BAIL-2025-03\r\n05/03/2025;REMISE CB;;2 450,80;\r\n"
    assert lines(parse_csv(filled)[1]) == [
        ("2025-03-03", "PRLV LOYER MARS", "-1200.00", "BAIL-2025-03"),
        ("2025-03-05", "REMISE CB", "2450.80", None),
    ]


# --- OFX ---------------------------------------------------------------------------------------------------------------

OFX_SGML = """OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261031120000<LANGUAGE>FRA</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>00000000<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>EUR
<BANKACCTFROM><BANKID>30002<BRANCHID>00550<ACCTID>0000123456F<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261031
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<DTUSER>20261001<TRNAMT>-1234,50<FITID>FIT-0001<NAME>PRLV SEPA EDF<MEMO>Échéance d'octobre</STMTTRN>
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20261003120000.000[+1:CET]<TRNAMT>-80.00<FITID>FIT-0002<CHECKNUM>1234567<NAME>CHEQUE 1234567</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005<TRNAMT>+2000.00<FITID>FIT-0003<NAME>VIR SARL DUPONT<MEMO>VIR SARL DUPONT FACTURE 104</STMTTRN>
<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20261006<TRNAMT>0.00<FITID>FIT-0004<NAME>INFORMATION</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>12345,67<DTASOF>20261031</LEDGERBAL>
<AVAILBAL><BALAMT>99999.99<DTASOF>20261031</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
"""

OFX_XML = """<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
    <STMTRS>
      <CURDEF>EUR</CURDEF>
      <BANKACCTFROM><BANKID>17515</BANKID><ACCTID>FR7617515900000123456789012</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
      <BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261031</DTEND>
        <STMTTRN>
          <TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20261010</DTPOSTED><TRNAMT>-59.90</TRNAMT><FITID>X-1</FITID>
          <PAYEE><NAME>DUPONT &amp; FILS</NAME><ADDR1>1 rue du Port</ADDR1><CITY>Brest</CITY></PAYEE>
          <MEMO>Facture n&#176; 42</MEMO>
        </STMTTRN>
        <STMTTRN>
          <TRNTYPE>DEP</TRNTYPE><DTPOSTED>20261011</DTPOSTED><TRNAMT>12.500</TRNAMT><FITID>X-2</FITID>
          <NAME>REMISE ESPECES</NAME><REFNUM>RE-778</REFNUM>
        </STMTTRN>
      </BANKTRANLIST>
    </STMTRS>
  </STMTTRNRS></BANKMSGSRSV1>
</OFX>
"""


def test_ofx_1_sgml_in_windows_1252_with_decimal_comma_cheque_number_and_declared_balance():
    adapter, rows = parse_ofx(OFX_SGML.encode("cp1252"))
    assert lines(rows) == [
        ("2026-10-02", "PRLV SEPA EDF – Échéance d'octobre", "-1234.50", None),
        ("2026-10-03", "CHEQUE 1234567", "-80.00", "Chèque 1234567"),
        ("2026-10-05", "VIR SARL DUPONT FACTURE 104", "2000.00", None),
    ]
    assert adapter.import_notes == (
        f"Relevé du 02/10/2026 au 05/10/2026 : 3 écritures lues — débits 1{NNBSP}314,50{NBSP}€, "
        f"crédits 2{NNBSP}000,00{NBSP}€.",
        "1 transaction à montant nul ignorée.",
        f"Solde comptable déclaré par la banque : 12{NNBSP}345,67{NBSP}€ au 31/10/2026.",
    )
    assert all(row.source_transaction_id.startswith("ofx-") for row in rows)


def test_ofx_2_xml_with_entities_payee_aggregate_reference_and_trailing_zero():
    _, rows = parse_ofx(OFX_XML.encode("utf-8"))
    assert lines(rows) == [
        ("2026-10-10", "DUPONT & FILS – Facture n° 42", "-59.90", None),
        ("2026-10-11", "REMISE ESPECES", "12.50", "RE-778"),
    ]


def test_ofx_identity_relies_on_account_and_fitid_not_on_the_label():
    original = [row.source_transaction_id for row in parse_ofx(OFX_SGML.encode("cp1252"))[1]]
    relabelled = OFX_SGML.replace("Échéance d'octobre", "Libellé enrichi par la banque").replace("VIR SARL", "VIREMENT SARL")
    assert [row.source_transaction_id for row in parse_ofx(relabelled.encode("cp1252"))[1]] == original
    other_account = OFX_SGML.replace("0000123456F", "0000999999F")
    assert not {row.source_transaction_id for row in parse_ofx(other_account.encode("cp1252"))[1]} & set(original)


def test_reused_fitids_never_merge_distinct_transactions():
    doubled = OFX_SGML.replace("FIT-0002", "FIT-0001").replace("<TRNAMT>0.00<FITID>FIT-0004", "<TRNAMT>-1234,50<FITID>FIT-0001")
    doubled = doubled.replace("<DTPOSTED>20261006", "<DTPOSTED>20261002")
    ids = [row.source_transaction_id for row in parse_ofx(doubled.encode("cp1252"))[1]]
    assert len(ids) == 4 and len(set(ids)) == 4


@pytest.mark.parametrize(("change", "currency", "message"), [
    (("<STMTRS>", "<CCSTMTRS>"), "EUR", "Relevé de carte ou de titres refusé"),
    (("</STMTTRNRS>", "</STMTTRNRS><STMTTRNRS><STMTRS><CURDEF>EUR</STMTRS></STMTTRNRS>"), "EUR", "plusieurs comptes"),
    (("<CURDEF>EUR", "<CURDEF>USD"), "EUR", "Devise incompatible : USD, attendue EUR"),
    (("<NAME>INFORMATION", "<CURRENCY><CURRATE>1.08<CURSYM>USD</CURRENCY><NAME>INFORMATION"), "EUR",
     r"Transaction OFX 4 \(FITID FIT-0004\) : montant exprimé en USD, attendu EUR"),
    (("<OFX>", "<DOCUMENT>"), "EUR", "balise <OFX> absente"),
    (("<TRNAMT>-80.00", "<TRNAMT>-80.005"), "EUR", r"Transaction OFX 2 \(FITID FIT-0002\) : montant TRNAMT absent ou non exprimé au centime"),
    (("<DTPOSTED>20261005", "<DTPOSTED>20261305"), "EUR", "Transaction OFX 3 .* date DTPOSTED absente ou invalide"),
    (("<NAME>INFORMATION</STMTTRN>", "<NAME>INFORMATION"), "EUR", "balise </STMTTRN> manquante"),
    (("</STMTRS>", ""), "EUR", "balise </STMTRS> absente"),
    (("<CURDEF>EUR", "<CURDEF>EUR"), "CHF", "Devise incompatible : EUR, attendue CHF"),
])
def test_ofx_errors_are_explicit(change, currency, message):
    with pytest.raises(ConnectorValidationError, match=message):
        parse_ofx(OFX_SGML.replace(*change).encode("cp1252"), currency=currency)


def test_ofx_without_statement_is_refused():
    with pytest.raises(ConnectorValidationError, match="Aucun relevé de compte bancaire"):
        parse_ofx(b"<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>")


# --- API : import, doublons, journal et annulation --------------------------------------------------------------------


@pytest.fixture
def engine(tmp_path):
    engine = create_finance_engine(URL.create("sqlite", database=str(tmp_path / "finance.sqlite3")))
    with Session(engine) as session:
        session.add_all([
            CompanyProfile(id="a", name="Entreprise A", sector=SectorEnum.SERVICES, currency="EUR"),
            CompanyProfile(id="b", name="Entreprise B", sector=SectorEnum.RETAIL, currency="EUR"),
        ])
        session.commit()
    yield engine
    engine.dispose()


@pytest.fixture
def client(engine):
    def member(query):
        role = MEMBERS.get((query["user_id"], query["company_id"]))
        return {"role": role} if role else None

    database = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(side_effect=member)))

    async def require_user(request, _database):
        user = request.headers.get("x-test-user")
        if not user:
            raise HTTPException(401, "Authentification requise.")
        return {"user_id": user}

    def session_dependency():
        with Session(engine) as session:
            yield session

    app = FastAPI()
    app.include_router(make_company_finance_router(database, require_user), prefix="/api")
    app.dependency_overrides[get_db] = session_dependency
    with TestClient(app) as test_client:
        yield test_client


def statement(*days, preamble=""):
    body = "".join(f"{day:02d}/10/2026;Opération du {day};-{day},00\n" for day in days)
    return f"{preamble}Date;Libellé;Montant\n{body}".encode("utf-8")


def import_csv(client, raw, company="a"):
    return client.post(f"/api/finance/{company}/ingestions/bank_statement_csv", content=raw, headers=CSV)


def movement_count(engine):
    with Session(engine) as session:
        return session.scalar(select(func.count()).select_from(CashMovement))


def test_ofx_import_through_the_api_is_labelled_and_reviewable(client):
    wrong_type = client.post("/api/finance/a/ingestions/bank_statement_ofx", content=OFX_SGML.encode("cp1252"), headers=CSV)
    assert wrong_type.status_code == 415 and wrong_type.json()["detail"] == "Content-Type requis : application/x-ofx."
    response = client.post("/api/finance/a/ingestions/bank_statement_ofx", content=OFX_SGML.encode("cp1252"), headers=OFX)
    assert response.status_code == 200
    result = response.json()
    assert (result["source"], result["record_count"], result["duplicate_count"], result["replayed"]) == (
        "bank_statement_ofx", 3, 0, False,
    )
    assert result["notes"][0].startswith("Relevé du 02/10/2026 au 05/10/2026 : 3 écritures lues")
    assert result["review_required"] and any("CSV et OFX" in warning for warning in result["warnings"])
    entries = client.get("/api/finance/a/entries/cash_movements", headers=USER).json()["entries"]
    assert {entry["origin"] for entry in entries} == {"bank_statement_ofx"}
    assert sorted(entry["values"]["amount"] for entry in entries) == ["-1234.50", "-80.00", "2000.00"]


def test_overlapping_statements_only_add_new_lines_and_identical_files_are_replayed(client, engine):
    first = import_csv(client, statement(1, 2, 3, 4))
    assert first.status_code == 200 and first.json()["record_count"] == 4
    overlap = import_csv(client, statement(3, 4, 5, 6, preamble="Export du 31/10/2026;\n"))
    assert overlap.status_code == 200
    result = overlap.json()
    assert (result["record_count"], result["duplicate_count"]) == (2, 2)
    assert result["notes"][-1] == "2 écritures déjà importées ignorées ; 2 nouvelles écritures enregistrées."
    assert movement_count(engine) == 6

    replay = import_csv(client, statement(1, 2, 3, 4))
    assert replay.status_code == 200 and replay.json()["replayed"] and replay.json()["batch_id"] == first.json()["batch_id"]
    assert replay.json()["notes"] == first.json()["notes"]

    covered = import_csv(client, statement(2, 3, 4, 5, preamble="Autre export;\n"))
    assert covered.status_code == 409
    assert covered.json()["detail"] == "Les 4 écritures de ce relevé ont déjà été importées ; aucune nouvelle écriture."
    assert movement_count(engine) == 6


def test_review_warnings_of_an_import_are_kept_in_the_result_and_the_journal(client):
    unsigned = "Date;Libellé;Montant\n" + "".join(f"0{day}/10/2026;Opération {day};{day}0,00\n" for day in range(1, 6))
    result = import_csv(client, unsigned.encode("utf-8")).json()
    assert result["warnings"][0].startswith("Aucun montant négatif dans la colonne « Montant »")
    journal = client.get("/api/finance/a/ingestions", headers=USER).json()
    assert journal["batches"][0]["warnings"] == result["warnings"]


def test_import_journal_and_atomic_revert_of_one_batch(client, engine):
    kept = import_csv(client, statement(1, 2)).json()
    reverted = import_csv(client, statement(10, 11, 12)).json()
    entries = client.get("/api/finance/a/entries/cash_movements", headers=USER).json()["entries"]
    removed_by_hand = next(entry for entry in entries if entry["values"]["label"] == "Opération du 12")
    assert client.delete(f"/api/finance/a/entries/cash_movements/{removed_by_hand['id']}", headers=USER).status_code == 204

    journal = client.get("/api/finance/a/ingestions", headers=USER)
    assert journal.status_code == 200
    batches = journal.json()["batches"]
    assert [(batch["batch_id"], batch["record_count"], batch["remaining_count"]) for batch in batches] == [
        (reverted["batch_id"], 3, 2), (kept["batch_id"], 2, 2),
    ]
    assert journal.json()["truncated"] is False and batches[0]["created_at"].endswith("Z")
    assert batches[0]["notes"][0].startswith("Relevé du 10/10/2026 au 12/10/2026 : 3 écritures lues")

    assert client.delete(f"/api/finance/b/ingestions/{reverted['batch_id']}", headers={"x-test-user": "u2"}).status_code == 404
    assert client.delete(f"/api/finance/a/ingestions/{reverted['batch_id']}", headers={"x-test-user": "viewer"}).status_code == 403
    assert client.delete(f"/api/finance/a/ingestions/{reverted['batch_id']}", headers=USER).status_code == 204
    assert client.delete(f"/api/finance/a/ingestions/{reverted['batch_id']}", headers=USER).status_code == 404
    assert client.delete("/api/finance/a/ingestions/pas-un-identifiant", headers=USER).status_code == 422

    with Session(engine) as session:
        assert sorted(row.label for row in session.scalars(select(CashMovement))) == ["Opération du 1", "Opération du 2"]
        assert session.scalar(select(func.count()).select_from(FinanceIngestionItem)) == 2
        assert session.scalars(select(FinanceIngestionBatch.id)).all() == [kept["batch_id"]]
    events = client.get("/api/finance/a/audit", headers=USER).json()["events"]
    assert (events[0]["action"], events[0]["entry_kind"], events[0]["entry_id"]) == (
        "revert", "bank_statement_csv", reverted["batch_id"],
    )
    assert events[0]["summary"].startswith("Annulation de l’import relevé bancaire CSV : 2 écriture(s) supprimée(s)")

    again = import_csv(client, statement(10, 11, 12))
    assert again.status_code == 200 and not again.json()["replayed"] and again.json()["record_count"] == 3
    assert [batch["batch_id"] for batch in client.get("/api/finance/a/ingestions", headers=USER).json()["batches"]] == [
        again.json()["batch_id"], kept["batch_id"],
    ]


def test_import_journal_is_private_to_each_company_and_role(client):
    import_csv(client, statement(1))
    assert client.get("/api/finance/a/ingestions", headers={"x-test-user": "viewer"}).status_code == 403
    assert client.get("/api/finance/a/ingestions", headers={"x-test-user": "u2"}).status_code == 404
    assert client.get("/api/finance/b/ingestions", headers={"x-test-user": "u2"}).json() == {"batches": [], "truncated": False}
    assert client.get("/api/finance/a/ingestions?limit=0", headers=USER).status_code == 422
