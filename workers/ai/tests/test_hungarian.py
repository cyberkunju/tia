"""Hungarian matcher tests — must avoid double-claims and preserve ties."""

from __future__ import annotations

from tia_ai.match.hungarian import assign


def test_identity_assignment():
    cost = [[0.1, 0.9], [0.8, 0.2]]
    a, total = assign(cost)
    assert a == [0, 1]
    assert abs(total - 0.3) < 1e-9


def test_no_double_claim_under_collision():
    """Both rows prefer col 0 — must split them between the two cols."""
    cost = [[0.1, 0.4], [0.15, 0.5]]
    a, _ = assign(cost)
    assert sorted(a) == [0, 1]
    assert a[0] != a[1]


def test_rectangular_one_row():
    a, _ = assign([[0.2, 0.7, 0.5]])
    assert a == [0]


def test_rectangular_more_rows_than_cols():
    a, _ = assign([[0.1], [0.2], [0.3]])
    # only one candidate available; first row claims it, rest dummy-assigned (-1)
    chosen = [c for c in a if c != -1]
    assert chosen == [0]


def test_empty():
    assert assign([]) == ([], 0.0)
    assert assign([[]]) == ([], 0.0)


def test_tied_costs_still_produce_valid_assignment():
    """Genuine ties (the Fatima Khan shape) — assignment must still be valid;
    the *caller* is responsible for flagging ambiguity from the cost matrix itself."""
    a, total = assign([[0.0, 0.0]])
    assert a in ([0], [1])  # either column is a valid pick
    assert total == 0.0
