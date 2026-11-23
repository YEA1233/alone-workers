const launcherStatus = document.getElementById('launcher-status');
const discordStatus = document.getElementById('discord-status');
const latestLaunchButton = document.getElementById('latest-launch-button');
const aloneReleaseSelect = document.getElementById('alone-release-select');
const zombzReleaseSelect = document.getElementById('zombz-release-select');
const aloneLaunchButton = document.getElementById('alone-launch-button');
const zombzLaunchButton = document.getElementById('zombz-launch-button');
const fullscreenSetting = document.getElementById('fullscreen-setting');
const windowSizeSetting = document.getElementById('window-size-setting');
const themeSetting = document.getElementById('theme-setting');
const discordSetting = document.getElementById('discord-setting');
const startupSetting = document.getElementById('startup-setting');
const startupSettingRow = document.getElementById('startup-setting-row');
const updateStatus = document.getElementById('update-status');
const checkUpdatesButton = document.getElementById('check-updates-button');
const downloadUpdateButton = document.getElementById('download-update-button');
const installUpdateButton = document.getElementById('install-update-button');
const viewReleasesButton = document.getElementById('view-releases-button');
const setupDialog = document.getElementById('setup-dialog');
const setupForm = document.getElementById('setup-form');
const setupWindowSize = document.getElementById('setup-window-size');
const setupError = document.getElementById('setup-error');
let statusTimer;
let removeUpdateListener;
let releaseById = new Map();

function showStatus(message, isError = false) {
  launcherStatus.textContent = message;
  launcherStatus.style.color = isError ? '#ff8888' : '#9da3ad';
}

function versionOrder(left, right) {
  const a = left.version.split('.').map(Number);
  const b = right.version.split('.').map(Number);
  for (let index = 0; index < 4; index++) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return left.title.localeCompare(right.title);
}

