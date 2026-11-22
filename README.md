ALONE is a game where you gotta like survive. Don't go to this repo if you want to play the game, go to https://alone-game.crazyfunnyboy265.workers.dev/Alone to play the game.

## Client files

The browser client is split into `public/Alone.html`, `public/css/game.css`, and ordered scripts in `public/js/`. The scripts are classic scripts, not ES modules: the existing game uses shared top-level state and inline HTML event handlers. Keep the script tags in `Alone.html` in their current order when adding or moving code.

## Desktop release

The Electron app opens the release launcher. It includes the current ALONE release and automatically catalogs HTML builds in `legacy/`; versioned filenames such as `Alone (v0.19).html` are shown as `0.19.0.0`. An unversioned archive is listed as `0.0.0.0` and identified as unversioned. Close a game window to return to the launcher. New game releases use a four-part `major.minor.patch.revision` version such as `1.0.1.0`. The npm/Electron package keeps a SemVer-compatible version in `version`; `gameVersion` and Electron Builder's `buildVersion` carry the four-part game release number.

Run `npm run desktop:build` to create the configured desktop packages for the host platform without publishing them. The Windows NSIS installer offers install-location and shortcut options; the first-run wizard picks a screen-safe window size, theme, fullscreen, and sign-in behavior.

Installed Windows NSIS, Debian DEB, and Fedora RPM builds check GitHub Releases and can download and install updates from the launcher. Installing a Linux update may ask for the system password to authorize package installation. Portable Windows builds still need a manual download. Tag a release `v<version>` after updating the SemVer `version` and four-part `gameVersion`/`buildVersion`; the Desktop release workflow builds Windows and Linux packages and publishes them to GitHub Releases. To retry a failed release build without retagging, run **Desktop release** from the Actions tab with the existing tag as `release_tag`.

Game windows use the selected fullscreen and window-size settings; the launcher keeps an independent screen-aware size. Fullscreen uses the display's native resolution; the windowed presets are 1280×720, 1600×900, 1920×1080, and 2560×1440. Discord presence requires the Discord desktop app to be running.

Desktop save slots are JSON files in Electron's per-user application data folder under `saves/`. Existing IndexedDB saves are copied there the first time the desktop version lists saved worlds. **OPEN .SAVE FILE** and **DOWNLOAD .SAVE** use native file dialogs in desktop releases; browser behavior remains unchanged. Save files exported from the game remain portable between desktop and web.

The Electron preload exposes only the narrow desktop APIs the renderer needs. Keep `contextIsolation` enabled and include `electron-preload.js` in the desktop build.
