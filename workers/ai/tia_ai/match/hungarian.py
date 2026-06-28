"""Hungarian assignment over a row×candidate cost matrix (pure scipy, no LLM).

Generic invoice tools do a per-row fuzzy *lookup*. We do a global bipartite *assignment*
so that, when a client submits several similar/duplicate names, two timesheet rows can't
both claim the same employee - and a genuinely tied match surfaces as ambiguous (HITL).
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import linear_sum_assignment


def assign(cost_matrix: list[list[float]]) -> tuple[list[int], float]:
    """Return (col_for_each_row, total_cost). Pads to square with high cost so a row
    with fewer candidates than rows still gets a defined (possibly dummy) assignment."""
    if not cost_matrix or not cost_matrix[0]:
        return [], 0.0
    m = np.array(cost_matrix, dtype=float)
    n_rows, n_cols = m.shape
    size = max(n_rows, n_cols)
    pad_val = float(m.max()) + 1.0 if m.size else 1.0
    sq = np.full((size, size), pad_val, dtype=float)
    sq[:n_rows, :n_cols] = m
    row_idx, col_idx = linear_sum_assignment(sq)
    assignment = [-1] * n_rows
    total = 0.0
    for r, c in zip(row_idx, col_idx, strict=True):
        if r < n_rows and c < n_cols:
            assignment[r] = int(c)
            total += float(m[r, c])
    return assignment, round(total, 6)


def _demo() -> None:
    # 2 rows, 2 candidates; clear best assignment is identity
    cost = [[0.1, 0.9], [0.8, 0.2]]
    a, total = assign(cost)
    assert a == [0, 1], a
    assert abs(total - 0.3) < 1e-9, total
    # collision avoidance: both rows prefer col 0, assignment must split them
    cost2 = [[0.1, 0.4], [0.15, 0.5]]
    a2, _ = assign(cost2)
    assert sorted(a2) == [0, 1], a2  # no double-claim of col 0
    # non-square: 1 row, 2 candidates
    a3, _ = assign([[0.2, 0.7]])
    assert a3 == [0], a3
    print("hungarian: all assertions passed")


if __name__ == "__main__":
    _demo()
