        const SOUND_SETTINGS_STORAGE_KEY = 'alone_sound_settings';
        const DEFAULT_SOUND_SETTINGS = Object.freeze({ music: 1, effects: 1 });
        let soundSettings = { ...DEFAULT_SOUND_SETTINGS };
        let soundSettingsReturnScreen = null;

        function normalizeSoundSettings(value) {
            const normalizeVolume = (volume, fallback) =>
                typeof volume === 'number' && Number.isFinite(volume)
                    ? Math.max(0, Math.min(1, volume))
                    : fallback;
            return {
                music: normalizeVolume(value?.music, DEFAULT_SOUND_SETTINGS.music),
                effects: normalizeVolume(value?.effects, DEFAULT_SOUND_SETTINGS.effects)
            };
        }

        function setSoundSettingsStatus(message, isError = false) {
            const status = document.getElementById('sound-settings-status');
            if (!status) return;
            status.textContent = message;
            status.style.color = isError ? '#ff8888' : '#888';
        }

        function renderSoundSettingsControls() {
            for (const [key, id] of [['music', 'music-volume'], ['effects', 'effects-volume']]) {
                const input = document.getElementById(id);
                const output = document.getElementById(`${id}-value`);
                if (input) {
                    input.value = String(soundSettings[key]);
                    input.disabled = false;
                }
                if (output) output.value = `${Math.round(soundSettings[key] * 100)}%`;
            }
        }

        function applySoundSettings(settings) {
            soundSettings = normalizeSoundSettings(settings);
            for (const audio of TOKEN_PICKUP_AUDIO.values()) audio.volume = soundSettings.effects;
            renderSoundSettingsControls();
        }

        async function initializeSoundSettings() {
            try {
                let savedSettings;
                if (window.aloneDesktop) {
                    if (typeof window.aloneDesktop.sound?.getSettings !== 'function') {
                        throw new Error('This desktop version does not support saved sound settings. Update the launcher.');
                    }
                    savedSettings = await window.aloneDesktop.sound.getSettings();
                } else {
                    const saved = localStorage.getItem(SOUND_SETTINGS_STORAGE_KEY);
                    savedSettings = saved ? JSON.parse(saved) : DEFAULT_SOUND_SETTINGS;
                }
                applySoundSettings(savedSettings);
            } catch (error) {
                applySoundSettings(DEFAULT_SOUND_SETTINGS);
                setSoundSettingsStatus(`Could not load sound settings: ${error.message}`, true);
                console.error('Could not load sound settings:', error);
            }
        }

        const soundSettingsReady = initializeSoundSettings();

        function updateSoundSettingsFromControls() {
            applySoundSettings({
                music: Number(document.getElementById('music-volume').value),
                effects: Number(document.getElementById('effects-volume').value)
            });
            setSoundSettingsStatus('Unsaved changes.');
        }

        async function persistSoundSettings() {
            try {
                if (window.aloneDesktop) {
                    if (typeof window.aloneDesktop.sound?.setSettings !== 'function') {
                        throw new Error('This desktop version does not support saved sound settings. Update the launcher.');
                    }
                    await window.aloneDesktop.sound.setSettings({ ...soundSettings });
                    setSoundSettingsStatus('Saved on this computer.');
                } else {
                    localStorage.setItem(SOUND_SETTINGS_STORAGE_KEY, JSON.stringify(soundSettings));
                    setSoundSettingsStatus('Saved in this browser.');
                }
            } catch (error) {
                setSoundSettingsStatus(`Could not save sound settings: ${error.message}`, true);
                console.error('Could not save sound settings:', error);
            }
        }

        async function openSoundSettings() {
            soundSettingsReturnScreen = [...document.querySelectorAll('.screen')]
                .find(screen => screen.id !== 'sound-settings-screen' && getComputedStyle(screen).display !== 'none')
                || document.getElementById('main-menu');
            document.querySelectorAll('.screen').forEach(screen => { screen.style.display = 'none'; });
            document.getElementById('sound-settings-screen').style.display = 'flex';
            await soundSettingsReady;
            renderSoundSettingsControls();
        }

        function closeSoundSettings() {
            document.getElementById('sound-settings-screen').style.display = 'none';
            const returnScreen = soundSettingsReturnScreen || document.getElementById('main-menu');
            returnScreen.style.display = 'flex';
            soundSettingsReturnScreen = null;
        }

        function isOnlineActive() { return !!(gameSocket && gameSocket.readyState === WebSocket.OPEN); }
        function noteMusicActivity(type) {
            const now = performance.now();
            if (type === 'combat') lastMusicCombatAt = now;
            else if (type === 'work') lastMusicWorkAt = now;
        }
        function playGregVictoryMusic() {
            gregVictoryMusicRequested = true;
            soundtrackPlayFailed.delete('gregVictory');
        }
        function desiredSoundtrack(now = performance.now()) {
            if (document.hidden) return null;
            const menuIsVisible = MENU_SCREEN_IDS.some(id => {
                const screen = document.getElementById(id);
                return screen && getComputedStyle(screen).display !== 'none';
            });
            if (menuIsVisible) return 'menu';
            if (!['GAME', 'PLAYING'].includes(currentState) || isAnyOverlayActive() || player.isDowned) return null;
            if (gregVictoryMusicRequested) return 'gregVictory';
            const center = playerCenter();
            const gregNearby = currentLayer === 'caves' && mobs.some(mob =>
                mob.type === 'greg' && !mob.deathAt && Math.hypot(mobCenter(mob).x - center.x, mobCenter(mob).y - center.y) <= 900
            );
            if (gregNearby) return 'boss';
            const alphaWolfNearby = mobs.some(mob =>
                mob.type === 'alpha_wolf' && Math.hypot(mobCenter(mob).x - center.x, mobCenter(mob).y - center.y) <= 900
            );
            if (alphaWolfNearby) return 'alphaWolf';
            if (now - lastMusicCombatAt < MUSIC_COMBAT_HOLD_MS) {
                return currentSeason === 'winter' ? 'winterCombat' : 'mildCombat';
            }
            if (now - lastMusicWorkAt < MUSIC_WORK_HOLD_MS) {
                if (currentLayer === 'caves') return 'caveWork';
                return currentSeason === 'winter' ? 'winterWork' : 'mildWork';
            }
            return null;
        }
        function updateSoundtrack(dt) {
            const requested = desiredSoundtrack();
            const now = performance.now();
            const desired = requested && now >= (soundtrackCooldownUntil.get(requested) || 0)
                ? requested
                : null;
            const fadeStep = Math.max(0, dt) / 1.5;
            for (const [key, audio] of soundtrack) {
                const shouldPlay = key === desired && !soundtrackPlayFailed.has(key);
                if (shouldPlay && audio.paused && !soundtrackPlayPending.has(key)) {
                    soundtrackPlayPending.add(key);
                    Promise.resolve(audio.play()).then(() => {
                        if (desiredSoundtrack() === key) soundtrackStarted.add(key);
                        else {
                            audio.pause();
                            audio.currentTime = 0;
                        }
                    }).catch(error => {
                        soundtrackPlayFailed.add(key);
                        console.warn(`Could not play soundtrack "${SOUNDTRACK_FILES[key]}":`, error);
                    }).finally(() => soundtrackPlayPending.delete(key));
                }
                const audible = shouldPlay && soundtrackStarted.has(key);
                const targetVolume = audible ? 0.65 * soundSettings.music : 0;
                audio.volume = audio.volume < targetVolume
                    ? Math.min(targetVolume, audio.volume + fadeStep)
                    : Math.max(targetVolume, audio.volume - fadeStep);
                if (!shouldPlay && audio.volume === 0 && !audio.paused) {
                    audio.pause();
                    audio.currentTime = 0;
                    if (soundtrackStarted.delete(key)) {
                        if (!MUSIC_COOLDOWN_EXEMPT.has(key)) {
                            soundtrackCooldownUntil.set(key, now + MUSIC_TRACK_COOLDOWN_MS);
                        }
                    }
                }
            }
        }
        function retrySoundtrackAfterGesture() {
            soundtrackPlayFailed.clear();
            updateSoundtrack(0);
        }
        document.addEventListener('pointerdown', retrySoundtrackAfterGesture);
        document.addEventListener('keydown', retrySoundtrackAfterGesture);
