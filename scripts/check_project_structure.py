#!/usr/bin/env python3
"""Offline metadata/link checks for the Git-indexed project structure.

This does not validate application behavior, read untracked files, contact cloud
services, enforce releases, or compare protected-file content with a baseline.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


CATALOG = "config/project-structure.v1.json"
PRIVATE_PARTS = {".git", ".tmp", ".langgraph_api", ".aws", ".codex", "node_modules", "outputs", "archivedhandovers"}
ENV_EXAMPLES = {".env.example", ".env.langgraph.example"}
INLINE_LINK = re.compile(r"!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)")
REFERENCE_DEF = re.compile(r"^\s{0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)", re.M)
REFERENCE_USE = re.compile(r"!?\[([^\]\n]+)\]\[([^\]\n]*)\]")
MIGRATION_NAME = re.compile(r"^(\d{14})_[a-z0-9_]+\.sql$")


def private_path(relative: str) -> bool:
    parts = PurePosixPath(relative).parts
    return any(p in PRIVATE_PARTS or (p.startswith(".env") and p not in ENV_EXAMPLES) for p in parts)


def repository_path(value: object, *, prefix: bool = False) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("expected a nonempty repository-relative path using forward slashes")
    path = value.rstrip("/") if prefix else value
    if not path or PurePosixPath(path).is_absolute() or PureWindowsPath(path).drive:
        raise ValueError("absolute paths are not allowed")
    if any(p in {".", ".."} for p in path.split("/")):
        raise ValueError("dot segments are not allowed in catalog paths")
    if private_path(path):
        raise ValueError("private/generated paths cannot be inspected")
    return path


def contained(root: Path, path: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def tracked_files(root: Path) -> list[str]:
    result = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=False)
    if result.returncode:
        raise ValueError("git ls-files failed; run the checker inside a Git worktree")
    return sorted(set(result.stdout.decode("utf-8").rstrip("\0").split("\0")) - {""})


def without_code(source: str) -> str:
    lines, fence = [], None
    for line in source.splitlines():
        match = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if match:
            marker = match.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = None
            lines.append("")
        elif fence is not None or line.startswith("    ") or line.startswith("\t"):
            lines.append("")
        else:
            lines.append(line)
    return "\n".join(lines)


def heading_anchors(source: str) -> set[str]:
    text = without_code(source)
    anchors = set(re.findall(r"\b(?:id|name)\s*=\s*[\"']([^\"']+)[\"']", text, flags=re.I))
    used: Counter[str] = Counter()
    lines = text.splitlines()
    headings = []
    for index, line in enumerate(lines):
        match = re.match(r"^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$", line)
        if match:
            headings.append(match.group(1))
        elif index and re.match(r"^\s{0,3}(?:=+|-+)\s*$", line) and lines[index - 1].strip():
            headings.append(lines[index - 1].strip())
    for heading in headings:
        heading = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", heading)
        heading = re.sub(r"<[^>]+>", "", heading).strip().lower()
        slug = re.sub(r"[^\w\s-]", "", heading)
        slug = re.sub(r"\s", "-", slug)
        number = used[slug]
        used[slug] += 1
        anchors.add(f"{slug}-{number}" if number else slug)
    return anchors


def markdown_links(source: str) -> tuple[list[str], list[str]]:
    text = re.sub(r"`+[^`\n]*`+", "", without_code(source))
    definitions = {" ".join(label.lower().split()): target.strip("<>") for label, target in REFERENCE_DEF.findall(text)}
    links = [match.group(1).strip("<>") for match in INLINE_LINK.finditer(text)]
    links.extend(definitions.values())
    undefined = []
    for visible, label in REFERENCE_USE.findall(text):
        key = " ".join((label or visible).lower().split())
        if key not in definitions:
            undefined.append(label or visible)
    return links, undefined


def audit_project(root: Path, catalog: dict, files: list[str]) -> dict:
    root = root.resolve()
    errors, records, notices = [], [], []
    external_count, anchor_checks, link_checks = 0, 0, 0

    def error(code: str, path: str, message: str) -> None:
        errors.append({"code": code, "path": path, "message": message})

    if catalog.get("schema_version") != 1:
        error("CATALOG_SCHEMA", CATALOG, "schema_version must equal 1")
    rules = []
    category_ids = set()
    categories = catalog.get("categories", [])
    if not isinstance(categories, list) or not categories:
        error("CATALOG_CATEGORIES", CATALOG, "categories must be a nonempty list")
        categories = []
    for category in categories:
        if not isinstance(category, dict) or not isinstance(category.get("id"), str) or not isinstance(category.get("order"), int):
            error("CATALOG_CATEGORY", CATALOG, "each category needs a string id and integer order")
            continue
        if category["id"] in category_ids:
            error("CATALOG_CATEGORY", CATALOG, "category ids must be unique")
        category_ids.add(category["id"])
        prefixes = category.get("prefixes", [])
        if not isinstance(prefixes, list):
            error("CATALOG_PREFIX", CATALOG, "prefixes must be a list")
            continue
        for value in prefixes:
            try:
                prefix = repository_path(value, prefix=True)
                directory = value.endswith("/") or (root / prefix).is_dir()
                rules.append((prefix, directory, category["id"], category["order"]))
            except ValueError as exc:
                error("CATALOG_PREFIX", CATALOG, str(exc))

    safe_files, folded = set(), {}
    for relative in sorted(set(files)):
        try:
            repository_path(relative)
        except ValueError as exc:
            error("UNSAFE_TRACKED_PATH", relative, str(exc))
            continue
        key = relative.casefold()
        if key in folded and folded[key] != relative:
            error("CASE_COLLISION", relative, f"collides with {folded[key]}")
        folded[key] = relative
        target = root / relative
        if not contained(root, target):
            error("PATH_ESCAPE", relative, "resolved tracked path leaves the repository")
            continue
        if target.resolve().relative_to(root).as_posix() != relative:
            error("TRACKED_ALIAS", relative, "symlink or path alias is not inspected")
            continue
        if not target.is_file():
            error("MISSING_TRACKED_FILE", relative, "Git-indexed file is absent")
            continue
        safe_files.add(relative)
        matches = [r for r in rules if relative == r[0] or (r[1] and relative.startswith(r[0] + "/"))]
        chosen = None
        if not matches:
            error("UNCLASSIFIED_FILE", relative, "no category matches this tracked file")
        else:
            specificity = max(len(r[0]) for r in matches)
            best = [r for r in matches if len(r[0]) == specificity]
            if len({r[2] for r in best}) > 1:
                error("AMBIGUOUS_CATEGORY", relative, "equally specific categories disagree")
            chosen = min(best, key=lambda r: (r[3], r[2]))
        records.append({"path": relative, "category": chosen[2] if chosen else None, "order": chosen[3] if chosen else None})

    for field in ("critical_paths", "protected_paths", "external_catalogs"):
        values = catalog.get(field, [])
        if not isinstance(values, list):
            error("CATALOG_PATHS", CATALOG, f"{field} must be a list")
            continue
        for value in values:
            try:
                relative = repository_path(value, prefix=field == "protected_paths")
            except ValueError as exc:
                error("CATALOG_PATH", CATALOG, f"{field}: {exc}")
                continue
            is_present = relative in safe_files or (field == "protected_paths" and any(p.startswith(relative + "/") for p in safe_files))
            if not is_present:
                error("REQUIRED_PATH_MISSING", relative, f"{field} entry is absent from tracked files")
            elif field == "external_catalogs":
                try:
                    json.loads((root / relative).read_text(encoding="utf-8-sig"))
                except (OSError, ValueError):
                    error("INVALID_METADATA_JSON", relative, "metadata catalog is not valid UTF-8 JSON")

    markdown = {}
    for relative in sorted(safe_files):
        if relative.lower().endswith(".md"):
            try:
                markdown[relative] = (root / relative).read_text(encoding="utf-8-sig")
            except (OSError, UnicodeError):
                error("MARKDOWN_UNREADABLE", relative, "tracked Markdown is not readable UTF-8")

    def local_link(source: str, link: str) -> str | None:
        nonlocal external_count, anchor_checks, link_checks
        if re.match(r"^[A-Za-z]:[/\\]", link):
            error("LINK_PATH_INVALID", source, "absolute Windows links are not repository-relative")
            return None
        parsed = urlsplit(link)
        if parsed.scheme or parsed.netloc:
            external_count += 1
            return None
        decoded = unquote(parsed.path)
        if "\\" in decoded or PureWindowsPath(decoded).drive:
            error("LINK_PATH_INVALID", source, "local links must use repository-relative forward-slash paths")
            return None
        target = ((root / source).parent / decoded) if decoded else root / source
        if decoded.startswith("/"):
            error("LINK_PATH_ESCAPE", source, f"absolute local link: {link}")
            return None
        if not contained(root, target):
            error("LINK_PATH_ESCAPE", source, f"link leaves repository: {link}")
            return None
        relative = target.resolve().relative_to(root).as_posix()
        if private_path(relative):
            error("PRIVATE_LINK_TARGET", source, f"link points at private/generated path: {link}")
            return None
        link_checks += 1
        if relative != "." and relative not in safe_files and not any(p.startswith(relative.rstrip("/") + "/") for p in safe_files):
            error("LINK_TARGET_MISSING", source, f"target is not a tracked file/directory: {link}")
            return None
        if parsed.fragment and relative in markdown:
            anchor_checks += 1
            if unquote(parsed.fragment) not in heading_anchors(markdown[relative]):
                error("LINK_ANCHOR_MISSING", source, f"unsupported or missing common Markdown anchor: {link}")
        return relative

    resolved_links = {}
    for relative, source in markdown.items():
        links, undefined = markdown_links(source)
        for label in undefined:
            error("UNDEFINED_REFERENCE_LINK", relative, f"reference has no definition: {label}")
        resolved_links[relative] = {target for link in links if (target := local_link(relative, link))}

    moves = catalog.get("moves", [])
    if not isinstance(moves, list):
        error("CATALOG_MOVES", CATALOG, "moves must be a list")
        moves = []
    for move in moves:
        try:
            old, new = repository_path(move["from"]), repository_path(move["to"])
        except (KeyError, TypeError, ValueError):
            error("CATALOG_MOVE", CATALOG, "move needs safe from/to paths")
            continue
        required_anchors = move.get("required_anchors", [])
        if not isinstance(required_anchors, list) or any(not isinstance(anchor, str) or not anchor for anchor in required_anchors):
            error("CATALOG_MOVE_ANCHORS", old, "required_anchors must be a list of nonempty anchor strings")
            required_anchors = []
        for page in (old, new):
            if page in markdown:
                missing_required = set(required_anchors) - heading_anchors(markdown[page])
                for anchor in sorted(missing_required):
                    error("MOVE_REQUIRED_ANCHOR_MISSING", page, f"required migration anchor is absent: {anchor}")
        if old not in markdown or new not in markdown:
            error("MOVE_TARGET_MISSING", old, "forwarding page and moved Markdown must both be tracked")
        elif new not in resolved_links.get(old, set()):
            error("FORWARD_LINK_MISSING", old, f"forwarding page must link to {new}")
        else:
            missing = heading_anchors(markdown[old]) - heading_anchors(markdown[new])
            if missing:
                notices.append({"code": "FORWARD_EXTRA_ANCHORS", "path": old, "anchors": sorted(missing)})

    versions = {}
    for relative in sorted(safe_files):
        if not relative.startswith("supabase/migrations/"):
            continue
        match = MIGRATION_NAME.fullmatch(PurePosixPath(relative).name)
        if not match:
            error("MIGRATION_NAME", relative, "expected 14-digit version_name.sql")
        else:
            version = match.group(1)
            try:
                datetime.strptime(version, "%Y%m%d%H%M%S")
            except ValueError:
                error("MIGRATION_TIMESTAMP", relative, "migration version is not a valid calendar timestamp")
            if version in versions:
                error("MIGRATION_VERSION_DUPLICATE", relative, f"duplicates {versions[version]}")
            else:
                versions[version] = relative

    records.sort(key=lambda r: (r["order"] if r["order"] is not None else 10**9, r["path"]))
    return {
        "ok": not errors,
        "scope": "offline Git-indexed files and local links; no cloud or runtime acceptance",
        "tracked_file_count": len(set(files)),
        "category_counts": dict(sorted(Counter(r["category"] for r in records if r["category"]).items())),
        "local_links_checked": link_checks,
        "common_markdown_anchors_checked": anchor_checks,
        "external_links_not_fetched": external_count,
        "migration_versions": sorted(versions),
        "protected_paths_check": "existence only; content baseline is separate",
        "errors": errors,
        "notices": notices,
        "files_in_order": records,
    }


def output_path(root: Path, value: str) -> Path:
    destination = Path(value)
    if not destination.is_absolute():
        destination = root / destination
    allowed = root.resolve() / "outputs"
    if not destination.resolve().is_relative_to(allowed) or not contained(root, allowed):
        raise ValueError("--output must resolve inside this repository's outputs/ directory")
    if destination.suffix.lower() != ".json":
        raise ValueError("--output must be a JSON filename")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", help="optional JSON file beneath the repository's outputs/ directory")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        files = tracked_files(root)
        if CATALOG not in files:
            raise ValueError("catalog must be Git-indexed (stage new metadata before checking)")
        catalog_path = root / CATALOG
        if not contained(root, catalog_path):
            raise ValueError("catalog resolves outside the repository")
        if catalog_path.resolve().relative_to(root).as_posix() != CATALOG:
            raise ValueError("catalog symlink or path alias is not inspected")
        catalog = json.loads(catalog_path.read_text(encoding="utf-8-sig"))
        if not isinstance(catalog, dict):
            raise ValueError("catalog must be a JSON object")
        report = audit_project(root, catalog, files)
        encoded = json.dumps(report, indent=2, ensure_ascii=True) + "\n"
        if args.output:
            destination = output_path(root, args.output)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(encoded, encoding="utf-8")
        sys.stdout.write(encoded)
        return 0 if report["ok"] else 1
    except (OSError, ValueError, UnicodeError) as exc:
        sys.stdout.write(json.dumps({"ok": False, "errors": [{"code": "CHECKER_INPUT", "message": str(exc)}]}) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
