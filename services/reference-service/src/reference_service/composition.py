"""Composition root: wire adapters to ports and build the FastAPI app."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import FastAPI

from keel_core.adapters.inbound.http import create_app
from keel_core.adapters.outbound.persistence import Database
from reference_service.adapters.inbound.http import router as items_router
from reference_service.config import ReferenceConfig

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator
    from keel_core.ports.logging import Logger


def _make_database(config: ReferenceConfig) -> Database:
    # Pool tuning applies to server databases; sqlite uses its own pooling.
    engine_kwargs: dict[str, object] = {"pool_pre_ping": True}
    if not config.database_url.startswith("sqlite"):
        engine_kwargs.update(
            pool_size=config.db_pool_size,
            max_overflow=config.db_max_overflow,
            pool_timeout=config.db_pool_timeout,
            pool_recycle=config.db_pool_recycle,
        )
    return Database(config.database_url, **engine_kwargs)


def build_app(
    config: ReferenceConfig,
    *,
    authenticator: Authenticator,
    database: Database | None = None,
    logger: Logger | None = None,
) -> FastAPI:
    """Build the reference service app, wiring auth, persistence, and the items router."""
    db = database if database is not None else _make_database(config)
    app = create_app(
        service=config.service_name,
        version=config.version,
        authenticator=authenticator,
        logger=logger,
        readiness_checks=[db.ping],
    )
    app.state.database = db
    # Each item route declares its own require_scopes(...) dependency (authn + authz).
    app.include_router(items_router)
    return app
