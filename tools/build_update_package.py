"""Build a signed, stored ZIP for the VEXSSH local updater."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from zipfile import ZipFile, ZIP_STORED

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--private-key", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    version = json.loads((source / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Only stable release versions can be packaged")
    binary = args.binary.resolve(strict=True)
    if os.name != "nt":
        raise RuntimeError("Create this Windows release package on Windows to verify its resource version")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "(Get-Item -LiteralPath $env:VEXSSH_UPDATE_BINARY).VersionInfo.ProductVersion"],
        env={**os.environ, "VEXSSH_UPDATE_BINARY": str(binary)},
        text=True, capture_output=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.stdout.strip() != version:
        raise ValueError("Executable resource version does not match the source release")
    executable = binary.read_bytes()
    if not 256 <= len(executable) <= 256 * 1024 * 1024 or executable[:2] != b"MZ":
        raise ValueError("Invalid release executable")
    key = Ed25519PrivateKey.from_private_bytes(args.private_key.read_bytes())
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    backend = (source / "src-tauri" / "src" / "updates.rs").read_text(encoding="utf-8")
    expected = re.search(r'const PUBLIC_KEY: &str = "([A-Za-z0-9+/=]+)";', backend)
    if not expected or public != base64.b64decode(expected.group(1)):
        raise ValueError("Signing key does not match the application's trusted release key")
    manifest = json.dumps({
        "schema": 1, "product": "com.vexssh.desktop", "version": version,
        "target": "x86_64-pc-windows-msvc", "file": "VEXSSH.exe",
        "size": len(executable), "sha256": hashlib.sha256(executable).hexdigest(),
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = key.sign(manifest)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="vexssh-release-", suffix=".tmp", dir=output.parent, delete=False) as temporary:
        staged = Path(temporary.name)
    try:
        with ZipFile(staged, "w", compression=ZIP_STORED, allowZip64=False) as package:
            package.writestr("manifest.json", manifest)
            package.writestr("manifest.sig", signature)
            package.writestr("VEXSSH.exe", executable)
        with ZipFile(staged) as package:
            if package.testzip() is not None:
                raise ValueError("Update ZIP verification failed")
            key.public_key().verify(package.read("manifest.sig"), package.read("manifest.json"))
        os.replace(staged, output)
    finally:
        staged.unlink(missing_ok=True)
    print(f"Signed VEXSSH {version} update package: {output.name} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
