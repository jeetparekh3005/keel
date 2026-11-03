"""Composition root: wire adapters to ports and build the FastAPI app."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Depends, FastAPI

from keel_core.adapters.inbound.http import create_app
from keel_core.adapters.outbound.persistence import Database
from reference_service.adapters.inbound.http import router as items_router
from reference_service.config import ReferenceConfig

if TYPE_CHECKING:
    from keel_core.ports.auth import Authenticator


def build_app(
    config: ReferenceConfig,
    *,
    authenticator: Authenticator,
    database: Database | None = None,
) -> FastAPI:
    """Build the reference service app, wiring auth, persistence, and the items router."""
    db = database if database is not None else Database(config.database_url)
    app = create_app(
        service=config.service_name,
        version=config.version,
        authenticator=authenticator,
        readiness_checks=[db.ping],
    )
    app.state.database = db
    app.include_router(items_router, dependencies=[Depends(app.state.require_principal)])
    return app
