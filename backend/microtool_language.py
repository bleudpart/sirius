"""Finite JSON pipelines, not a sandbox for Python, JavaScript or system commands."""

import json
import math
from typing import Annotated, Literal

from pydantic import Field, JsonValue, StrictBool, StrictFloat, StrictInt, StrictStr, field_validator

from action_registry import ActionInputs

MAX_BYTES = 16000
MAX_ITEMS = 200


class ToolLimitError(ValueError):
    pass


def bounded_data(value):
    stack = [(value, 0)]
    nodes = 0
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if nodes > 1000 or depth > 4:
            raise ToolLimitError("Données limitées à 1 000 éléments et quatre niveaux.")
        if item is None or type(item) is bool:
            continue
        if type(item) in (int, float):
            if abs(item) > 1e12 or not math.isfinite(item):
                raise ToolLimitError("Nombre non fini ou supérieur à 10 puissance 12 en valeur absolue.")
        elif type(item) is str:
            if len(item) > 8000:
                raise ToolLimitError("Texte limité à 8 000 caractères.")
        elif type(item) is list:
            if len(item) > MAX_ITEMS:
                raise ToolLimitError("Liste limitée à 200 éléments.")
            stack.extend((child, depth + 1) for child in item)
        elif type(item) is dict:
            if len(item) > 20 or any(type(key) is not str or len(key) > 100 for key in item):
                raise ToolLimitError("Objet limité à vingt clés textuelles de cent caractères.")
            stack.extend((child, depth + 1) for child in item.values())
        else:
            raise ToolLimitError("Valeur JSON attendue.")
    try:
        size = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ToolLimitError("Texte Unicode invalide pour un encodage UTF-8.") from exc
    if size > MAX_BYTES:
        raise ToolLimitError("Données limitées à 16 000 octets JSON UTF-8.")
    return value


class SimpleOp(ActionInputs):
    op: Literal["strip", "lower", "upper", "lines", "unique", "sort", "sum", "count"]


class SplitOp(ActionInputs):
    op: Literal["split"]
    separator: str = Field(min_length=1, max_length=100)


class JoinOp(ActionInputs):
    op: Literal["join"]
    separator: str = Field(max_length=100)


class ReplaceOp(ActionInputs):
    op: Literal["replace"]
    old: str = Field(min_length=1, max_length=100)
    new: str = Field(max_length=100)


class ColumnOp(ActionInputs):
    op: Literal["column"]
    key: str = Field(min_length=1, max_length=100)


class FilterOp(ActionInputs):
    op: Literal["filter_equals"]
    key: str = Field(min_length=1, max_length=100)
    value: StrictStr | StrictInt | StrictFloat | StrictBool | None

    @field_validator("value")
    @classmethod
    def finite(cls, value):
        return bounded_data(value)


Operation = Annotated[SimpleOp | SplitOp | JoinOp | ReplaceOp | ColumnOp | FilterOp, Field(discriminator="op")]


class ToolProgram(ActionInputs):
    version: Literal[1]
    steps: list[Operation] = Field(min_length=1, max_length=12)

    @field_validator("version", mode="before")
    @classmethod
    def exact_version(cls, value):
        if type(value) is not int:
            raise ValueError("Version entière requise.")
        return value

    @field_validator("steps")
    @classmethod
    def valid_unicode(cls, steps):
        for step in steps:
            bounded_data(step.model_dump(mode="json"))
        return steps


class ToolExample(ActionInputs):
    input: JsonValue
    expected: JsonValue

    @field_validator("input", "expected")
    @classmethod
    def bounded(cls, value):
        return bounded_data(value)


class MicroToolInputs(ActionInputs):
    objective: str = Field(min_length=1, max_length=1000)
    data: JsonValue
    examples: list[ToolExample] = Field(min_length=1, max_length=5)

    @field_validator("objective")
    @classmethod
    def meaningful(cls, value):
        if not value.strip():
            raise ValueError("Objectif requis.")
        return value.strip()

    @field_validator("data")
    @classmethod
    def bounded(cls, value):
        return bounded_data(value)


def text(value):
    if type(value) is not str:
        raise ToolLimitError("Cette opération exige un texte.")
    return value


def sequence(value):
    if type(value) is not list:
        raise ToolLimitError("Cette opération exige une liste.")
    return value


def scalar(value):
    return value is None or type(value) in (str, int, float, bool)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True)


def apply_operation(step, value):
    op = step.op
    if op in ("strip", "lower", "upper"):
        return getattr(text(value), op)()
    if op == "lines":
        return text(value).splitlines()
    if isinstance(step, SplitOp):
        source = text(value)
        if source.count(step.separator) >= MAX_ITEMS:
            raise ToolLimitError("Découpage supérieur à 200 éléments.")
        return source.split(step.separator)
    if isinstance(step, ReplaceOp):
        source = text(value)
        size = len(source) + source.count(step.old) * (len(step.new) - len(step.old))
        if size > 8000:
            raise ToolLimitError("Remplacement supérieur à 8 000 caractères.")
        return source.replace(step.old, step.new)
    if isinstance(step, JoinOp):
        items = sequence(value)
        if any(type(item) is not str for item in items):
            raise ToolLimitError("Jointure réservée aux textes.")
        if sum(map(len, items)) + max(0, len(items) - 1) * len(step.separator) > 8000:
            raise ToolLimitError("Jointure supérieure à 8 000 caractères.")
        return step.separator.join(items)
    if isinstance(step, (ColumnOp, FilterOp)):
        items = sequence(value)
        if any(type(item) is not dict or step.key not in item for item in items):
            raise ToolLimitError("Chaque ligne doit contenir la colonne demandée ; aucune valeur inventée.")
        if isinstance(step, ColumnOp):
            return [item[step.key] for item in items]
        return [item for item in items if type(item[step.key]) is type(step.value) and item[step.key] == step.value]
    if op == "count":
        if type(value) not in (str, list):
            raise ToolLimitError("Comptage réservé au texte ou aux listes.")
        return len(value)
    items = sequence(value)
    if op == "sum":
        if any(type(item) not in (int, float) for item in items):
            raise ToolLimitError("Somme réservée aux nombres, sans booléens ni conversions implicites.")
        return math.fsum(items) if any(type(item) is float for item in items) else sum(items)
    if op == "sort":
        if items and (type(items[0]) not in (str, int, float) or any(type(item) is not type(items[0]) for item in items)):
            raise ToolLimitError("Tri réservé à une liste homogène de textes ou nombres.")
        return sorted(items)
    if op == "unique":
        if any(not scalar(item) for item in items):
            raise ToolLimitError("Déduplication réservée aux valeurs scalaires.")
        seen, result = set(), []
        for item in items:
            identity = canonical(item)
            if identity not in seen:
                seen.add(identity)
                result.append(item)
        return result
    raise ToolLimitError("Opération non enregistrée.")


def execute_program(program: ToolProgram, data):
    value = bounded_data(data)
    trace = []
    for index, step in enumerate(program.steps):
        value = bounded_data(apply_operation(step, value))
        trace.append({"step": index + 1, "op": step.op, "bytes": len(canonical(value).encode("utf-8"))})
    return value, trace


def test_program(program, examples):
    reports = []
    for index, example in enumerate(examples):
        try:
            actual, _ = execute_program(program, example.input)
            passed = canonical(actual) == canonical(example.expected)
            reports.append({"example": index + 1, "passed": passed,
                            "reason": None if passed else "Résultat différent de l'attendu fourni."})
        except ToolLimitError as exc:
            reports.append({"example": index + 1, "passed": False, "reason": str(exc)})
    return reports
