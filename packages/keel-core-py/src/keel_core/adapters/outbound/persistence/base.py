"""Declarative base for ORM-mapped entities (adapters layer only)."""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Entity(DeclarativeBase):
    """Base class for SQLAlchemy ORM entities.

    Domain models stay free of the ORM (ADR-0002); mappings live in the
    persistence adapter and subclass this base.
    """
