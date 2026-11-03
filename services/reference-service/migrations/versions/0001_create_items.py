"""create items table

Revision ID: 0001
Revises:
Create Date: 2026-11-03

"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "items",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("items")
