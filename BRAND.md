# NEXSSH identity

The app mark pairs a terminal prompt with a cursor. The prompt identifies the SSH workspace immediately; the cursor also gives the mark a clear baseline at small Windows icon sizes. It is drawn as vector geometry rather than a font character or a library icon.

The blue tile continues the product's existing blue accent. Its restrained change in brightness gives the standalone Windows icon depth; the pale blue cursor stays distinct from the white prompt. The rounded outer tile defines the icon boundary against both light and dark desktops. No shadow or animation is required.

The source is `public/nexssh.svg`. The same asset appears in the sidebar and browser favicon. Generate native assets with `npm run tauri -- icon public/nexssh.svg`, then build the release so Windows uses the new embedded icon.

The existing interface direction remains ENERGY 1, RHYTHM 2, MOTION 1. The logo is a static identifier, not an additional control. Its 32 by 32 pixel sidebar footprint preserves the terminal layout.

## Logo delivery checks

- Hard gate PASS: the asset was explicitly requested, contains no claims or text, reserves 32 by 32 pixels in the sidebar, and introduces no controls or animation. Headless checks at widths 1440 and 760 found no overflow or page errors in either theme.
- Purpose gate PASS: the prompt identifies a terminal app, the cursor establishes a baseline, and the blue tile continues the existing accent. The single-color shading defines the standalone Windows icon without affecting the interface background.
- Liveliness PASS: the prompt and cursor create a recognizable silhouette; the existing direction and deliberate blue accent remain consistent. The mark was inspected at both 256 and 32 pixels.
- Craftsmanship PASS: the SVG decoded at 256 by 256 and displayed at 32 by 32. Expanded mode uses decorative alt text beside the wordmark; collapsed mode exposes the name NEXSSH. The favicon returned HTTP 200 with image/svg+xml. Native ICO entries are 16, 24, 32, 48, 64, and 256 pixels at 32-bit depth.

These checks apply to the logo change. Broader application verification and its remaining limits are recorded in `VALIDATION.md`.

## Tab and titlebar direction, 0.1.5

This remains a desktop SSH workspace for operators, with the existing compact dark/light interface and ENERGY 1 / RHYTHM 2 / MOTION 1. The terminal remains the focal area. A 3 pixel blue insertion line identifies the drop location, the source tab uses the existing hover surface, and a grab cursor communicates movement. These are interaction states, with no decorative animation or new assets. Native caption colors match the application background and text so the window chrome belongs to the same workspace.

## Tab and titlebar delivery checks

- Hard gate PASS for the changed controls: actual production-bundle tests cover mouse drag, Escape cancellation, keyboard reorder, click, rename and close. Screenshots at 760 by 560 and 1800 by 900 show contained tab scrolling without page overflow. Dragged text contrast is 5.63:1 dark and 5.18:1 light; keyboard focus is visible in both themes.
- Purpose gate PASS: the insertion line identifies the target, source highlighting identifies the moving tab, and native caption colors reduce the visual break above the workspace. Existing blue accents, typography and icon assets are retained.
- Liveliness PASS: the existing 1/2/1 direction is retained, with terminal output as the focal area and the blue active-tab/drop indicators identifying interaction state. Spacing separates navigation, tabs and terminal controls without reducing the terminal workspace.
- Craftsmanship PASS for the tested scope: 23 frontend unit tests pass. Production-bundle tests preserve the active session, xterm node identities, split-pane positions and Files target while tabs move. Theme tests cover light/dark/system and forced-colors resynchronization. Three focused native tests validate DWM color setters and unchanged window styles. Visible native caption rendering has not been inspected; the live user application was not controlled.

Native Windows caption APIs retain the system controls. Custom caption colors require [Windows 11 DWM support](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute); unsupported calls leave the standard titlebar available. High Contrast restores system caption colors. The implementation changes DWM colors without overriding WebView's preferred color scheme, so System theme can continue following Windows.

## Workspace interaction direction, 0.2.0

The existing ENERGY 1 / RHYTHM 2 / MOTION 1 direction remains. A large terminal canvas is the focal area; compact navigation and grouped tools leave more room for output. The blue active-tab edge, terminal prompt mark, and restrained monospace output retain the application's identity. Inter stays on controls for readable dense labels. Existing Lucide icons represent concrete actions such as search, folder navigation and transfer. No new logo, illustration or decorative assets were introduced.

Motion explains a state change: the tab ghost follows the pointer, nearby tabs make room, and menus/dialogs enter in 120–160 ms. Reduced motion disables spatial transitions. Blue is the main action accent; environment colors encode user-assigned categories with text labels, never inferred server safety. Menu elevation separates temporary controls from terminal output. The bookmark dialog retains a solid surface; modal overlay blur separates the active task. Buttons reserve their label width while loading.

## 0.2.0 delivery gate

