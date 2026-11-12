"""Static ``platform.yaml`` conformance checks for a generated keel service.

These verify that a *thin* service is wired to the platform (depends on ``keel-core``, builds its
app with keel-core's factory, extends keel-core's typed config, guards its routes) rather than
re-checking behaviour that keel-core already owns and tests. The health endpoints, RFC 9457 error
shape, redacting logs, and edge hardening are mounted by keel-core's ``create_app`` and verified by
keel-core's own suite; a thin service's job is to *use* them, which is exactly what this gate
confirms.

This is a fast, dependency-free check to run right after ``keel new`` / ``keel update`` and in CI.
It is deliberately not a replacement for the service's behavioural conformance suite
(``tests/test_conformance.py``) or the runtime deny-by-default startup check.
"""

from __future__ import annotations

import io
import json
import re
import tokenize
import tomllib
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

import yaml

# apiVersions whose contract shape this CLI knows how to check. Extend when the schema changes.
KNOWN_API_VERSIONS = frozenset({"keel.dev/v1alpha1"})


@dataclass(frozen=True)
class CheckResult:
    """The outcome of one static conformance check.

    An ``advisory`` check is reported but does not fail conformance: a hand-written or
    source service (such as the reference service, which is the template's origin) can be
    fully platform-conformant yet not be a Copier-tracked instance.
    """

    check_id: str
    ok: bool
    detail: str
    advisory: bool = False


@dataclass(frozen=True)
class ConformanceReport:
    """The results of checking one service directory against the contract."""

    service_dir: Path
    results: tuple[CheckResult, ...]

    @property
    def ok(self) -> bool:
        """True when every non-advisory check passed."""
        return all(result.ok for result in self.results if not result.advisory)


@dataclass(frozen=True)
class LanguageSpec:
    """Per-language markers for the wiring checks (static text/manifest signals)."""

    name: str
    manifest: str  # build manifest filename (its presence also detects the language)
    dep_module: str  # the keel-core library module name expected as a declared dependency
    source_suffix: str  # source file extension to scan
    comment_style: (
        str  # "c" (// + /* */) or "python" (# + triple-quoted) - stripped before matching
    )
    app_factory: tuple[str, ...]  # any present => the keel-core app factory is used
    app_factory_detail: str
    typed_config: tuple[str, ...]
    typed_config_detail: str
    authz: tuple[str, ...]
    authz_detail: str


# Detection is by build manifest; order matters only in that each maps to exactly one language.
LANGUAGES: tuple[LanguageSpec, ...] = (
    LanguageSpec(
        name="python",
        manifest="pyproject.toml",
        dep_module="keel-core",
        source_suffix=".py",
        comment_style="python",
        app_factory=("from keel_core.adapters.inbound.http import create_app",),
        app_factory_detail="keel_core create_app (health + RFC 9457 + edge hardening)",
        typed_config=("BaseServiceConfig",),
        typed_config_detail="config extends BaseServiceConfig (KEEL_ env prefix, fail-fast)",
        authz=("require_scopes", "require_roles"),
        authz_detail="routes guarded by require_scopes/require_roles",
    ),
    LanguageSpec(
        name="go",
        manifest="go.mod",
        dep_module="keel-core-go",
        source_suffix=".go",
        comment_style="c",
        app_factory=("keel-core-go/httpx", "httpx.NewRouter("),
        app_factory_detail="keel-core-go httpx.NewRouter (health + RFC 9457 + edge hardening)",
        typed_config=("keel-core-go/config", "config.Load"),
        typed_config_detail="typed config via keel-core-go/config (KEEL_ env prefix, fail-fast)",
        authz=("RequireScopes", "auth.Middleware"),
        authz_detail="routes guarded by auth.RequireScopes/auth.Middleware",
    ),
    LanguageSpec(
        name="rust",
        manifest="Cargo.toml",
        dep_module="keel-core-rust",
        source_suffix=".rs",
        comment_style="c",
        app_factory=("create_app_with_readiness",),
        app_factory_detail="keel_core create_app_with_readiness (health + RFC 9457 + hardening)",
        typed_config=("keel_core::config::load",),
        typed_config_detail="typed config via keel_core config::load (KEEL_ env prefix, fail-fast)",
        authz=("require_scopes", "webauth::Authed"),
        authz_detail="routes guarded by Authed::require_scopes",
    ),
    LanguageSpec(
        name="java",
        manifest="pom.xml",
        dep_module="keel-core",
        source_suffix=".java",
        comment_style="c",
        app_factory=("io.keel.core.web", "io.keel.core.config"),
        app_factory_detail="imports keel-core (Spring auto-config: health + RFC 9457 + hardening)",
        typed_config=("io.keel.core.config", "KeelProperties"),
        typed_config_detail="typed config via keel-core KeelProperties (KEEL_ env, fail-fast)",
        authz=("@PreAuthorize",),
        authz_detail="routes guarded by @PreAuthorize scopes",
    ),
    LanguageSpec(
        name="ts",
        manifest="package.json",
        dep_module="@keel/core",
        source_suffix=".ts",
        comment_style="c",
        app_factory=("KeelCoreModule",),
        app_factory_detail="NestJS KeelCoreModule (health + RFC 9457 + edge hardening)",
        typed_config=("loadConfig", "loadServiceConfig"),
        typed_config_detail="typed config via @keel/core loadConfig (KEEL_ env, fail-fast, zod)",
        authz=("@Scopes",),
        authz_detail="routes guarded by @Scopes",
    ),
)


