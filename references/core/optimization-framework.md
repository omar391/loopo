# Optimization Framework (OF)

Use OF to reduce ambiguity and improve deterministic execution.

## Goals

- Keep workflows structured and reproducible.
- Minimize branching ambiguity during execution.
- Add explicit verification after each meaningful change.

## Operating Rules

1. Use numbered procedures for all task-critical flows.
2. Prefer binary decisions (`yes/no`, `pass/fail`) when selecting the next action.
3. Define prerequisites before execution.
4. Define failure conditions and rollback behavior before transitions.
5. Run immediate verification after each fix or reconcile step.
6. Keep outputs concise and actionable.

## Coherency Discipline

- One source of truth for state: the active task ledger.
- One canonical lifecycle for all task types.
- One reconciliation owner: the coordinator handler.
