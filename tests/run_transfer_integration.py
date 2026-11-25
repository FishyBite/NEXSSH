"""Run the Rust transfer fault-injection test against an isolated SFTP server."""
import asyncio
import json
import secrets
import sys
import tempfile
import os
from pathlib import Path

import asyncssh


async def main(binary):
    with tempfile.TemporaryDirectory(prefix="nexssh-sftp-test-") as directory:
        root = Path(directory)
        files = root / "remote"
        files.mkdir()
        password = secrets.token_urlsafe(32)
        key = asyncssh.generate_private_key("ssh-ed25519")

        class Server(asyncssh.SSHServer):
            def begin_auth(self, username):
                return True

            def password_auth_supported(self):
                return True

            def validate_password(self, username, supplied):
                return username == "fixture" and secrets.compare_digest(supplied, password)

        async def no_shell(process):
            process.exit(127)

        async with await asyncssh.listen(
            "127.0.0.1", 0, server_factory=Server, server_host_keys=[key],
            process_factory=no_shell, sftp_factory=lambda chan: asyncssh.SFTPServer(chan, chroot=str(files)),
        ) as server:
            connection = root / "connection.json"
            connection.write_text(json.dumps(dict(
                hostname="127.0.0.1", port=server.get_port(), username="fixture",
                password=password, fingerprint=key.get_fingerprint(),
            )), encoding="utf-8")
            process = await asyncio.create_subprocess_exec(
                binary, "transfers::integration::transport_disconnect_resume_and_conflict_policies",
                "--exact", "--ignored", "--nocapture",
                env={**os.environ, "NEXSSH_TEST_CONNECTION": str(connection)},
            )
            return await process.wait()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1])))