async function launchRelease(releaseId, button, defaultLabel) {
  const release = releaseById.get(releaseId);
  if (!release) {
    showStatus('Choose a release first.', true);
    return;
  }
  button.disabled = true;
  button.textContent = 'STARTING…';
  showStatus(`Starting ${release.title} ${release.version}…`);
  try {
    await window.aloneDesktop.launchRelease(release.id);
    showStatus(`${release.title} ${release.version} is running. Close the game window to return here.`);
    window.aloneDesktop.setPresence(`Playing ${release.title} · ${release.version}`).catch(() => {});
  } catch (error) {
    showStatus(`Could not launch ${release.title} ${release.version}: ${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = defaultLabel;
  }
}

function renderReleases(releases) {
  const latest = releases.find(release => release.id === 'current');
  if (!latest) throw new Error('The current release is missing from the launcher catalog.');
  releaseById = new Map(releases.map(release => [release.id, release]));
  document.getElementById('latest-version-label').textContent = `CURRENT · ${latest.version}`;
  document.getElementById('launcher-version-label').textContent = latest.version;
  document.getElementById('latest-title').textContent = latest.title;
  document.getElementById('latest-description').textContent = latest.description;

  const archived = releases.filter(release => release.id !== 'current');
  const alone = archived.filter(release => release.title.startsWith('ALONE')).sort(versionOrder);
  const zombz = archived.filter(release => release.title.startsWith('ZOMBZ')).sort(versionOrder);
  const fillReleaseSelect = (select, items) => {
    select.replaceChildren(new Option('Select a release…', ''));
    for (const release of items) {
      select.add(new Option(`${release.version} · ${release.title}`, release.id));
    }
  };
  fillReleaseSelect(aloneReleaseSelect, alone);
  fillReleaseSelect(zombzReleaseSelect, zombz);
  aloneLaunchButton.disabled = true;
  zombzLaunchButton.disabled = true;
}

latestLaunchButton.addEventListener('click', () => launchRelease('current', latestLaunchButton, 'PLAY LATEST'));
aloneReleaseSelect.addEventListener('change', () => { aloneLaunchButton.disabled = !aloneReleaseSelect.value; });
zombzReleaseSelect.addEventListener('change', () => { zombzLaunchButton.disabled = !zombzReleaseSelect.value; });
aloneLaunchButton.addEventListener('click', () => launchRelease(aloneReleaseSelect.value, aloneLaunchButton, 'LAUNCH'));
zombzLaunchButton.addEventListener('click', () => launchRelease(zombzReleaseSelect.value, zombzLaunchButton, 'LAUNCH'));

function renderDesktopState(state) {
  updateWindowSizeOptions(windowSizeSetting, state.windowSizes, state.width, state.height);
  fullscreenSetting.checked = state.fullscreen;
  themeSetting.value = state.theme;
  document.documentElement.dataset.theme = state.theme;
  discordSetting.checked = state.discordEnabled;
  startupSetting.checked = state.launchAtStartup;
  startupSettingRow.hidden = !state.supportsLoginItem;
  discordStatus.textContent = !state.discordEnabled
    ? 'Discord Rich Presence is off.'
    : state.discordConnected
      ? 'Connected to Discord.'
      : state.discordError || 'Waiting for the Discord desktop app…';
  discordStatus.style.color = state.discordConnected ? '#2ecc71' : state.discordError ? '#ff8888' : '#8d929c';
  renderUpdateStatus(state.updateStatus);
}

function updateWindowSizeOptions(select, sizes, selectedWidth, selectedHeight) {
  const selected = `${selectedWidth}x${selectedHeight}`;
  const options = sizes.map(size => new Option(`${size.width} × ${size.height}`, `${size.width}x${size.height}`));
  if (!sizes.some(size => `${size.width}x${size.height}` === selected)) {
    const option = new Option(`${selectedWidth} × ${selectedHeight} (current)`, selected);
    option.disabled = true;
    options.push(option);
  }
  select.replaceChildren(...options);
  select.value = selected;
}

function renderUpdateStatus(state) {
  if (!state) return;
  updateStatus.textContent = state.message;
  checkUpdatesButton.disabled = state.status === 'checking' || state.status === 'downloading';
  downloadUpdateButton.hidden = state.status !== 'available';
  installUpdateButton.hidden = state.status !== 'downloaded';
  viewReleasesButton.hidden = state.status !== 'manual';
}

function openSetupWizard(state) {
  updateWindowSizeOptions(setupWindowSize, state.windowSizes, state.width, state.height);
  document.getElementById('setup-theme').value = state.theme;
  document.getElementById('setup-fullscreen').checked = state.fullscreen;
  document.getElementById('setup-startup').checked = state.launchAtStartup;
  document.getElementById('setup-startup-row').hidden = !state.supportsLoginItem;
  setupDialog.showModal();
}

async function updateDesktopState() {
  try {
    renderDesktopState(await window.aloneDesktop.getState());
  } catch (error) {
    showStatus(`Could not read launcher settings: ${error.message}`, true);
  }
}

fullscreenSetting.addEventListener('change', async () => {
  try {
    renderDesktopState(await window.aloneDesktop.setFullscreen(fullscreenSetting.checked));
  } catch (error) {
    showStatus(`Could not change fullscreen: ${error.message}`, true);
    await updateDesktopState();
  }
});

windowSizeSetting.addEventListener('change', async () => {
  const [width, height] = windowSizeSetting.value.split('x').map(Number);
  try {
    renderDesktopState(await window.aloneDesktop.setWindowSize(width, height));
  } catch (error) {
    showStatus(`Could not change game window size: ${error.message}`, true);
    await updateDesktopState();
  }
});

themeSetting.addEventListener('change', async () => {
  try {
    renderDesktopState(await window.aloneDesktop.setTheme(themeSetting.value));
  } catch (error) {
    showStatus(`Could not change theme: ${error.message}`, true);
    await updateDesktopState();
  }
});

startupSetting.addEventListener('change', async () => {
  try {
    renderDesktopState(await window.aloneDesktop.setLaunchAtStartup(startupSetting.checked));
  } catch (error) {
    showStatus(`Could not change startup setting: ${error.message}`, true);
    await updateDesktopState();
  }
});

discordSetting.addEventListener('change', async () => {
  try {
    await window.aloneDesktop.setDiscordEnabled(discordSetting.checked);
    await updateDesktopState();
  } catch (error) {
    showStatus(`Could not change Discord Rich Presence: ${error.message}`, true);
    await updateDesktopState();
  }
});

setupDialog.addEventListener('cancel', event => event.preventDefault());
setupForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submitButton = setupForm.querySelector('button[type="submit"]');
  const [width, height] = setupWindowSize.value.split('x').map(Number);
  setupError.textContent = '';
  submitButton.disabled = true;
  try {
    const state = await window.aloneDesktop.completeSetup({
      width,
      height,
      theme: document.getElementById('setup-theme').value,
      fullscreen: document.getElementById('setup-fullscreen').checked,
      launchAtStartup: document.getElementById('setup-startup').checked
    });
    renderDesktopState(state);
    setupDialog.close();
    showStatus('Setup complete. Choose a release to start playing.');
  } catch (error) {
    setupError.textContent = `Could not save setup: ${error.message}`;
  } finally {
    submitButton.disabled = false;
  }
});

checkUpdatesButton.addEventListener('click', async () => {
  renderUpdateStatus({ status: 'checking', message: 'Checking for launcher updates…' });
  try {
    renderUpdateStatus(await window.aloneDesktop.checkForUpdates());
  } catch (error) {
    renderUpdateStatus({ status: 'error', message: `Update check failed: ${error.message}` });
  }
});

downloadUpdateButton.addEventListener('click', async () => {
  try {
    renderUpdateStatus(await window.aloneDesktop.downloadUpdate());
  } catch (error) {
    renderUpdateStatus({ status: 'error', message: `Update download failed: ${error.message}` });
  }
});

installUpdateButton.addEventListener('click', async () => {
  try {
    await window.aloneDesktop.installUpdate();
  } catch (error) {
    renderUpdateStatus({ status: 'downloaded', message: error.message });
  }
});

viewReleasesButton.addEventListener('click', async () => {
  try {
    await window.aloneDesktop.openReleasePage();
  } catch (error) {
    renderUpdateStatus({ status: 'error', message: `Could not open GitHub Releases: ${error.message}` });
  }
});

document.getElementById('quit-button').addEventListener('click', () => {
  window.aloneDesktop.quit();
});

async function initializeLauncher() {
  try {
    renderReleases(await window.aloneDesktop.listReleases());
    const state = await window.aloneDesktop.getState();
    renderDesktopState(state);
    if (!state.setupComplete) openSetupWizard(state);
    window.aloneDesktop.setPresence('Browsing game versions').catch(() => {});
    removeUpdateListener = window.aloneDesktop.onUpdateStatus(renderUpdateStatus);
    statusTimer = window.setInterval(updateDesktopState, 2500);
  } catch (error) {
    showStatus(`Launcher failed to load: ${error.message}`, true);
  }
}

window.addEventListener('beforeunload', () => {
  window.clearInterval(statusTimer);
  removeUpdateListener?.();
});
initializeLauncher();
