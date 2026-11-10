"""Synthetic tests; no production files, credentials, network or models."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "check_project_structure.py"
SPEC = importlib.util.spec_from_file_location("project_structure", MODULE_PATH)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class ProjectStructureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.files = []
        self.catalog = {
            "schema_version": 1,
            "categories": [
                {"id": "start", "order": 1, "prefixes": ["README.md"]},
                {"id": "docs", "order": 2, "prefixes": ["docs/"]},
                {"id": "database", "order": 3, "prefixes": ["supabase/"]},
                {"id": "config", "order": 4, "prefixes": ["config/"]},
            ],
            "critical_paths": ["README.md"],
            "protected_paths": [],
            "moves": [],
        }
        self.write("README.md", "# Start\n")

    def write(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        if relative not in self.files:
            self.files.append(relative)

    def audit(self):
        return checker.audit_project(self.root, self.catalog, self.files)

    def codes(self):
        return {item["code"] for item in self.audit()["errors"]}

    def test_valid_inline_reference_anchor_and_skipped_code(self):
        self.write("README.md", "# Start\n[Guide](docs/guide.md#next-step)\n[Details][g]\n[g]: docs/guide.md\n[Web](https://example.invalid)\n```md\n[Fake](missing.md)\n```\n")
        self.write("docs/guide.md", "# Guide\n## Next step\n")
        result = self.audit()
        self.assertTrue(result["ok"], result["errors"])
        self.assertEqual(result["external_links_not_fetched"], 1)
        self.assertEqual(result["common_markdown_anchors_checked"], 1)

    def test_missing_target_anchor_and_reference_are_reported(self):
        self.write("README.md", "# Start\n[Missing](docs/missing.md)\n[Anchor](docs/guide.md#absent)\n[Undefined][no-definition]\n")
        self.write("docs/guide.md", "# Guide\n")
        self.assertTrue({"LINK_TARGET_MISSING", "LINK_ANCHOR_MISSING", "UNDEFINED_REFERENCE_LINK"}.issubset(self.codes()))

    def test_untracked_target_is_not_read_or_accepted(self):
        self.write("README.md", "# Start\n[Private](untracked.md)\n")
        (self.root / "untracked.md").write_bytes(b"\xffnot-utf8")
        self.assertIn("LINK_TARGET_MISSING", self.codes())
        self.assertNotIn("MARKDOWN_UNREADABLE", self.codes())

    def test_link_escape_and_private_tracked_file_are_rejected(self):
        self.write("README.md", "# Start\n[Escape](../outside.md)\n")
        self.files.append(".env")
        self.assertIn("LINK_PATH_ESCAPE", self.codes())
        self.assertIn("UNSAFE_TRACKED_PATH", self.codes())

    def test_case_collisions_are_reported_on_all_platforms(self):
        self.write("docs/Guide.md", "# Guide\n")
        self.files.append("docs/guide.md")
        self.assertIn("CASE_COLLISION", self.codes())

    def test_longest_category_wins_but_equal_specificity_conflicts(self):
        self.write("docs/originals/legacy.md", "# Legacy\n")
        self.catalog["categories"].append({"id": "provenance", "order": 8, "prefixes": ["docs/originals/"]})
        result = self.audit()
        self.assertTrue(result["ok"], result["errors"])
        self.assertEqual(next(x for x in result["files_in_order"] if x["path"].endswith("legacy.md"))["category"], "provenance")
        self.catalog["categories"].append({"id": "conflict", "order": 9, "prefixes": ["docs/originals/"]})
        self.assertIn("AMBIGUOUS_CATEGORY", self.codes())

    def test_moved_guide_requires_forward_link(self):
        self.write("docs/old.md", "# Old\n")
        self.write("docs/guides/new.md", "# Old\n")
        self.catalog["moves"] = [{"from": "docs/old.md", "to": "docs/guides/new.md"}]
        self.assertIn("FORWARD_LINK_MISSING", self.codes())
        self.write("docs/old.md", "# Old\n[Continue](guides/new.md)\n")
        self.assertTrue(self.audit()["ok"])

    def test_required_paths_json_and_migration_versions(self):
        self.catalog["protected_paths"] = ["supabase/migrations/"]
        self.catalog["external_catalogs"] = ["config/metadata.json"]
        self.write("config/metadata.json", json.dumps({"observed": "metadata only"}))
        self.write("supabase/migrations/20261110000100_first.sql", "-- synthetic\n")
        self.assertTrue(self.audit()["ok"], self.audit()["errors"])
        self.write("supabase/migrations/20261110000100_duplicate.sql", "-- synthetic\n")
        self.assertIn("MIGRATION_VERSION_DUPLICATE", self.codes())
        self.write("config/metadata.json", "{broken")
        self.assertIn("INVALID_METADATA_JSON", self.codes())

    def test_required_move_anchors_survive_on_both_pages_without_inbound_links(self):
        self.catalog["moves"] = [{"from": "docs/old.md", "to": "docs/guides/new.md", "required_anchors": ["old", "usage"]}]
        self.write("docs/old.md", "# Old\n## Usage\n[Continue](guides/new.md)\n")
        self.write("docs/guides/new.md", "# Old\n## Usage\n")
        self.assertTrue(self.audit()["ok"], self.audit()["errors"])
        for page in ("docs/old.md", "docs/guides/new.md"):
            with self.subTest(page=page):
                original = (self.root / page).read_text(encoding="utf-8")
                self.write(page, original.replace("## Usage\n", ""))
                failures = [item for item in self.audit()["errors"] if item["code"] == "MOVE_REQUIRED_ANCHOR_MISSING"]
                self.assertEqual([item["path"] for item in failures], [page])
                self.assertIn("usage", failures[0]["message"])
                self.write(page, original)

    def test_required_move_anchor_schema_rejects_non_lists_and_invalid_items(self):
        self.write("docs/old.md", "# Old\n[Continue](guides/new.md)\n")
        self.write("docs/guides/new.md", "# Old\n")
        for invalid in ("old", [None], [""], {}):
            with self.subTest(value=invalid):
                self.catalog["moves"] = [{"from": "docs/old.md", "to": "docs/guides/new.md", "required_anchors": invalid}]
                self.assertIn("CATALOG_MOVE_ANCHORS", self.codes())

    def test_catalog_path_escape_and_missing_critical_file(self):
        self.catalog["critical_paths"] += ["../outside.md", "src/server.js"]
        self.assertTrue({"CATALOG_PATH", "REQUIRED_PATH_MISSING"}.issubset(self.codes()))

    def test_output_must_stay_under_outputs(self):
        self.assertEqual(checker.output_path(self.root, "outputs/report.json"), self.root / "outputs/report.json")
        for path in ["README.md", "outputs/../../outside.json", str(self.root.parent / "outside.json"), "outputs/report.md"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                checker.output_path(self.root, path)

    def test_output_refuses_resolved_symlink_escape(self):
        # Model path resolution directly so this safety test also runs on Windows
        # accounts that cannot create real symlinks without elevation.
        destination = self.root / "outputs/report.json"
        original_resolve = Path.resolve

        def resolved(path, *args, **kwargs):
            if path == destination:
                return self.root.parent / "outside/report.json"
            return original_resolve(path, *args, **kwargs)

        with patch.object(Path, "resolve", resolved), self.assertRaises(ValueError):
            checker.output_path(self.root, "outputs/report.json")

    def test_tracked_alias_cannot_read_private_or_untracked_target(self):
        self.write("docs/alias.md", "# Placeholder\n")
        alias = self.root / "docs/alias.md"
        original_resolve = Path.resolve

        def resolved(path, *args, **kwargs):
            if path == alias:
                return self.root / ".env"
            return original_resolve(path, *args, **kwargs)

        with patch.object(Path, "resolve", resolved):
            self.assertIn("TRACKED_ALIAS", self.codes())

    def test_root_directory_link_and_windows_absolute_path(self):
        self.write("docs/guide.md", "# Guide\n[Repository](../)\n")
        self.assertTrue(self.audit()["ok"], self.audit()["errors"])
        self.write("docs/guide.md", "# Guide\n[Outside](C:/private.md)\n")
        self.assertIn("LINK_PATH_INVALID", self.codes())

    def test_migration_version_must_be_a_calendar_timestamp(self):
        self.write("supabase/migrations/20261310000100_invalid.sql", "-- synthetic\n")
        self.assertIn("MIGRATION_TIMESTAMP", self.codes())

    def test_duplicate_and_explicit_heading_anchors(self):
        source = '# Guide\n## Same heading\n## Same heading\n<a id="kept-anchor"></a>\n'
        self.assertTrue({"guide", "same-heading", "same-heading-1", "kept-anchor"}.issubset(checker.heading_anchors(source)))

    def test_git_inventory_includes_staged_not_untracked_files(self):
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True, capture_output=True)
        subprocess.run(["git", "add", "--", "README.md"], cwd=self.root, check=True, capture_output=True)
        (self.root / "untracked-secret.txt").write_text("synthetic-do-not-read", encoding="utf-8")
        self.assertEqual(checker.tracked_files(self.root), ["README.md"])


if __name__ == "__main__":
    unittest.main()
