"""keel platform core: ports, cross-cutting adapters, and the test kit.

This package is Tier 1 of the reuse model (see docs/adr/0009): the shared
library every keel Python service depends on. It implements the ports defined
by the platform contract (platform.yaml); services provide the composition.
"""

__version__ = "0.1.0"
