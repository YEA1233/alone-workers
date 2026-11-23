        function showInitialize() {
            document.querySelectorAll('.screen').forEach(screen => screen.style.display = 'none');
            document.getElementById('init-choice').style.display = 'flex';
            document.getElementById('online-name').value = onlineName || player.name || 'SURVIVOR';
            updatePlayerEmojiButton();
            updateDesktopPresence('In the main menu');
        }
        function prepareSettings(mode = 'solo') {
            pendingMode = mode;
            document.getElementById('init-choice').style.display = 'none';
            document.getElementById('world-slots-screen').style.display = 'none';
            document.getElementById('world-settings-screen').style.display = 'flex';
            document.getElementById('room-creation-settings').style.display = mode === 'online-create' ? 'block' : 'none';
            document.getElementById('world-type').value = 'solo';
            document.getElementById('world-name').value = '';
            document.getElementById('set-first-person-3d').checked = false;
            document.getElementById('set-world-seed').value = '';
            seedSettingsLocked = false;
            updateOverrideAvailability();
        }
        function cancelSettings() { resetGame(); }
        function showOnlineProfile() {
            document.querySelectorAll('.screen').forEach(screen => screen.style.display = 'none');
            document.getElementById('room-browser-screen').style.display = 'flex';
            onlineName = document.getElementById('online-name').value.trim() || player.name || 'SURVIVOR';
            player.name = onlineName;
            player.emoji = document.getElementById('play-emoji').dataset.emoji || player.emoji;
            refreshRooms();
        }
        async function continueToRooms() {
            showOnlineProfile();
            await refreshRooms();
        }
        function startRoomCreation() {
            document.getElementById('world-slots-screen').style.display = 'none';
            const mode = slotEntryMode === 'host' ? 'online-create' : 'solo';
            prepareSettings(mode);
            document.getElementById('world-type').value = mode === 'online-create' ? 'public' : 'solo';
            updateOverrideAvailability();
        }
        async function showWorldSlots(mode) {
            slotEntryMode = mode;
            onlineName = document.getElementById('online-name').value.trim() || 'SURVIVOR';
            player.name = onlineName;
            player.emoji = document.getElementById('play-emoji').dataset.emoji || player.emoji;
            document.querySelectorAll('.screen').forEach(screen => screen.style.display = 'none');
            document.getElementById('world-slots-title').textContent = mode === 'host' ? 'HOST A WORLD' : 'YOUR SOLO WORLDS';
            document.getElementById('world-slots-screen').style.display = 'flex';
            const list = document.getElementById('world-slots-list');
            list.textContent = 'Loading saved worlds...';
            try {
                const slots = await listSaveSlots();
                list.replaceChildren();
                if (!slots.length) {
                    const empty = document.createElement('p');
                    empty.textContent = 'No saved worlds yet. Create a world to get started.';
                    list.appendChild(empty);
                    return;
                }
                for (const slot of slots) {
                    const row = document.createElement('div');
                    row.className = 'setting-item';
                    const info = document.createElement('span');
                    info.textContent = `${slot.slotName || 'World'} · Day ${slot.dayCount || 1}`;
                    row.appendChild(info);
                    const start = document.createElement('button');
                    start.className = 'menu-btn primary';
                    start.textContent = mode === 'host' ? 'HOST' : 'PLAY';
                    start.onclick = () => mode === 'host'
                        ? hostSavedWorld(slot.slotId, slot)
                        : loadGame(slot.slotId);
                    row.appendChild(start);
                    const remove = document.createElement('button');
                    remove.className = 'menu-btn';
                    remove.textContent = 'DELETE';
                    remove.onclick = async () => {
                        if (!confirm(`Delete "${slot.slotName || 'World'}" permanently?`)) return;
                        await deleteSaveSlot(slot.slotId);
                        showWorldSlots(mode);
                    };
                    row.appendChild(remove);
                    list.appendChild(row);
                }
            } catch (error) {
                list.textContent = `Could not load saved worlds: ${error.message}`;
            }
        }
        async function refreshRooms() {
            const list = document.getElementById('public-room-list');
            if (!list) return;
            list.innerText = 'Loading rooms...';
            try {
                const response = await fetch(`${GAME_SERVER_URL.replace(/^wss:/, 'https:')}?rooms=public`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const rooms = await response.json();
                list.innerHTML = '';
                if (!rooms.length) { list.innerText = 'No public games found.'; return; }
                rooms.forEach(room => { const button = document.createElement('button'); button.className = 'blueprint-tab'; button.style.width = '100%'; button.style.textAlign = 'left'; button.innerText = `${room.official ? '★ ' : ''}${room.name}  (${room.players || 0}/${room.maxPlayers || 16})`; if (room.official) { button.style.borderColor = 'var(--gold)'; button.style.color = 'var(--gold)'; } button.onclick = () => joinRoom(room.code, 'public'); list.appendChild(button); });
            } catch (error) { console.error('Room list failed:', error); list.innerText = `Room list unavailable (${error.message}).`; }
        }
        function joinPrivateRoom() { const code = document.getElementById('private-room-code').value.trim().toUpperCase(); if (/^[A-Z0-9]{6}$/.test(code)) joinRoom(code, 'private'); else document.getElementById('public-room-list').innerText = 'Enter a six-character code.'; }
        function joinRoom(code, visibility = 'private') { onlineRoom = code; pendingVisibility = visibility; pendingMode = 'online'; document.getElementById('room-browser-screen').style.display = 'none'; document.getElementById('online-room-code').innerText = `ROOM CODE: ${onlineRoom}`; document.getElementById('online-room-code').style.display = 'block'; worldConfig = { ...worldConfig, creative: false }; worldSeed = Math.floor(Math.random() * 1000000); player.hp = 100; player.hunger = 100; startGameUI(); currentState = 'PLAYING'; connectToGameServer(); }
        async function hostSavedWorld(slotId, slot) {
            try {
                const save = await readSaveData(slotId);
                if (!save) throw new Error('Saved world not found.');
                const seed = String(save.seedString || '').toUpperCase();
                if (!seed) throw new Error('This save has no reusable world seed. Load it solo and save it again first.');
                pendingWorldImport = save;
                activeSaveSlotId = slotId;
                activeSaveSlotName = slot.slotName || 'World';
                currentWorldSeed = seed;
                worldConfig = { ...worldConfig, ...save.config };
                document.getElementById('world-slots-screen').style.display = 'none';
                prepareSettings('online-create');
                document.getElementById('world-name').value = activeSaveSlotName;
                document.getElementById('world-type').value = 'public';
                updateOverrideAvailability();
                document.getElementById('set-first-person-3d').checked = !!(worldConfig.firstPerson3D ?? worldConfig.thirdPerson3D);
                document.getElementById('set-winter-days').value = worldConfig.winterLengthDays ?? 8;
                document.getElementById('set-mild-days').value = worldConfig.mildLengthDays ?? 8;
                document.getElementById('set-world-seed').value = formatWorldSeed(seed);
                handleSeedInput();
                pendingMode = 'online-create';
                onlineName = document.getElementById('online-name').value.trim() || player.name || 'SURVIVOR';
                player.name = onlineName;
                player.emoji = document.getElementById('play-emoji').dataset.emoji || player.emoji;
            } catch (error) {
                pendingWorldImport = null;
                alert(`Could not host saved world: ${error.message}`);
            }
        }
        function showTutorial() { document.getElementById('main-menu').style.display = 'none'; document.getElementById('tutorial-screen').style.display = 'flex'; }
        function hideTutorial() { document.getElementById('tutorial-screen').style.display = 'none'; document.getElementById('main-menu').style.display = 'flex'; }
        function showNews() {
            document.getElementById('main-menu').style.display = 'none';
            document.getElementById('news-screen').style.display = 'flex';
            filterNews();
        }
        function hideNews() { document.getElementById('news-screen').style.display = 'none'; document.getElementById('main-menu').style.display = 'flex'; }
        function filterNews() {
            const query = document.getElementById('news-search').value.trim().toLocaleLowerCase();
            const type = document.getElementById('news-type-filter').value;
            let visibleCount = 0;
            document.querySelectorAll('#news-screen .news-article').forEach(article => {
                const matches = (type === 'all' || article.dataset.updateType === type) &&
                    article.textContent.toLocaleLowerCase().includes(query);
                article.hidden = !matches;
                if (matches) visibleCount++;
            });
            document.querySelectorAll('#news-screen .news-group').forEach(group => {
                group.hidden = !Array.from(group.querySelectorAll('.news-article')).some(article => !article.hidden);
            });
            document.getElementById('news-no-results').style.display = visibleCount ? 'none' : 'block';
        }
        function confirmSettings() {
            try {
                if (document.getElementById('world-type').value !== 'solo' &&
                    document.getElementById('set-override-limits').checked) {
                    throw new Error('Slider limit overrides are only available for solo worlds.');
                }

                const seedInput =
                    document.getElementById('set-world-seed');

                let enteredSeed =
                    seedInput?.value
                        ?.toUpperCase()
                        .replace(/[^A-Z0-9]/g, '') || '';

                // A manually entered seed supplies its encoded settings. Generated seeds
                // retain the settings currently shown in the controls.

                const getVal = (id) => {
                    const el = document.getElementById(id);
                    if (!el) throw new Error(`Could not find the setting element with ID: "${id}"`);
                    const num = parseFloat(el.value);
                    if (!Number.isFinite(num)) throw new Error(`The field "${id}" has an invalid or blank number.`);
                    return num;
                };

                if (enteredSeed.length > 0 && seedSettingsLocked) {

                    if (
                        enteredSeed.length !==
                        SEED_TOTAL_LENGTH
                    ) {
                        throw new Error(
                            `World seed must contain exactly ${SEED_TOTAL_LENGTH} characters.`
                        );
                    }

                    worldConfig =
                        decodeWorldSettings(enteredSeed);
                    worldConfig.winterLengthDays = getVal('set-winter-days');
                    worldConfig.mildLengthDays = getVal('set-mild-days');

                    currentWorldSeed =
                        enteredSeed;

                    console.log(
                        "SETTINGS LOADED FROM SEED:",
                        worldConfig
                    );

                } else {

                    // Read the current controls so generated or stale seeds cannot replace them.

                    const getSelectVal = (id) => {

                        const el =
                            document.getElementById(id);

                        return el
                            ? el.value
                            : 'standard';
                    };


                    worldConfig = {

                        resMult:
                            getVal('set-res'),

                        foodMult:
                            getVal('set-food'),

                        dayMult:
                            getVal('set-day'),

                        nightMult:
                            getVal('set-night'),

                        hungerMult:
                            getVal('set-hunger'),

                        worldSizeMult:
                            getVal('set-world-size'),

                        mapPreset:
                            getSelectVal(
                                'set-map-preset'
                            ),

                        oceanMult:
                            getVal('set-ocean'),

                        forestMult:
                            getVal('set-forest'),

                        mountainMult:
                            getVal('set-mountain'),
                        cavesEnabled:
                            document.getElementById('set-caves')?.checked !== false,

                        wildlifeMult:
                            getVal('set-wildlife'),

                ruinsMult:
                    getVal('set-ruins'),
                winterLengthDays:
                    getVal('set-winter-days'),
                mildLengthDays:
                    getVal('set-mild-days'),

                        creative:
                            document.getElementById(
                                'set-creative'
                            )?.checked || false
                    };


                    // =================================================
                    // GENERATE A SEED FROM THESE SETTINGS
                    // =================================================

                    const previousRandomPart = enteredSeed.length === SEED_TOTAL_LENGTH
                        ? enteredSeed.substring(SEED_SETTINGS_LENGTH)
                        : randomSeedPart(SEED_RANDOM_LENGTH);
                    enteredSeed = encodeWorldSettings() + previousRandomPart;

                    currentWorldSeed =
                        enteredSeed;


                    if (seedInput) {
                        seedInput.value =
                            formatWorldSeed(
                                enteredSeed
                            );
                    }
                }


                // =====================================================
                // VALIDATION
                // =====================================================

                if (
                    worldConfig.worldSizeMult <= 0
                ) {
                    throw new Error(
                        "WORLD SIZE must be greater than 0."
                    );
                }

                if (
                    worldConfig.forestMult < 0 ||
                    worldConfig.mountainMult < 0 ||
                    worldConfig.resMult < 0
                ) {
                    throw new Error(
                        "Density and multiplier values cannot be negative."
                    );
                }


                // =====================================================
                // DIMENSIONS
                // =====================================================

                if (
                    typeof updateWorldDimensions ===
                    'function'
                ) {
                    updateWorldDimensions();
                }


                if (
                    typeof ROWS === 'undefined' ||
                    typeof COLS === 'undefined' ||
                    isNaN(ROWS) ||
                    isNaN(COLS) ||
                    ROWS <= 0 ||
                    COLS <= 0
                ) {
                    throw new Error(
                        `Map dimensions broke! ROWS: ${ROWS}, COLS: ${COLS}`
                    );
                }


                console.log(
                    "FINAL WORLD CONFIG:",
                    worldConfig
                );

                console.log(
                    "FINAL WORLD SEED:",
                    formatWorldSeed(
                        currentWorldSeed
                    )
                );


                // =====================================================
                // START GENERATION
                // =====================================================
                const worldType = document.getElementById('world-type')?.value || 'solo';
                worldConfig.firstPerson3D = worldType !== 'solo' && document.getElementById('set-first-person-3d')?.checked === true;
                const importedWorldIsDisabled = !!pendingWorldImport?.achievementsDisabled || !!pendingWorldImport?.config?.creative;
                if ((worldConfig.creative || importedWorldIsDisabled) &&
                    !confirm('Cheats or prior admin-console use disable achievements for this world. Continue?')) return;
                setFirstPersonMode(false);
                player.emoji = document.getElementById('play-emoji')?.dataset.emoji || player.emoji;
                onlineName = document.getElementById('online-name')?.value.trim() || player.name || 'SURVIVOR';
                player.name = onlineName;
                if (pendingWorldImport && worldType === 'solo') {
                    const save = pendingWorldImport;
                    pendingWorldImport = null;
                    document.getElementById('world-settings-screen').style.display = 'none';
                    applySave(save, true);
                    return;
                }
                if (!pendingWorldImport) activeSaveSlotId = crypto.randomUUID();
                activeSaveSlotName = document.getElementById('world-name')?.value.trim() || activeSaveSlotName || 'My World';
                if (worldType !== 'solo') {
                    pendingMode = 'online-create';
                    pendingVisibility = worldType === 'private' ? 'private' : 'public';
                    activeAchievementWorldKey = '';
                    worldAchievementsDisabled = false;
                } else {
                    pendingMode = 'solo';
                    pendingWorldImport = null;
                    soloTokenInventory = { ivory: 0, wolf: 0 };
                    soloTokenDrops = { ivory: false, wolf: false };
                    setAchievementWorld('solo', activeSaveSlotId, !!worldConfig.creative);
                    gregArenaLocked = false;
                    initializeSoloSeason();
                }
                if (pendingMode === 'online-create') {
                    const status = document.getElementById('creation-status');
                    if (status) { status.style.color = '#ffcc00'; status.innerText = 'CREATING ROOM...'; }
                    createOnlineRoom();
                    return;
                }

                const screen =
                    document.getElementById(
                        'world-settings-screen'
                    );

                if (screen) {
                    screen.style.display = 'none';
                }

                generateOrganicMap();


            } catch (error) {

                alert(
                    `❌ INITIALIZATION STOPPED:\n\n` +
                    `${error.message}\n\n` +
                    `Your game did not freeze.`
                );
            }
        }
        function decodeWorldSettings(seed) {
            seed = seed
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '');

            if (seed.length !== SEED_TOTAL_LENGTH) {
                throw new Error(
                    `Invalid seed length. Expected ${SEED_TOTAL_LENGTH} characters.`
                );
            }

            const settingsPart =
                seed.substring(0, SEED_SETTINGS_LENGTH);

            const indexes =
                settingsPart.split('').map(char => {
                    const index = SEED_CHARS.indexOf(char);

                    if (index < 0) {
                        throw new Error(
                            `Invalid seed character: ${char}`
                        );
                    }

                    return index;
                });

            const presets = [
                'standard',
                'inland',
                'dry',
                'riverlands',
                'islands'
            ];

            return {
                resMult: 0.2 + indexes[0] * 0.2,
                foodMult: 0.2 + indexes[1] * 0.2,
                dayMult: 0.5 + indexes[2] * 0.5,
                nightMult: 0.5 + indexes[3] * 0.5,
                hungerMult: 0.2 + indexes[4] * 0.2,
                worldSizeMult: 0.75 + indexes[5] * 0.25,
                mapPreset: presets[indexes[6]] || 'standard',
                oceanMult: 0.5 + indexes[7] * 0.1,
                forestMult: 0.2 + indexes[8] * 0.1,
                mountainMult: 0.2 + (indexes[9] % 24) * 0.1,
                cavesEnabled: indexes[9] < 24,
                wildlifeMult: indexes[10] * 0.25,

                // 12th character: bit 0 = creative, the rest = ruin density (old 'A' / 'B' mean normal ruins).
        creative: (indexes[11] & 1) === 1,
        ruinsMult: (((indexes[11] >> 1) + 4) % 16) * 0.25
            };
        }
        async function readRoomSavePayload() {
            const fileInput = document.getElementById('room-save-file-input');
            if (!fileInput || !fileInput.files || !fileInput.files[0]) return createSaveData();
            const file = fileInput.files[0];
            try {
                const text = await file.text();
                return JSON.parse(text);
            } catch (error) {
                throw new Error(`Could not read room save: ${error.message}`);
            }
        }

        function reportConnectFailure(message) {
            if (currentState !== 'MENU') return;
            setConnectionStatus(message, '#ff4444');
            const creation = document.getElementById('creation-status');
            if (creation) { creation.style.color = '#ff4444'; creation.innerText = message; }
        }

        function watchConnection() {
            const ws = gameSocket;
            if (!ws) return;
            ws.addEventListener('error', () => {
                if (ws === gameSocket) reportConnectFailure('COULD NOT REACH THE GAME SERVER');
            });
            ws.addEventListener('close', event => {
                if (ws !== gameSocket) return;
                if (currentState === 'MENU') {
                    reportConnectFailure(event.reason ? `DISCONNECTED: ${event.reason}` : 'COULD NOT CONNECT TO THE GAME SERVER');
                    return;
                }
                displayChat({ name: 'SYSTEM', text: 'Disconnected from the server. Returning to the menu...', color: '#ff4444' });
                setTimeout(() => { if (ws === gameSocket) resetGame(); }, 3000);
            });
        }

        function joinRoom(code, visibility = 'private') {
            onlineRoom = code;
            worldConfig = { ...worldConfig, creative: false };
            setAchievementWorld('online', code);
            pendingVisibility = visibility;
            pendingMode = 'online';
            document.getElementById('online-room-code').innerText = `ROOM CODE: ${onlineRoom}`;
            player.hp = 100;
            player.hunger = 100;
            setConnectionStatus('CONNECTING...', '#ffcc00');
            connectToGameServer();      // the room browser stays up until the server's room:init arrives
            watchConnection();
        }

        async function createOnlineRoom() {
            const status = document.getElementById('creation-status');
            const fail = message => { if (status) { status.style.color = '#ff4444'; status.innerText = message; } };
            try {
                const fileInput = document.getElementById('room-save-file-input');
                let saveData = null;
                if (fileInput && fileInput.files && fileInput.files[0]) saveData = await readRoomSavePayload();
                if ((saveData?.achievementsDisabled || saveData?.config?.creative) &&
                    !confirm('This saved world has cheats enabled or has used the admin console. Achievements will be disabled in its hosted world. Continue?')) return;

                const response = await fetch(`${GAME_SERVER_URL.replace(/^wss:/, 'https:')}?create=room`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: document.getElementById('world-name')?.value.trim() || activeSaveSlotName || `${onlineName}'s game`,
                        visibility: pendingVisibility || 'public',
                        seed: currentWorldSeed
                    })
                });
                const room = await response.json();
                if (!response.ok) throw new Error(room.error || 'Could not create room.');

                onlineRoom = room.code;
                setAchievementWorld('online', onlineRoom);
                pendingVisibility = room.visibility;
                document.getElementById('creation-code-preview').innerText =
                    room.visibility === 'private' ? `PRIVATE CODE: ${room.code}` : 'PUBLIC GAME';
                if (saveData && saveData.player && Array.isArray(saveData.player.inventory)) {
                    player.inventory = saveData.player.inventory.map(slot => ({ ...slot }));   // only your items carry over
                }
                player.hp = 100;
                player.hunger = 100;
                document.getElementById('online-room-code').innerText = `ROOM CODE: ${room.code}`;
                if (status) { status.style.color = '#ffcc00'; status.innerText = 'CONNECTING...'; }

                connectToGameServer();
                watchConnection();
            } catch (error) {
                fail(`ROOM ERROR: ${error.message}`);
                console.error('CREATE ONLINE ROOM ERROR:', error);
            }
        }
        function startGameUI() {
            clearPlayerThoughts();
            document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
            const isOnline = pendingMode === 'online' || pendingMode === 'online-create';
            updateDesktopPresence(`${isOnline ? 'Playing multiplayer' : 'Surviving solo'} · Day ${dayCount}`);
            if (!isOnline && !Number.isInteger(alphaWolfStartDay)) alphaWolfStartDay = 9 + Math.floor(Math.random() * 4);
            ['hud', 'inventory-container', 'utility-bar', 'top-controls', 'clock-container'].forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                el.style.display = id === 'clock-container' ? 'block' : 'flex';
            });
            const chatBox = document.getElementById('chat-box');
            if (chatBox) chatBox.style.display = isOnline ? 'block' : 'none';
            const roomCode = document.getElementById('online-room-code');
            if (roomCode) roomCode.style.display = isOnline && onlineRoom ? 'block' : 'none';
            const creativeBtn = document.getElementById('creative-btn');
            if (creativeBtn) creativeBtn.style.display = (worldConfig.creative && !isOnline) || creativePanelEnabled ? '' : 'none';
            const invulnerabilityControl = document.getElementById('cp-invulnerable');
            if (invulnerabilityControl) invulnerabilityControl.checked = player.creativeInvulnerable !== false;
            const onlineSaveButton = document.getElementById('save-multiplayer-slot-btn');
            if (onlineSaveButton) onlineSaveButton.style.display = isOnline ? '' : 'none';
        }

        function renderInventory() {
            const bar = document.getElementById('inventory-bar');
            if (!bar) return;
            bar.innerHTML = '';

            player.inventory.forEach((slot, index) => {
                const div = document.createElement('div'); div.className = `inv-slot ${index === selectedHotbarIndex ? 'selected' : ''}`;
                div.onclick = () => invClick(index);
                if (slot?.type) div.title = itemTooltipText(slot.type, slot);
                div.innerHTML = `<span class="slot-number">${index + 1}</span>`;
                if (slot && slot.type) {
                    div.innerHTML += `<span>${ITEM_ICONS[slot.type] || '❓'}</span><span class="count">${slot.count}</span><div class="dur-bar"></div>`;
                    if (slot.type === 'thermal_stone') {
                        div.insertAdjacentHTML('beforeend', `<span class="thermal-status">${thermalStoneStatus(slot.thermalTemp).icon}</span>`);
                    }
                    if (slot.maxDuration > 0) {
                        div.querySelector('.dur-bar').style.width = Math.max(0, slot.duration / slot.maxDuration * 100) + '%';
                    }
                }
                bar.appendChild(div);
            });
            renderShieldSlot();
        }

        function renderShieldSlot() {
            const slot = document.getElementById('shield-slot');
            if (!slot) return;
            const shield = normalizeShieldData(player.shield);
            player.shield = shield;
            slot.className = 'inv-slot shield-slot';
            slot.innerHTML = '';
            if (!shield) {
                slot.innerHTML = '<span style="font-size:0.65rem;color:#666;">EMPTY</span>';
                slot.title = 'Shield slot — click to unequip';
                return;
            }
            const stats = SHIELD_STATS[shield.type];
            slot.title = `${stats.name}: ${Math.ceil(shield.durability)}/${stats.durability} durability. Click to unequip.`;
            slot.innerHTML = `<span>${ITEM_ICONS[shield.type]}</span><div class="dur-bar"></div>`;
            slot.querySelector('.dur-bar').style.width = `${shield.durability / stats.durability * 100}%`;
        }

        function clickShieldSlot() {
            if (!player.shield) return;
            if (isOnlineActive()) {
                sendWorldAction('equip_shield', { slot: null });
                return;
            }
            const emptyIndex = player.inventory.findIndex(slot => !slot.type);
            if (emptyIndex < 0) {
                displayChat({ name: 'SYSTEM', text: 'Your inventory is full.', color: '#ffa500' });
                return;
            }
            const shield = normalizeShieldData(player.shield);
            player.inventory[emptyIndex] = { type: shield.type, count: 1, duration: shield.durability, maxDuration: shield.maxDurability };
            player.shield = null;
            renderInventory();
        }

        function equipShieldFromInventory(index) {
            if (isOnlineActive()) {
                sendWorldAction('equip_shield', { slot: index });
                return;
            }
            const item = player.inventory[index];
            const stats = SHIELD_STATS[item?.type];
            if (!stats) return;
            const previousShield = normalizeShieldData(player.shield);
            player.shield = normalizeShieldData({ type: item.type, durability: item.duration });
            player.inventory[index] = previousShield
                ? { type: previousShield.type, count: 1, duration: previousShield.durability, maxDuration: previousShield.maxDurability }
                : { type: null, count: 0, duration: 0, maxDuration: 0 };
            renderInventory();
        }

        function selectHotbar(index) {
            selectedHotbarIndex = (index + player.inventory.length) % player.inventory.length;
            renderInventory();
        }

        function invClick(index) {
            let slot = player.inventory[index];
            if (!slot || !slot.type) return;
            if (SHIELD_STATS[slot.type]) { equipShieldFromInventory(index); return; }
            const held = getActiveItem();
            if (held?.type === 'amber' && slot.type === 'lantern') {
                if (isOnlineActive()) {
                    sendWorldAction('lantern_refuel', { lanternSlot: index, amberSlot: selectedHotbarIndex });
                    return;
                }
                if (held.count < 1) return;
                if ((slot.duration || 0) >= slot.maxDuration) {
                    displayChat({ name: 'SYSTEM', text: 'That lantern is already full.', color: '#ffa500' });
                    return;
                }
                held.count--;
                if (held.count <= 0) Object.assign(held, { type: null, count: 0, duration: 0, maxDuration: 0 });
                slot.duration = Math.min(slot.maxDuration, Math.max(0, slot.duration || 0) + 2 * 60 * 60);
                renderInventory();
                displayChat({ name: 'SYSTEM', text: 'Lantern refueled with 2 minutes of light.', color: '#ffcc66' });
                return;
            }
            if (['berries', 'carrots', 'paste'].includes(slot.type)) { consume(index); return; }
            selectHotbar(index);
        }

        function getActiveItem() { return player.inventory[selectedHotbarIndex]; }

        function normalizeInventory() {
            player.inventory.forEach(slot => {
                const data = BUILDINGS[slot.type];
                const duration = data?.durability || data?.duration;
                if (duration && !slot.maxDuration) {
                    slot.count = 1;
                    slot.duration = duration;
                    slot.maxDuration = duration;
                }
            });
        }
        function updatePauseWorldSeed() {

            const element =
                document.getElementById(
                    'pause-world-seed'
                );

            if (!element) return;

            element.textContent =
                formatWorldSeed(currentWorldSeed);
        }
        async function copyWorldSeed() {

            if (!currentWorldSeed) return;

            try {

                await navigator.clipboard.writeText(
                    currentWorldSeed
                );

            } catch (err) {

                console.warn(
                    'Could not copy world seed:',
                    err
                );
            }
        }
        function useToolDurability() {
            const item = getActiveItem();
            if (worldConfig.creative || !item || !item.type || !item.maxDuration) return;
            item.duration--;
            if (item.duration <= 0) {
                displayChat({ name: 'SYSTEM', text: `Your ${item.type} broke.`, color: '#f00' });
                item.type = null; item.count = 0; item.duration = 0; item.maxDuration = 0;
            } else if (item.duration <= item.maxDuration * 0.2) {
                displayChat({ name: 'SYSTEM', text: `Your ${item.type} is almost broken.`, color: '#ffa500' });
            }
            renderInventory();
        }

        function addToInv(type, amount) {
            const data = BUILDINGS[type];
            const nonStackable = type === 'thermal_stone' || !!SHIELD_STATS[type];
            let slot = nonStackable ? null : player.inventory.find(s => s.type === type);
            if (slot && !data?.duration && !data?.durability) {
                slot.count += amount;
            } else {
                let empty = player.inventory.find(s => s.type === null);
                if (empty) {
                    empty.type = type;
                    empty.count = amount;
                    if (data?.duration || data?.durability) {
                        empty.duration = data.duration || data.durability;
                        empty.maxDuration = data.duration || data.durability;
                    }
                    if (nonStackable) empty.thermalTemp = 0;
                }
            }
            renderInventory();
        }

        function consume(index) {
            let slot = player.inventory[index];
            if (!slot || !slot.type) return;
            if (isOnlineActive()) { sendWorldAction('eat', { slot: index }); return; }
            let fName = String(slot.type);
            player.hunger = Math.min(100, player.hunger + (slot.type === 'paste' ? 30 : 15));
            player.hp = Math.min(100, player.hp + (slot.type === 'paste' ? 10 : 5));
            displayChat({ name: 'SYSTEM', text: `Consumed ${fName}.`, color: '#2ecc71' });
            if (--slot.count <= 0) slot.type = null;
            renderInventory();
        }

        function hasRes(reqs) {
            if (worldConfig.creative) return true;
            const keys = Object.keys(reqs).filter(k => !['hp', 'icon', 'name', 'reqLab', 'radius', 'life', 'desc', 'type', 'duration', 'durability'].includes(k));
            for (let k of keys) {
                const normalizedKey = k === 'rocks' ? 'flint' : k;
                let slot = player.inventory.find(s => s.type === normalizedKey);
                if (!slot || slot.count < reqs[k]) return false;
            }
            return true;
        }

        function payRes(reqs) {
            if (worldConfig.creative) return;
            const keys = Object.keys(reqs).filter(k => !['hp', 'icon', 'name', 'reqLab', 'radius', 'life', 'desc', 'type', 'duration', 'durability'].includes(k));
            for (let k of keys) {
                const normalizedKey = k === 'rocks' ? 'flint' : k;
                let slot = player.inventory.find(s => s.type === normalizedKey);
                if (slot) { slot.count -= reqs[k]; if (slot.count <= 0) slot.type = null; }
            }
            renderInventory();
        }
