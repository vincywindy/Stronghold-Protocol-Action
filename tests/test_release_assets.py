import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import stat
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
        files["data/assets.json"] = json.dumps({
            "audio": {"attack": "/assets/audio/attack%20sound.mp3"},
            "fonts": {"css": "/fonts/fonts.css", "face": "/fonts/game.woff2"},
        })
        files["public/assets/audio/attack sound.mp3"] = b"audio"
        files["public/fonts/fonts.css"] = "@font-face {}"
        files["public/fonts/game.woff2"] = b"font"
        if missing:
            del files[missing]
        files.update(extra or {})
        with zipfile.ZipFile(self.archive, "w") as bundle:
            for name, data in files.items():
                bundle.writestr(assets.PREFIX + name, data)

    def test_all_matching_art_and_manifests_are_copied(self):
        self.bundle()
        self.assertEqual(assets.extract_release_assets(self.archive, self.destination, "v0.2.1"), 10)
        self.assertTrue((self.destination / assets.MANIFEST).is_file())
        self.assertTrue((self.destination / "data/assets.json").is_file())
        self.assertEqual((self.destination / "public/assets/audio/attack sound.mp3").read_bytes(), b"audio")
        self.assertTrue((self.destination / "public/fonts/game.woff2").is_file())
        self.assertFalse((self.destination / "server").exists())
        self.assertFalse((self.destination / "node_modules").exists())

    def test_wrong_version_is_rejected_before_writing(self):
        self.bundle(version="0.1.4")
        with self.assertRaisesRegex(ValueError, "version"):
            assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        self.assertFalse(self.destination.exists())

    def test_incomplete_manifest_or_board_files_are_rejected(self):
        for missing in (assets.MANIFEST, "data/assets.json", "public/assets/audio/attack sound.mp3",
                        "public/fonts/game.woff2", assets.LOCAL + "map/autochess/sample.png",
                        assets.LOCAL + "map/autochess/tiles.json"):
            with self.subTest(missing=missing):
                self.bundle(missing=missing)
                with self.assertRaises(ValueError):
                    assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
                self.assertFalse(self.destination.exists())

    def test_path_traversal_cannot_escape_destination(self):
        self.bundle(extra={assets.LOCAL + "../../../../escape.txt": "bad"})
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        self.assertFalse((self.root / "escape.txt").exists())

    def test_optional_fx_manifest_and_references_are_validated(self):
        fx = {"data/local-fx.json": json.dumps({"groups": {"fx": {"path": "/assets/local/fx/sample.png"}}})}
        self.bundle(extra=fx)
        with self.assertRaisesRegex(ValueError, "missing files"):
            assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        self.assertFalse(self.destination.exists())
        self.bundle(extra={**fx, "public/assets/local/fx/sample.png": b"effect"})
        assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        self.assertTrue((self.destination / "data/local-fx.json").is_file())

    def test_encoded_traversal_in_manifest_is_rejected_before_writing(self):
        self.bundle(extra={"data/assets.json": json.dumps({"path": "/assets/%2e%2e/escape.png"})})
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        self.assertFalse(self.destination.exists())

    def test_symlink_empty_asset_and_oversized_extraction_are_rejected(self):
        self.bundle(extra={"public/assets/empty.png": b""})
        with self.assertRaisesRegex(ValueError, "empty"):
            assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        self.bundle()
        with patch.object(assets, "MAX_ASSETS", 1):
            with self.assertRaisesRegex(ValueError, "size limit"):
                assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        with zipfile.ZipFile(self.archive, "a") as bundle:
            link = zipfile.ZipInfo(assets.PREFIX + "public/assets/link.png")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(link, "../../outside")
        with self.assertRaisesRegex(ValueError, "symlink"):
            assets.extract_release_assets(self.archive, self.destination, "v0.2.1")
        self.assertFalse(self.destination.exists())

    def test_old_release_files_cannot_be_mixed_in(self):
        self.bundle()
        self.destination.mkdir()
        (self.destination / "old.txt").write_text("old release")
        with self.assertRaisesRegex(ValueError, "empty"):
            assets.extract_release_assets(self.archive, self.destination, "v0.2.1")

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
