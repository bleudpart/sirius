"""Explicit, server-owned action contracts. No arbitrary Python or URL execution."""

from dataclasses import dataclass
from typing import Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError
from fastapi import HTTPException


class ActionInputs(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ActionResult(ActionInputs):
    completion: Literal["COMPLETE", "PARTIAL"] = "COMPLETE"
    issues: list[str] = Field(default_factory=list)


class ActionOutput(ActionResult):
    data: dict[str, JsonValue]


@dataclass(frozen=True)
class ActionContext:
    user_id: str
    run_id: str
    step_id: str
    idempotency_key: str


@dataclass(frozen=True)
class ActionSource:
    input: str
    action: str
    path: tuple[str, ...]


@dataclass(frozen=True)
class ActionDefinition:
    name: str
    module: str
    title: str
    version: str
    inputs: type[BaseModel]
    output: type[ActionResult]
    handler: Callable[[ActionContext, BaseModel], Awaitable[BaseModel]]
    kind: Literal["read", "prepare", "mutation"] = "read"
    risk: Literal["low", "sensitive"] = "low"
    idempotent: bool = True
    timeout_seconds: int = 30
    max_attempts: int = 3
    reversible: bool = False
    sources: tuple[ActionSource, ...] = ()

    @property
    def confirmation_required(self):
        return self.kind == "mutation" or self.risk == "sensitive"

    def contract(self):
        return {
            "name": self.name, "module": self.module, "title": self.title, "version": self.version,
            "kind": self.kind, "risk": self.risk, "confirmation_required": self.confirmation_required,
            "idempotent": self.idempotent, "timeout_seconds": self.timeout_seconds,
            "max_attempts": self.max_attempts, "reversible": self.reversible,
            "required_sources": [{"input": source.input, "action": source.action, "path": list(source.path)}
                                 for source in self.sources],
            "input_schema": self.inputs.model_json_schema(), "output_schema": self.output.model_json_schema(),
        }


class ActionRegistry:
    def __init__(self):
        self._actions: dict[str, ActionDefinition] = {}

    def register(self, action: ActionDefinition):
        if action.name in self._actions:
            raise ValueError(f"Duplicate action: {action.name}")
        if not action.idempotent or not 1 <= action.max_attempts <= 3 or not 1 <= action.timeout_seconds <= 30:
            raise ValueError("Registered actions require idempotent replay, 1–3 attempts and a bounded timeout.")
        if action.kind == "mutation" and action.risk != "sensitive":
            raise ValueError("Mutations must declare sensitive risk.")
        if action.reversible:
            raise ValueError("Compensation is not implemented; do not advertise reversible actions.")
        if any(source.input not in action.inputs.model_fields for source in action.sources):
            raise ValueError("An action source must refer to a declared input.")
        if not issubclass(action.output, ActionResult):
            raise ValueError("Actions must expose an explicit completion contract.")
        self._actions[action.name] = action

    def get(self, name):
        if name not in self._actions:
            raise HTTPException(422, "Action non enregistrée dans le catalogue ARIANE.")
        return self._actions[name]

    def catalog(self):
        return [action.contract() for action in self._actions.values()]

    def validate_inputs(self, name, values):
        try:
            return self.get(name).inputs.model_validate(values).model_dump(mode="json")
        except ValidationError as exc:
            raise HTTPException(422, "Entrées de l'action invalides ; consultez son contrat.") from exc
