<p align="center">
  <img src="public/vexssh.svg" alt="VEXSSH logo" width="96" height="96">
</p>

<h1 align="center">VEXSSH</h1>

<p align="center">SSH · SFTP/SCP · Serial · Databases</p>

VEXSSH is a Windows desktop app for SSH, remote file transfers, serial consoles, and database connections.

It keeps a shell and the files you’re working on in the same window. Open a saved host, switch to SFTP to move or edit a file, and switch back to the same shell.

## Preview

![VEXSSH Hosts view in dark mode, showing five sample connections and the workspace sidebar](docs/vexssh-workspace.png)

*Hosts view with sample connections for Ubuntu Server, Debian Server, Raspberry Pi, Proxmox, and Home Assistant.*

![VEXSSH Databases view showing a SQLite connection, three tables, a SQL query, and four result rows](docs/vexssh-databases.png)

*Database workspace with a sample SQLite inventory, a SQL query, and its results.*


## What it does

- **SSH** with saved hosts, tabs, split panes, and server fingerprint verification. Sign in with a password, an OpenSSH private key, or an SSH agent.
- **SFTP and SCP** for transfers between your computer and a remote host. Drag files across panes, check transfer progress, and resume eligible interrupted SFTP transfers.
- **Serial** for Windows COM ports. Save the baud rate, parity, stop bits, and flow control for each device.
- **Databases** with a query editor and object browser. Connect directly or through an existing SSH session. SQLite opens a local file.

## Download

Get the Windows x64 installer or portable executable from [VEXSSH Releases](../../releases).

## Application data

New builds use separate VEXSSH installation and storage identifiers. Existing RC7 and RC8 data stays in its original location. Keep a copy of your existing build if you need to open its data or backups.

## Run on Windows

VEXSSH uses Microsoft Edge WebView2. The Windows x64 installer can download the runtime when needed. The portable executable requires WebView2 to be installed already.

For a first SSH session, open **Hosts**, add your server, and verify its fingerprint when prompted. Use **Terminal** and **SFTP** in the session bar to switch between the shell and files.

## Build from source

Install Node.js, Rust with the MSVC toolchain, Microsoft C++ Build Tools with a Windows SDK, WebView2, Go 1.26 or later, and Strawberry Perl. Make sure Go and Perl are on your PATH.

```powershell
npm ci
npm run desktop
```

Run the frontend tests and build the Windows executable with:

```powershell
npm test
npm run tauri -- build --no-bundle
```

The executable is written to `src-tauri/target/release/vexssh.exe`. The frontend uses React and TypeScript. Tauri and Rust handle the desktop app, and a Go helper provides database drivers.

## Credits

Created by [FishyBite](https://github.com/FishyBite).
