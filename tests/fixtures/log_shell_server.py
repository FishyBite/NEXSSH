"""Local SSH test service. Its only accepted exec is the fixture directory command."""
import asyncio
import json
import os
import argparse
import shutil
from pathlib import Path
import secrets
import asyncssh

parser = argparse.ArgumentParser()
parser.add_argument("--test-dir", type=Path, required=True)
args = parser.parse_args()
root = args.test_dir.resolve()
git = shutil.which("git")
if not git:
    raise SystemExit("Git for Windows is required.")
bash = Path(git).resolve().parents[1] / "bin" / "bash.exe"
if not bash.is_file():
    raise SystemExit("Git for Windows and its Bash executable are required.")
root.mkdir(parents=True, exist_ok=True)
if any(root.iterdir()):
    raise SystemExit("Use an empty fixture directory.")
directory = root / "Team's files [$]"
directory.mkdir(exist_ok=True)
cwd = "/" + directory.drive[0].lower() + directory.as_posix()[2:]
command = "cd '" + cwd.replace("'", "'\\''") + "' && exec \"${SHELL:-/bin/sh}\" -i"
password = secrets.token_urlsafe(24)
key = asyncssh.generate_private_key("ssh-ed25519")
class Server(asyncssh.SSHServer):
    def begin_auth(self, username): return True
    def password_auth_supported(self): return True
    def validate_password(self, username, passwd):
        return username == "fixture" and secrets.compare_digest(password, passwd)

async def shell(process):
    if process.command != command or not process.get_terminal_type():
        process.exit(1)
        return
    # Only fixed fixture commands execute. The user's profile and rc files are outside this test.
    proc = await asyncio.create_subprocess_exec(
        str(bash), "--noprofile", "--norc", "-c", command,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "SHELL":"/bin/sh", "HOME":str(root), "ENV":""})
    out, _ = await proc.communicate(b"pwd -P\nexit\n")
    process.stdout.write(out.decode("utf8"))
    process.exit(proc.returncode)

async def main():
    server = await asyncssh.listen("127.0.0.1", 0, server_factory=Server,
        server_host_keys=[key],process_factory=shell,
        sftp_factory=lambda channel:asyncssh.SFTPServer(channel,chroot=str(root)))
    (root/"config.json").write_text(json.dumps(dict(port=server.get_port(),password=password,cwd=cwd,
        fingerprint=key.get_fingerprint())))
    await server.wait_closed()
asyncio.run(main())
