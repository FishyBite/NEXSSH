# VEXSSH branding

The logo combines a white V and a terminal cursor on a blue tile. The sidebar and favicon use [the source SVG](public/vexssh.svg). Windows and the installer use the ICO in [src-tauri/icons](src-tauri/icons).

To regenerate the icons, run this from the project root:

```powershell
npm run tauri -- icon public/vexssh.svg -o ./generated-icons
```

Copy `icon.ico` and `icon.png` from `generated-icons` into `src-tauri/icons`.