def _detect(service_dir: Path) -> LanguageSpec | None:
    return next((spec for spec in LANGUAGES if (service_dir / spec.manifest).is_file()), None)


_C_BLOCK = re.compile(r"/\*.*?\*/", re.DOTALL)
_C_LINE = re.compile(r"//[^\n]*")
_PY_LINE = re.compile(r"#[^\n]*")
_PY_TRIPLE = re.compile(r"('{3}|\"{3}).*?\1", re.DOTALL)


# Token types whose text must be dropped before a marker check: comments and every string/
# docstring token (an f-string's literal segments included). A real wiring marker is an import
# or a call - NAME/OP code tokens - never a string literal, so dropping all strings can never
# remove a genuine marker, while it reliably removes one that appears only in a comment/docstring.
_PY_DROP_TOKENS = {tokenize.COMMENT, tokenize.STRING}
for _fstr_name in ("FSTRING_START", "FSTRING_MIDDLE", "FSTRING_END"):
    _fstr_type = getattr(tokenize, _fstr_name, None)
    if _fstr_type is not None:
        _PY_DROP_TOKENS.add(_fstr_type)


def _strip_python(text: str) -> str:
    """Blank comment/string tokens via the tokenizer, leaving all other characters verbatim.

    Each dropped token's character span is overwritten with spaces (newlines preserved), rather
    than joining kept tokens, which would split ``require_scopes(`` into ``require_scopes (`` and
    break the substring marker check; multi-token markers (a dotted import path) stay intact. Falls
    back to the regex heuristic if the source will not tokenize (e.g. a truncated concatenation).
    """
    try:
        # Row/col from tokenize are relative to lines split on "\n" ONLY (StringIO.readline). Build
        # line_starts the same way - NOT via str.splitlines(), which also breaks on \r, \v, \f,
        # U+2028 etc.; those would desync the offsets and blank the wrong characters (leaving a
        # secret-bearing string un-masked, a false pass, or clobbering real code, a false fail).
        line_starts = [0]
        idx = text.find("\n")
        while idx != -1:
            line_starts.append(idx + 1)
            idx = text.find("\n", idx + 1)

        def _offset(pos: tuple[int, int]) -> int:
            row, col = pos  # row is 1-based
            return line_starts[row - 1] + col

        chars = list(text)
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type not in _PY_DROP_TOKENS:
                continue
            for i in range(_offset(tok.start), _offset(tok.end)):
                if chars[i] != "\n":
                    chars[i] = " "
        return "".join(chars)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        text = _PY_LINE.sub("", text)
        return _PY_TRIPLE.sub(" ", text)


def _strip_comments(text: str, style: str) -> str:
    """Remove comments/strings so a marker only in a comment or string cannot satisfy a check.

    Python is handled by the real tokenizer (exact): comment and string tokens are blanked, which
    a regex cannot do correctly - a ``#`` on a docstring's closing line, or a ``'''`` inside a line
    comment, defeats either ordering of the two DOTALL regexes (one way false-passes, the other
    false-fails). C-family sources use the regex (line comments first, then block): a stray ``/*``
    inside a line comment cannot then span and delete real code; a ``//`` inside a string literal
    sharing a marker's line is the residual heuristic limit, acceptable as markers recur.
    """
    if style == "python":
        return _strip_python(text)
    text = _C_LINE.sub("", text)
    return _C_BLOCK.sub(" ", text)


def _read_source(service_dir: Path, spec: LanguageSpec) -> str:
    """Concatenate the service's source (``src/`` first if present), with comments stripped."""
    src = service_dir / "src"
    base = src if src.is_dir() else service_dir
    raw = "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(base.rglob(f"*{spec.source_suffix}"))
    )
    return _strip_comments(raw, spec.comment_style)


def _dep_base(spec: str) -> str:
    """A requirement string -> its bare name ('keel-core>=0.1' -> 'keel-core')."""
    return re.split(r"[<>=!~;\[ ]", spec, maxsplit=1)[0].strip()


