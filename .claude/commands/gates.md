---
description: Run the full local gate suite and report pass/fail per gate
---
Run every gate from the repo root, in order, and report a one-line pass/fail for each.
Fix anything that fails, then re-run until all green. Do not push.

```
uv sync --frozen --all-packages
uv run ruff check .
uv run ruff format --check .
uv run mypy -p keel_core -p reference_service
uv run lint-imports
uv run codespell packages
for p in packages/*/ services/*/; do uv run --directory "$p" deptry src; done
uv run pytest --cov=keel_core --cov=reference_service
```

These are the same gates CI runs. If `ruff format --check` fails, run `uv run ruff format .`.
