"""Loopback-only integration server with isolated files and ephemeral credentials."""
import asyncio
import json
import secrets
from pathlib import Path
import asyncssh

ROOT = Path(__file__).parent / 'ssh-fixture'
ROOT.mkdir(exist_ok=True)
FILES = ROOT / 'files'
FILES.mkdir(exist_ok=True)
PASSWORD = secrets.token_urlsafe(24)
HOST_KEY = asyncssh.generate_private_key('ssh-ed25519')
USER_KEY = asyncssh.generate_private_key('ssh-ed25519')
KEY_PASSWORD = secrets.token_urlsafe(24)
(ROOT / 'identity').write_bytes(USER_KEY.export_private_key(passphrase=KEY_PASSWORD))
(FILES / 'hello.txt').write_text('NEXSSH integration test\n', encoding='utf-8')
(FILES / 'nested').mkdir(exist_ok=True)
(FILES / 'nested' / 'settings.json').write_text('{"enabled":true}\n', encoding='utf-8')

class Server(asyncssh.SSHServer):
    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def validate_password(self, username, password):
        return username == 'nexssh-test' and secrets.compare_digest(password, PASSWORD)

    def public_key_auth_supported(self):
        return True

    def validate_public_key(self, username, key):
        allowed = [USER_KEY.convert_to_public()]
        extra = ROOT / 'authorized.pub'
        if extra.exists():
            allowed.append(asyncssh.read_public_key(extra))
        return username == 'nexssh-test' and key in allowed

    def connection_requested(self, dest_host, dest_port, orig_host, orig_port):
        return dest_host in ('127.0.0.1', 'localhost')

    def server_requested(self, listen_host, listen_port):
        return listen_host in ('127.0.0.1', 'localhost')

async def process(session):
    if session.command:
        session.stderr.write('This Windows fixture has no Linux /proc filesystem.\n')
        session.exit(1)
        return
    session.stdout.write('NEXSSH loopback SSH test server\r\n$ ')
    while True:
        try:
            line = await session.stdin.readline()
        except asyncssh.TerminalSizeChanged:
            continue
        if not line:
            break
        command = line.strip()
        if command == 'exit':
            session.exit(0)
            return
        session.stdout.write(f'received: {command}\r\n$ ')

async def echo(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()

async def main():
    await asyncio.start_server(echo, '127.0.0.1', 18992)
    server = await asyncssh.listen(
        '127.0.0.1', 18991, server_factory=Server,
        server_host_keys=[HOST_KEY], process_factory=process,
        sftp_factory=lambda channel: asyncssh.SFTPServer(channel, chroot=str(FILES)),
        allow_scp=True,
    )
    (ROOT / 'connection.json').write_text(json.dumps({
        'hostname': '127.0.0.1', 'port': 18991, 'username': 'nexssh-test',
        'password': PASSWORD, 'fingerprint': HOST_KEY.get_fingerprint(),
        'identityFile': str(ROOT / 'identity'), 'passphrase': KEY_PASSWORD,
        'echoPort': 18992,
    }), encoding='utf-8')
    print('SSH fixture listening on loopback port 18991', flush=True)
    await server.wait_closed()

asyncio.run(main())