def _declares_dependency(manifest: Path, module: str) -> bool:
    """Parse the manifest to confirm ``module`` is a declared dependency, not a mere text match."""
    text = manifest.read_text(encoding="utf-8")
    name = manifest.name
    try:
        if name == "pyproject.toml":
            data = tomllib.loads(text)
            project = data.get("project")
            project = project if isinstance(project, dict) else {}
            # PEP 621 core + optional-dependency groups (each group is a list of requirements).
            # Type-guard every shape: a parseable-but-malformed pyproject (a scalar where a list
            # or table is expected) must yield a verdict, not crash the whole check.
            reqs: list[str] = []
            core = project.get("dependencies")
            if isinstance(core, list):
                reqs.extend(dep for dep in core if isinstance(dep, str))
            optional = project.get("optional-dependencies")
            if isinstance(optional, dict):
                for group in optional.values():
                    if isinstance(group, list):
                        reqs.extend(dep for dep in group if isinstance(dep, str))
            if any(_dep_base(dep) == module for dep in reqs):
                return True
            # Poetry fallback: [tool.poetry.dependencies] is a table keyed by the package name.
            tool = data.get("tool")
            poetry = tool.get("poetry") if isinstance(tool, dict) else None
            poetry = poetry if isinstance(poetry, dict) else {}
            for poetry_table in ("dependencies", "dev-dependencies"):
                table = poetry.get(poetry_table)
                if isinstance(table, dict) and module in table:
                    return True
            return False
        if name == "Cargo.toml":
            data = tomllib.loads(text)
            tables = ("dependencies", "dev-dependencies", "build-dependencies")
            return any(module in data.get(table, {}) for table in tables)
        if name == "package.json":
            data = json.loads(text)
            tables = ("dependencies", "devDependencies", "peerDependencies")
            return any(module in data.get(table, {}) for table in tables)
        if name == "go.mod":
            # A require directive line names the module; ignore `//` comments.
            return any(module in line.split("//", 1)[0] for line in text.splitlines())
        if name == "pom.xml":
            root = ElementTree.fromstring(text)  # noqa: S314 - local build file, not untrusted input
            return any(
                (el.tag.endswith("artifactId")) and (el.text or "").strip() == module
                for el in root.iter()
            )
    except (
        tomllib.TOMLDecodeError,
        json.JSONDecodeError,
        ElementTree.ParseError,
        TypeError,
        AttributeError,
    ):
        # Not parseable, or parseable-but-structurally-malformed (a scalar where a table/list was
        # expected, e.g. `dependencies = 5`): it declares no dependency, so fail closed to False.
        return False
    return module in text


def _check_contract(contract_path: Path) -> CheckResult:
    try:
        contract = yaml.safe_load(contract_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        return CheckResult("contract", ok=False, detail=f"cannot read {contract_path}: {exc}")
    api_version = contract.get("apiVersion") if isinstance(contract, dict) else None
    ok = api_version in KNOWN_API_VERSIONS
    detail = f"{contract_path} apiVersion={api_version!r}"
    if not ok:
        detail += f"; expected one of {sorted(KNOWN_API_VERSIONS)}"
    return CheckResult("contract", ok=ok, detail=detail)


def _marker_check(check_id: str, source: str, markers: tuple[str, ...], detail: str) -> CheckResult:
    present = any(marker in source for marker in markers)
    return CheckResult(check_id, ok=present, detail=detail if present else f"missing: {detail}")


def check_service(service_dir: Path, contract_path: Path) -> ConformanceReport:
    """Run every static conformance check against ``service_dir`` and return the report."""
    service_dir = service_dir.resolve()
    tracked = (service_dir / ".copier-answers.yml").is_file()

    results: list[CheckResult] = [
        # The contract resolves and is a version this CLI understands.
        _check_contract(contract_path),
        # Generated by (and therefore updatable from) a keel template. Advisory: a conformant
        # service need not be Copier-tracked, it just cannot `keel update`.
        CheckResult(
            "template-tracked",
            ok=tracked,
            detail=(
                ".copier-answers.yml present (keel update-able)"
                if tracked
                else "no .copier-answers.yml; not Copier-tracked, `keel update` unavailable"
            ),
            advisory=True,
        ),
    ]

    spec = _detect(service_dir)
    if spec is None:
        manifests = ", ".join(language.manifest for language in LANGUAGES)
        results.append(
            CheckResult("language", ok=False, detail=f"no known build manifest ({manifests})")
        )
        return ConformanceReport(service_dir=service_dir, results=tuple(results))

    declares = _declares_dependency(service_dir / spec.manifest, spec.dep_module)
    source = _read_source(service_dir, spec)
    results += [
        # Depends on keel-core: the Tier-1 library every platform guarantee rides on. Parsed from
        # the manifest's dependency tables, so a mere text/comment occurrence does not count.
        CheckResult(
            "keel-core-dependency",
            ok=declares,
            detail=(
                f"{spec.dep_module} declared in {spec.manifest}"
                if declares
                else f"{spec.dep_module} not a declared dependency in {spec.manifest}"
            ),
        ),
        # Builds its app with keel-core's factory (health + RFC 9457 + edge hardening).
        _marker_check("app-factory", source, spec.app_factory, spec.app_factory_detail),
        # Typed config from keel-core (KEEL_ env prefix, fail-fast, reject-unknown).
        _marker_check("typed-config", source, spec.typed_config, spec.typed_config_detail),
        # Deny-by-default authz on the routes.
        _marker_check("deny-by-default-authz", source, spec.authz, spec.authz_detail),
    ]
    return ConformanceReport(service_dir=service_dir, results=tuple(results))