This gate covers the changed workspace, tab, host label, Files navigation, shared controls and Updates UI. Existing application-wide validation limits remain in `VALIDATION.md`; this is not a claim that every historical control was retested.

| Gate | Result and evidence |
| --- | --- |
| Hard gate | PASS for the changed scope. Production UI click-through covers restore/connect, tab menus, drag/keyboard cancellation, profiles/font, host environment, Files navigation/bookmarks/comparison, update choose/schedule/cancel/error, and keyboard tooltips. All 14 final enhancement checks pass with zero runtime errors. Empty, loading and error states are exercised. Both themes fit 760×560 without horizontal page overflow. Badge text contrast is at least 5.84:1; ghost text exceeds 15:1. Busy buttons retain accessible names and stable width. Reduced motion is tested. No new unsupported claims, fake content, dead links, media, or unrequested visual assets were added. |
| Purpose gate | PASS. Ghost/gap show the drag destination; menu elevation separates temporary actions; environment badges identify the operator's label; status-bar success messages avoid blocking output; restrained transitions explain state changes. Existing typography, icons and blue accent keep their documented roles. |
| Liveliness | PASS. Dials remain explicit at 1/2/1. Terminal output is the focal area, paired file panels support direct comparison, and compact tool groups structure space. The prompt/cursor motif and active-tab accent retain a specific terminal workspace identity without decorative panels. |
| Craftsmanship and quality locks | PASS for the tested scope. Final production-bundle scenarios preserve session and xterm identity, prevent auto-connect during restoration, test confirmation before bulk close, and cover pointer and keyboard menus. Files tests reject stale results and keep the selected server binding. Final screenshots were inspected in both themes, including the settled bookmark dialog. No whole-application performance claim is made. Native updater replacement is tested on scratch files; the complete installed-app exit/helper/restart sequence remains an explicitly documented validation limit. |

Recorded click-through evidence: tab rename opens and saves the name; duplicate authenticates a new fixture connection; group menu updates the session group; Close others cancels without disconnecting and confirms only the intended sessions; Appearance works by mouse and keyboard; size reset restores the profile size; reload shows saved tabs without creating xterm; Connect restores the selected tab; host Environment survives save and appears in Terminal/Files; Back/Forward/Home change the correct panel; bookmark opens the saved path; Retry recovers a failed listing; Compare folders labels metadata differences without writing files; update selection verifies before offering installation; schedule and cancel update the pending state; corrupt pending state can be cleared; icon focus displays a tooltip; reduced motion suppresses transitions.

## File drag direction, 0.2.1

ENERGY 1 / RHYTHM 2 / MOTION 1 remain unchanged. The paired lists remain the focal area. A compact pointer-following preview shows the selected count and copy destination; the existing blue accent identifies the accepting panel or folder. This is transfer feedback, with no decorative asset or new navigation. Invalid destinations have no accepting highlight. The Upload/Download buttons remain the keyboard alternative. Dropping queues a copy and keeps the Files view open, so repeated transfers do not interrupt navigation.

## 0.2.1 delivery gate

- Hard gate PASS for file dragging: 45 component scenarios pass, including pointer, keyboard fallback, empty/loading/error conditions, invalid targets, cancellations and native event races. Dark/light screenshots at 760×560 have no horizontal overflow; preview text is at least 5.27:1 and target outline at least 4.49:1. The new interaction uses existing icons, concise functional labels and no unsupported claims or decorative assets.
- Purpose gate PASS: the preview identifies item count/destination, the outline identifies the accepting folder, and source highlighting identifies the dragged set. Autoscroll exposes folders below the fold and stops on cancellation. No new palette, typography, decoration or navigation was added.
- Liveliness PASS: the established 1/2/1 direction and paired file lists remain; one deliberate blue accent follows the current transfer target. Pointer tracking and restrained row-state transitions explain the interaction, with reduced-motion rules retained.
- Craftsmanship PASS for the tested scope: 41 frontend unit tests pass; production App testing confirms correct session/direction/protocol/destination and keeps Files open after drop. The 45-case component suite checks immutable queued payloads, partial errors and stale-target rejection; code review confirms the drag flow only queues transfers and sends no move/delete operation. Screenshots of both themes were inspected. Native Explorer transport is simulated, and no claim of live-server or installed-window drag testing is made.

## Startup window, 0.2.2

- Hard gate PASS for this configuration change: no new assets, text, colors, controls or motion were added. Standard Windows decorations and resizing remain enabled.
- Purpose gate PASS: native maximization uses the available desktop work area immediately at startup and retains access to the taskbar and window controls.
- Liveliness PASS: the existing ENERGY 1 / RHYTHM 2 / MOTION 1 direction and responsive workspace remain unchanged.
- Craftsmanship PASS for configuration and build validation: the installed framework maps maximized to the Windows native window builder; no startup override was found; TypeScript, Vite and the native release build pass. The visible startup window was not controlled or inspected in this change.
