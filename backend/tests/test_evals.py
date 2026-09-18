"""Run the behavioural evaluation suite as part of the test suite.

The scenarios are the contract for how the system behaves when things go wrong.
Wiring them into pytest means a regression fails CI rather than waiting for
someone to run `python -m evals.run` by hand.
"""

from __future__ import annotations

import pytest

from evals.scenarios import SCENARIOS, run_all


@pytest.fixture(scope="module")
def results(tmp_path_factory):
    return run_all(tmp_path_factory.mktemp("evals"))


def test_every_scenario_passes(results):
    failed = [f"{r.name}: {r.detail}" for r in results if not r.passed]
    assert not failed, "behavioural scenarios failed:\n  " + "\n  ".join(failed)


def test_all_scenarios_ran(results):
    assert len(results) == len(SCENARIOS)


def test_coverage_includes_the_critical_categories(results):
    """Guards against the suite quietly losing a whole class of scenario."""
    categories = {r.category for r in results}
    required = {
        "anti-fabrication",
        "failure path",
        "injection",
        "input validation",
        "no false success",
        "provenance",
        "abstention",
        "honesty",
    }
    assert required <= categories, f"missing: {required - categories}"
