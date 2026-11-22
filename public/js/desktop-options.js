        let desktopOptionsReturnScreen = null;
        let desktopOptionsRefreshTimer = null;

        async function initializeDesktopOptions() {
            const desktopOnly = document.querySelectorAll('[data-desktop-only]');
            const webOnly = document.querySelectorAll('[data-web-only]');
            if (!window.aloneDesktop) {
                desktopOnly.forEach(element => { element.hidden = true; });
                webOnly.forEach(element => { element.hidden = false; });
                return;
            }

            desktopOnly.forEach(element => { element.hidden = false; });
            webOnly.forEach(element => { element.hidden = true; });
            document.getElementById('desktop-fullscreen').addEventListener('change', async event => {
                try {
                    await window.aloneDesktop.setFullscreen(event.target.checked);
                } catch (error) {
                    event.target.checked = !event.target.checked;
                    showDesktopOptionsError(error);
                }
            });
            document.getElementById('desktop-resolution').addEventListener('change', async event => {
                const [width, height] = event.target.value.split('x').map(Number);
                try {
                    await window.aloneDesktop.setWindowSize(width, height);
                } catch (error) {
                    showDesktopOptionsError(error);
                }
            });
            document.getElementById('desktop-discord').addEventListener('change', async event => {
                try {
                    const state = await window.aloneDesktop.setDiscordEnabled(event.target.checked);
                    renderDesktopOptions(state);
                } catch (error) {
                    event.target.checked = !event.target.checked;
                    showDesktopOptionsError(error);
                }
            });
            renderDesktopOptions(await window.aloneDesktop.getState());
            desktopOptionsRefreshTimer = window.setInterval(async () => {
                if (document.getElementById('desktop-options-screen').style.display !== 'none') {
                    try {
                        renderDesktopOptions(await window.aloneDesktop.getState());
                    } catch (error) {
                        showDesktopOptionsError(error);
                    }
                }
            }, 2000);
        }

        function renderDesktopOptions(state) {
            if (!state) return;
            const fullscreen = document.getElementById('desktop-fullscreen');
            const resolution = document.getElementById('desktop-resolution');
            const discord = document.getElementById('desktop-discord');
            fullscreen.checked = state.fullscreen;
            discord.checked = state.discordEnabled;

            const currentValue = `${state.width}x${state.height}`;
            let currentOption = [...resolution.options].find(option => option.value === currentValue);
            if (!currentOption) {
                currentOption = new Option(`${state.width} × ${state.height} (current)`, currentValue);
                currentOption.disabled = true;
                resolution.add(currentOption);
            }
            resolution.value = currentValue;

            const status = document.getElementById('desktop-discord-status');
            status.textContent = !state.discordEnabled
                ? 'Discord Rich Presence is off.'
                : state.discordConnected
                    ? 'Connected to Discord.'
                    : state.discordError || 'Waiting for the Discord desktop app...';
            status.style.color = state.discordConnected ? 'var(--success)' : state.discordError ? '#ff8888' : '#888';
        }

        function showDesktopOptionsError(error) {
            const status = document.getElementById('desktop-discord-status');
            if (status) {
                status.textContent = `Desktop setting failed: ${error.message}`;
                status.style.color = '#ff8888';
            }
            console.error('Desktop setting failed:', error);
        }

        function openDesktopOptions() {
            if (!window.aloneDesktop) return;
            desktopOptionsReturnScreen = [...document.querySelectorAll('.screen')]
                .find(screen => screen.id !== 'desktop-options-screen' && getComputedStyle(screen).display !== 'none')
                || document.getElementById('main-menu');
            document.querySelectorAll('.screen').forEach(screen => { screen.style.display = 'none'; });
            document.getElementById('desktop-options-screen').style.display = 'flex';
            window.aloneDesktop.getState().then(renderDesktopOptions).catch(showDesktopOptionsError);
            updateDesktopPresence('Viewing desktop options');
        }

        function closeDesktopOptions() {
            document.getElementById('desktop-options-screen').style.display = 'none';
            const returnScreen = desktopOptionsReturnScreen || document.getElementById('main-menu');
            returnScreen.style.display = 'flex';
            desktopOptionsReturnScreen = null;
            if (returnScreen.id === 'pause-screen') updateDesktopPresence('Paused');
            else if (['GAME', 'PLAYING'].includes(currentState)) {
                updateDesktopPresence(`${pendingMode === 'online' || pendingMode === 'online-create' ? 'Playing multiplayer' : 'Surviving solo'} · Day ${dayCount}`);
            } else updateDesktopPresence('In the main menu');
        }

        function updateDesktopPresence(state) {
            if (!window.aloneDesktop) return;
            window.aloneDesktop.setPresence(state).catch(error => {
                console.warn('Could not update Discord Rich Presence:', error);
            });
        }

        async function quitDesktopGame() {
            if (!window.aloneDesktop) return;
            if (['GAME', 'PLAYING', 'PAUSED'].includes(currentState)) {
                const saved = await saveGame(false, true);
                if (!saved && !confirm('The world could not be saved. Quit anyway?')) return;
            }
            await window.aloneDesktop.quit();
        }
