"""Copy version-matched local-client art from an upstream full Release, never its code/dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import time
from urllib.request import Request, urlopen
import zipfile


PREFIX = "Stronghold-Protocol/"
MANIFEST = "data/local-assets.json"
LOCAL = "public/assets/local/"
MAX_ARCHIVE = 2 * 1024**3
MAX_LOCAL = 512 * 1024**2


def asset_for_release(repository, tag):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not re.fullmatch(r"[\w.-]+", tag):
        raise ValueError("Invalid repository or release tag")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "Stronghold-Protocol-Action"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    with urlopen(Request(f"https://api.github.com/repos/{repository}/releases/tags/{tag}", headers=headers), timeout=30) as response:
        release = json.load(response)
    if release.get("tag_name") != tag or release.get("draft") or release.get("prerelease"):
        raise ValueError("Expected the requested stable release")
    # The full bundle alone includes the local art; lite/update/source ZIPs are not substitutes.
    name = f"Stronghold-Protocol-{tag}.zip"
    matches = [asset for asset in release["assets"] if asset["name"] == name]
    if len(matches) != 1:
        raise ValueError(f"Missing full release bundle: {name}")
    asset = matches[0]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest") or ""):
        raise ValueError("Full release bundle has no verifiable SHA-256 digest")
    expected_url = f"https://github.com/{repository}/releases/download/{tag}/{name}"
    if asset["browser_download_url"] != expected_url or not 0 < asset["size"] <= MAX_ARCHIVE:
        raise ValueError("Unexpected release download URL or archive size")
    return asset


def download(asset, destination):
    for attempt in range(3):
        try:
            # Public download needs no credentials; do not forward the API token to a redirect/CDN.
            with urlopen(Request(asset["browser_download_url"], headers={"User-Agent": "Stronghold-Protocol-Action"}), timeout=90) as source:
                with destination.open("wb") as target:
                    size = 0
                    while chunk := source.read(1024**2):
                        size += len(chunk)
                        if size > asset["size"]:
                            raise ValueError("Release download exceeded the declared size")
                        target.write(chunk)
            verify_archive(destination, asset)
            return
        except (OSError, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def verify_archive(archive, asset):
    with archive.open("rb") as stream:
        digest = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
    if archive.stat().st_size != asset["size"] or digest != asset["digest"]:
        raise ValueError("Release archive size/SHA-256 mismatch")


def manifest_paths(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from manifest_paths(item)
    elif isinstance(value, list):
        for item in value:
            yield from manifest_paths(item)
    elif isinstance(value, str) and value.startswith("/assets/local/"):
        yield "public" + value


def safe_relative(path):
    parts = PurePosixPath(path).parts
    if "\\" in path or ":" in path or path.startswith("/") or any(part in (".", "..") for part in path.split("/")):
        raise ValueError(f"Unsafe archive path: {path}")
    return Path(*parts)


def extract_local_assets(archive, destination, tag):
    destination = destination.resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Asset destination must be empty to avoid mixing release versions")
    with zipfile.ZipFile(archive) as bundle:
        package = json.loads(bundle.read(PREFIX + "package.json"))
        if package.get("version") != tag.removeprefix("v"):
            raise ValueError("Bundle package version does not match the selected release")
        selected = {}
        for info in bundle.infolist():
            if not info.filename.startswith(PREFIX) or info.is_dir():
                continue
            relative = info.filename[len(PREFIX):]
            if relative != MANIFEST and not relative.startswith(LOCAL):
                continue
            safe_relative(relative)
            if stat.S_ISLNK(info.external_attr >> 16) or relative in selected or info.file_size <= 0:
                raise ValueError(f"Invalid, duplicate, empty or symlink asset: {relative}")
            selected[relative] = info
        if sum(info.file_size for info in selected.values()) > MAX_LOCAL:
            raise ValueError("Local assets exceed the extraction size limit")
        if MANIFEST not in selected:
            raise ValueError("Full bundle is missing data/local-assets.json")
        manifest = json.loads(bundle.read(selected[MANIFEST]))
        groups = manifest.get("groups", {})
        # These are the upstream renderer's board groups, not merely optional UI decorations.
        for group in ("map/autochess", "map/autochesssand", "mesh/map_autochess_bkg", "map/fx", "map/water"):
            if not groups.get(group):
                raise ValueError(f"Missing 3D board asset group: {group}")
        required = set(manifest_paths(manifest)) | {
            LOCAL + "map/autochess/tiles.json", LOCAL + "mesh/map_autochess_bkg/prefab.json",
        }
        if not required.issubset(selected):
            raise ValueError(f"Manifest references missing files: {sorted(required - selected.keys())[:5]}")
        # Validate the entire selection before writing; never extract executable bundle contents.
        for relative, info in selected.items():
            output = destination / safe_relative(relative)
            output.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, output.open("wb") as target:
                shutil.copyfileobj(source, target)
        return len(selected) - 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default="sganggs/Stronghold-Protocol")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--archive", type=Path, help="Use an existing ZIP, still verify it against GitHub's digest")
    args = parser.parse_args()
    asset = asset_for_release(args.repository, args.tag)
    with tempfile.TemporaryDirectory(prefix="stronghold-release-") as temporary:
        archive = args.archive or Path(temporary) / "release.zip"
        if args.archive:
            verify_archive(archive, asset)
        else:
            download(asset, archive)
        count = extract_local_assets(archive, args.destination, args.tag)
    print(f"Verified {args.tag}: extracted {count} local asset files ({asset['digest']})")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"digest={asset['digest']}\n")


if __name__ == "__main__":
    main()
