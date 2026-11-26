"""Run with Python + asyncssh, a packaged Windows VEXSSH executable, and npm ci."""
import asyncio
from contextlib import AsyncExitStack
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile

import asyncssh


async def serve(stack, directory, username):
    password = secrets.token_urlsafe(24)
    key = asyncssh.generate_private_key("ssh-ed25519")

    class Server(asyncssh.SSHServer):
        def begin_auth(self, user):
            return True

        def password_auth_supported(self):
            return True

        def validate_password(self, user, candidate):
            return user == username and secrets.compare_digest(candidate, password)

    class PosixFixture(asyncssh.SFTPServer):
        def map_path(self, path):
            # The Windows test machine would otherwise silently accept broken remote joins.
            if b"\\" in path:
                raise asyncssh.SFTPNoSuchFile("Fixture uses POSIX path separators")
            return super().map_path(path)

    async def shell(process):
        if process.command:
            # No remote checksum utility. Verification must work over SFTP.
            process.exit(127)
            return
        process.stdout.write("Test shell ready\r\n")
        await process.stdin.read()

    server = await stack.enter_async_context(await asyncssh.listen(
        "127.0.0.1", 0, server_factory=Server, server_host_keys=[key],
        process_factory=shell, sftp_factory=lambda channel: PosixFixture(channel, chroot=str(directory)),
    ))
    return dict(port=server.get_port(), username=username, password=password, fingerprint=key.get_fingerprint())


def tree(root):
    return {p.relative_to(root): p.read_bytes() if p.is_file() else None for p in root.rglob("*")}


def verify_known_folders(profile):
    """Check the Win32 paths used by the desktop executable before launching it."""
    import ctypes
    import uuid
    for folder_id, expected in [
        ("3EB685DB-65F9-4CF6-A03A-E3EF65729F3D", profile / "AppData/Roaming"),
        ("F1B32785-6FBA-4FCF-9D55-7B8E7F157091", profile / "AppData/Local"),
    ]:
        guid = ctypes.create_string_buffer(uuid.UUID(folder_id).bytes_le)
        result = ctypes.c_wchar_p()
        status = ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(result))
        try:
            if status or not result.value or Path(result.value).resolve() != expected.resolve():
                raise RuntimeError("Windows did not isolate the desktop app's known folders")
        finally:
            ctypes.windll.ole32.CoTaskMemFree(result)


async def run(binary):
    with tempfile.TemporaryDirectory(prefix="vexssh-two-hosts-", ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        profile = root / "profile"
        roaming, local = profile / "AppData/Roaming", profile / "AppData/Local"
        for path in (roaming, local):
            path.mkdir(parents=True)
        # Older Windows installations retain the original application identifier.
        app_data_dirs = [roaming / name for name in ("com.vexssh.desktop", "com.nexssh.desktop")]
        left, right = root / "a", root / "b"
        for side in (left, right):
            origin = side / "source folder"
            (origin / "empty").mkdir(parents=True)
            (origin / "nested").mkdir()
            (origin / "nested" / "résumé.bin").write_bytes(secrets.token_bytes(147_017))
            (origin / "zero.txt").touch()
            (side / "out").mkdir()
        (left / "large.bin").write_bytes(secrets.token_bytes(2 * 1024 * 1024 + 7))
        original = b"existing file at destination"
        (right / "out" / "conflict.bin").write_bytes(original)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cdp = sock.getsockname()[1]
        async with AsyncExitStack() as stack:
            endpoints = [await serve(stack, left, "source-user"), await serve(stack, right, "destination-user")]
            env = {**os.environ, "USERPROFILE": str(profile), "APPDATA": str(roaming), "LOCALAPPDATA": str(local),
                   "WEBVIEW2_USER_DATA_FOLDER": str(root / "webview"),
                   "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS":
                   f"--remote-debugging-address=127.0.0.1 --remote-debugging-port={cdp}",
                   "VEXSSH_RELAY_TEST_CDP": f"http://127.0.0.1:{cdp}",
                   "VEXSSH_RELAY_TEST_ENDPOINTS": json.dumps(endpoints)}
            # Keep endpoint passwords out of the app environment and out of command-line arguments.
            app_env = {k: v for k, v in env.items() if not k.startswith("VEXSSH_RELAY_TEST_")}
            app_env.pop("VEXSSH_TEST_DATA_DIR", None)
            subprocess.run([sys.executable, __file__, "--check-profile", str(profile)], cwd=root,
                           env=app_env, check=True, timeout=15)
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = subprocess.SW_HIDE
            app = subprocess.Popen([str(binary)], env=app_env, cwd=root, startupinfo=startup)
            try:
                for _ in range(200):
                    if app.poll() is not None:
                        raise RuntimeError("Test app exited before initializing")
                    if any(any(path.glob("*.sqlite3")) for path in app_data_dirs):
                        break
                    await asyncio.sleep(.15)
                else:
                    raise RuntimeError("Test app did not open the disposable database")
                client = await asyncio.create_subprocess_exec(
                    "node", str(Path(__file__).with_name("relay_integration.mjs")), env=env)
                try:
                    if await asyncio.wait_for(client.wait(), timeout=180):
                        raise RuntimeError("Native relay checks failed")
                finally:
                    if client.returncode is None:
                        client.kill()
                        await client.wait()
            finally:
                if app.poll() is None:
                    app.terminate()
                    await asyncio.to_thread(app.wait, 10)
        assert tree(left / "source folder") == tree(right / "out" / "from A")
        assert tree(right / "source folder") == tree(left / "out" / "from B")
        assert (right / "out" / "conflict.bin").read_bytes() == original
        assert (left / "large.bin").read_bytes() == (right / "out" / "resumed.bin").read_bytes()
        print("Both remote directory trees, including empty folders and binary data, match exactly.")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--check-profile":
        verify_known_folders(Path(sys.argv[2]))
    else:
        asyncio.run(run(Path(sys.argv[1]).resolve()))
