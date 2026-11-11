"""Composition root: wire adapters to ports and build the FastAPI app."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import FastAPI

from keel_core.adapters.inbound.http import create_app
from keel_core.adapters.outbound.persistence import Database
from reference_service.adapters.inbound.http import router as items_router
from reference_service.adapters.outbound.persistence import SqlItemRepository
from reference_service.application.item_service import ItemService
from reference_service.config import ServiceConfig

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from keel_core.ports.auth import Authenticator
    from keel_core.ports.logging import Logger


def _make_database(config: ServiceConfig) -> Database:
    # Pool tuning applies to server databases; sqlite uses its own pooling.
    engine_kwargs: dict[str, object] = {"pool_pre_ping": True}
    if not config.database_url.startswith("sqlite"):
        engine_kwargs.update(
            pool_size=config.db_pool_size,
            max_overflow=config.db_max_overflow,
            pool_timeout=config.db_pool_timeout,
            pool_recycle=config.db_pool_recycle,
            # Bound the driver: cap statement execution and connection setup so a
            # stalled query cannot hold a pooled connection indefinitely (asyncpg).
            connect_args={
                "command_timeout": config.db_command_timeout,
                "timeout": config.db_connect_timeout,
            },
        )
    return Database(config.database_url, **engine_kwargs)


def build_app(
    config: ServiceConfig,
    *,
    authenticator: Authenticator,
    database: Database | None = None,
    logger: Logger | None = None,
) -> FastAPI:
    """Build the reference service app, wiring auth, persistence, and the items router."""
    db = database if database is not None else _make_database(config)

    async def _db_ready() -> bool:
        return await db.ping(timeout=config.db_readiness_timeout)

    app = create_app(
        service=config.service_name,
        version=config.version,
        authenticator=authenticator,
        logger=logger,
        readiness_checks=[_db_ready],
        # Only expose the OpenAPI schema + docs UIs outside production.
        expose_docs=config.environment.lower() in {"dev", "local", "test"},
        cors_allow_origins=config.cors_allow_origins,
        trusted_hosts=config.trusted_hosts,
    )
    app.state.database = db

    # Composition root owns the driving->driven binding: the HTTP router resolves the
    # use case through this factory and never imports the concrete repository itself.
    def _item_service(session: AsyncSession) -> ItemService:
        return ItemService(SqlItemRepository(session))

    app.state.item_service_factory = _item_service
    # Each item route declares its own require_scopes(...) dependency (authn + authz).
    app.include_router(items_router)
    return app
