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
                audio.volume = audible
                    ? Math.min(0.65, audio.volume + fadeStep)
                    : Math.max(0, audio.volume - fadeStep);
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
