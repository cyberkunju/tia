---
name: tia-month-close
description: Run TIA's month-close end-to-end — find revenue leakage across the period's payroll, recover each unbilled associate, then verify the audit chain and summarise the impact.
tools:
  - find_revenue_leakage
  - recover_leakage
  - metrics_stp
  - verify_audit_chain
  - list_clients
  - get_employee_history
---

# TIA month-close

TIA (Touchless Invoice Agent) is TASC Outsourcing's billing operator for UAE
manpower-supply. "Month-close" means: every associate TASC paid this period
must also be **billed back** to the right client, with full provenance on the
tamper-evident audit chain.

This skill walks the close end-to-end. Use it when the user asks any of:

- "Run the month-close."
- "Recover all revenue leakage for `<period>`."
- "Did we bill everyone we paid this month?"
- "Close the books for June 2026."

## Workflow

Run the steps in order. After each tool call, briefly note the result in your
working memory so the final summary can quote real numbers.

### 1. Scan for leakage

Call `find_revenue_leakage(period=<the period the user named, or "June 2026" if unspecified>)`.

The response gives you:

- `total_aed` — the period's total silent loss
- `associate_count` — how many associates are affected
- `entries` — the top 10 unbilled associates with `{emp_id, name, client_code, reason, expected_billable_aed}`
- `by_client` — per-client aggregates
- `is_anomalous_period` — true if this period is >2σ above the trailing baseline

If `total_aed == 0`, tell the user the period is fully billed and STOP. No
recovery needed.

### 2. Recover each unbilled associate

For each row in `entries`, call:

```
recover_leakage(emp_id=<entry.emp_id>, period=<period>, reason=<entry.reason>)
```

Use the `reason` value the scan returned — do not invent a reason. Each call
issues a catch-up invoice with a `-R\d+` sequence suffix and chains an
`invoice.recovery_issued` + `agent.recover_leakage_invoked` audit event.

If a call returns `{"ok": false, ...}`, note the reason in your working memory
but keep going — one failure shouldn't block the rest.

### 3. Check the touchless rate

Call `metrics_stp()` to get the post-recovery touchless rate. Quote the rate as
a percentage in the final summary.

### 4. Verify the audit chain

Call `verify_audit_chain()`. If `ok == false`, surface the error count and the
first error verbatim — that's a tamper indicator and the user needs to know
immediately. If `ok == true`, quote the `head_hash` (first 12 chars) so the
user has a verifiable cryptographic checkpoint.

### 5. Summarise

Write a plain-prose summary covering:

- What you scanned and what you found (`total_aed`, `associate_count`, top
  reason)
- What you recovered (count of successful `recover_leakage` calls, total AED
  recovered)
- Anything that couldn't be recovered, with the reason
- The post-recovery `metrics_stp().rate`
- The audit chain head hash and `ok` status

Reply in plain prose — no markdown headers, no bullet lists. Cite IDs and
amounts verbatim from the tool results.

## Optional probes

If the user asks "why" a specific row is unbilled, use `get_employee_history`
to fetch the associate's billed periods and explain whether it's a one-off
miss or a chronic pattern.

If the user wants a per-client breakdown beyond the top 10, use
`find_revenue_leakage(period=..., client_code=<CL...>)` to drill in.
