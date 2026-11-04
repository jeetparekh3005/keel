"""SQLAlchemy async persistence: base entity, database, unit of work.

keel-core provides the plumbing (the declarative ``Entity`` base, the
``Database`` engine/session factory, and the ``UnitOfWork`` transaction
boundary). Repositories are service-defined: each service declares a repository
port for its aggregate and implements it with explicit ORM<->domain mapping, so
the ORM never leaks across the hexagonal boundary.
"""

from keel_core.adapters.outbound.persistence.base import Entity
from keel_core.adapters.outbound.persistence.database import Database
from keel_core.adapters.outbound.persistence.unit_of_work import UnitOfWork

__all__ = ["Database", "Entity", "UnitOfWork"]
