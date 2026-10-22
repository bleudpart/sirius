import json

import pytest
from pydantic import ValidationError

from microtool_language import (MicroToolInputs, ToolExample, ToolLimitError, ToolProgram,
                                bounded_data, execute_program, test_program as check_examples)


def program(*steps):
    return ToolProgram.model_validate({"version": 1, "steps": list(steps)})


@pytest.mark.parametrize("steps,value,expected", [
    ([{"op": "strip"}, {"op": "upper"}], "  bonjour  ", "BONJOUR"),
    ([{"op": "lower"}, {"op": "split", "separator": ","}, {"op": "unique"}, {"op": "sort"},
      {"op": "join", "separator": ";"}], "B,a,b", "a;b"),
    ([{"op": "replace", "old": ".", "new": "!"}], "a.b.", "a!b!"),
    ([{"op": "lines"}, {"op": "count"}], "a\r\nb\nc", 3),
    ([{"op": "column", "key": "amount"}, {"op": "sum"}], [{"amount": 2}, {"amount": 3}], 5),
    ([{"op": "filter_equals", "key": "active", "value": True}, {"op": "count"}],
     [{"active": True}, {"active": 1}, {"active": False}], 1),
    ([{"op": "filter_equals", "key": "code", "value": "001"}, {"op": "count"}],
     [{"code": "001"}, {"code": 1}], 1),
    ([{"op": "sum"}], [0.1, 0.2, 0.3], 0.6),
    ([{"op": "unique"}], [True, 1, 1.0, "1", None, True], [True, 1, 1.0, "1", None]),
])
def test_finite_pipelines_preserve_exact_contract(steps, value, expected):
    result, trace = execute_program(program(*steps), value)
    assert result == expected
    assert len(trace) == len(steps) and trace[-1]["bytes"] > 0


@pytest.mark.parametrize("step", [
    {"op": "eval", "code": "print('no')"}, {"op": "shell", "command": "whoami"},
    {"op": "read_file", "path": "private"}, {"op": "http", "url": "https://example.test"},
    {"op": "replace", "old": "", "new": "x"}, {"op": "split", "separator": ""},
    {"op": "strip", "code": "private"}, {"op": "column", "key": "x", "default": 0},
])
def test_unregistered_capabilities_and_extra_fields_are_rejected(step):
    with pytest.raises(ValidationError):
        program(step)


@pytest.mark.parametrize("value", [True, "1", 1.0, 2])
def test_version_is_exact_not_coerced(value):
    with pytest.raises(ValidationError):
        ToolProgram.model_validate({"version": value, "steps": [{"op": "strip"}]})


def test_exact_step_limit():
    assert len(program(*[{"op": "strip"}] * 12).steps) == 12
    for steps in ([], [{"op": "strip"}] * 13):
        with pytest.raises(ValidationError):
            program(*steps)


@pytest.mark.parametrize("value", [
    "x" * 8001, ["a"] * 201, {str(i): 0 for i in range(21)},
    {"x" * 101: 0}, [[[[[0]]]]], float("nan"), float("inf"), 10**13, 10**400,
    "\ud800", {"\ud800": "invalid"},
    ["é" * 4000] * 3, [[0] * 200] * 6,
])
def test_input_resource_limits_are_explicit(value):
    with pytest.raises(ToolLimitError):
        bounded_data(value)


def test_boundary_values_are_accepted():
    for value in ("x" * 8000, "é" * 7999, ["a"] * 200, 10**12, -10**12, [[[[0]]]]):
        assert bounded_data(value) == value
    with pytest.raises(ToolLimitError, match="16 000"):
        bounded_data("é" * 8000)


@pytest.mark.parametrize("step,value", [
    ({"op": "replace", "old": "a", "new": "z" * 100}, "a" * 8000),
    ({"op": "join", "separator": "-" * 100}, ["a"] * 200),
    ({"op": "split", "separator": ","}, "," * 200),
    ({"op": "upper"}, "ß" * 8000),
    ({"op": "sum"}, [10**12, 1]),
    ({"op": "column", "key": "missing"}, [{"other": 1}]),
    ({"op": "sum"}, [True, 1]), ({"op": "sum"}, ["2", "3"]),
    ({"op": "sort"}, [1, "2"]), ({"op": "join", "separator": ","}, [1, 2]),
    ({"op": "unique"}, [{"a": 1}]), ({"op": "strip"}, ["a"]),
    ({"op": "count"}, {"a": 1}),
])
def test_intermediate_expansion_types_and_missing_sources_fail_closed(step, value):
    with pytest.raises(ToolLimitError):
        execute_program(program(step), value)


def test_tests_are_user_owned_and_do_not_treat_partial_or_wrong_result_as_pass():
    tool = program({"op": "sum"})
    examples = [ToolExample(input=[1, 2], expected=3), ToolExample(input=[1, 2], expected="3"),
                ToolExample(input=[True], expected=1)]
    report = check_examples(tool, examples)
    assert [item["passed"] for item in report] == [True, False, False]
    assert examples[1].expected == "3"
    assert "actual" not in json.dumps(report)

def test_script_looking_data_are_just_literal_text_not_executed(tmp_path):
    target = tmp_path / "must-not-exist"
    value = f"__import__('pathlib').Path({str(target)!r}).write_text('executed')"
    actual, _ = execute_program(program({"op": "strip"}), value)
    assert actual == value
    assert not target.exists()


def test_generated_program_cannot_introduce_invalid_unicode():
    with pytest.raises(ValidationError):
        program({"op": "replace", "old": "x", "new": "\ud800"})


def test_mission_requires_bounded_data_examples_and_meaningful_objective():
    valid = {"objective": "Nettoyer", "data": "data", "examples": [{"input": " x ", "expected": "x"}]}
    assert MicroToolInputs.model_validate(valid).objective == "Nettoyer"
    for change in ({"objective": " "}, {"examples": []}, {"examples": valid["examples"] * 6},
                   {"data": "x" * 8001}, {"code": "private script"}, {"examples": [{"input": "x"}]}):
        with pytest.raises(ValidationError):
            MicroToolInputs.model_validate({**valid, **change})
