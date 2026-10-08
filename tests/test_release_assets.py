import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("prepare_assets", Path(__file__).parents[1] / "scripts/prepare-release-assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class ReleaseAssetsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "release.zip"
        self.destination = self.root / "assets"

    def bundle(self, version="0.2.1", missing=None, extra=None):
        groups = {}
        files = {"package.json": json.dumps({"version": version}),
                 "server/index.js": "Do not copy bundle code", "node_modules/example/index.js": "Do not copy dependencies"}
        for group in ("map/autochess", "map/autochesssand", "mesh/map_autochess_bkg", "map/fx", "map/water"):
            url = f"/assets/local/{group}/sample.png"
            groups[group] = {"sample": {"path": url}}
            files["public" + url] = b"sample texture"
        files[assets.LOCAL + "map/autochess/tiles.json"] = "{}"
        files[assets.LOCAL + "mesh/map_autochess_bkg/prefab.json"] = "{}"
        files[assets.MANIFEST] = json.dumps({"version": 1, "groups": groups})
        if missing:
            del files[missing]
        files.update(extra or {})
        with zipfile.ZipFile(self.archive, "w") as bundle:
            for name, data in files.items():
                bundle.writestr(assets.PREFIX + name, data)

    def test_only_matching_local_assets_are_copied(self):
        self.bundle()
        self.assertEqual(assets.extract_local_assets(self.archive, self.destination, "v0.2.1"), 7)
        self.assertTrue((self.destination / assets.MANIFEST).is_file())
        self.assertFalse((self.destination / "server").exists())
        self.assertFalse((self.destination / "node_modules").exists())

    def test_wrong_version_is_rejected_before_writing(self):
        self.bundle(version="0.1.4")
        with self.assertRaisesRegex(ValueError, "version"):
            assets.extract_local_assets(self.archive, self.destination, "v0.2.1")
        self.assertFalse(self.destination.exists())

    def test_incomplete_manifest_or_board_files_are_rejected(self):
        for missing in (assets.MANIFEST, assets.LOCAL + "map/autochess/sample.png", assets.LOCAL + "map/autochess/tiles.json"):
            with self.subTest(missing=missing):
                self.bundle(missing=missing)
                with self.assertRaises(ValueError):
                    assets.extract_local_assets(self.archive, self.destination, "v0.2.1")
                self.assertFalse(self.destination.exists())

    def test_path_traversal_cannot_escape_destination(self):
        self.bundle(extra={assets.LOCAL + "../../../../escape.txt": "bad"})
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            assets.extract_local_assets(self.archive, self.destination, "v0.2.1")
        self.assertFalse((self.root / "escape.txt").exists())

    def test_old_release_files_cannot_be_mixed_in(self):
        self.bundle()
        self.destination.mkdir()
        (self.destination / "old.txt").write_text("old release")
        with self.assertRaisesRegex(ValueError, "empty"):
            assets.extract_local_assets(self.archive, self.destination, "v0.2.1")

    def test_checksum_and_size_are_both_checked(self):
        self.bundle()
        expected = {"size": self.archive.stat().st_size,
                    "digest": "sha256:" + hashlib.sha256(self.archive.read_bytes()).hexdigest()}
        assets.verify_archive(self.archive, expected)
        for mismatch in ({**expected, "size": 1}, {**expected, "digest": "sha256:" + "0" * 64}):
            with self.assertRaisesRegex(ValueError, "mismatch"):
                assets.verify_archive(self.archive, mismatch)


if __name__ == "__main__":
    unittest.main()
