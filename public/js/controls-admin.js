        function setupMobile() { const j = document.getElementById('mobile-controls'), js = document.getElementById('joystick'); if (!j || !js) return; let active = false; j.addEventListener('touchstart', e => { e.preventDefault(); active = true; }); window.addEventListener('touchend', () => { active = false; js.style.transform = `translate(0,0)`; }); window.addEventListener('touchmove', e => { if (!active) return; const t = e.touches[0], r = j.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2; let dx = t.clientX - cx, dy = t.clientY - cy, d = Math.sqrt(dx * dx + dy * dy); if (d > 40) { dx *= 40 / d; dy *= 40 / d; } js.style.transform = `translate(${dx}px, ${dy}px)`; player.x = wrapWorldCoordinate(player.x + (dx / 40) * PLAYER_SPEED, worldWidth); player.y = wrapWorldCoordinate(player.y + (dy / 40) * PLAYER_SPEED, worldHeight); }, { passive: false }); }
        function pauseGame() {
            releaseFirstPersonPointerLock();
            const online = pendingMode === 'online' || pendingMode === 'online-create';
            stopMovement();
            if (online && isOnlineActive()) {
                gameSocket.send(JSON.stringify({ type: 'input:update', roomId: onlineRoom, playerId: onlinePlayerId, sequence: ++inputSequence, input: { keys: {}, selected: selectedHotbarIndex } }));
            }
            currentState = 'PAUSED';
            updateDesktopPresence('Paused');
            updatePauseMenuForMode();
            updatePauseWorldSeed();
            document.getElementById('pause-screen').style.display = 'flex';
        }

        function updatePauseMenuForMode() {
            const online = pendingMode === 'online' || pendingMode === 'online-create';
            const title = document.querySelector('#pause-screen h2');
            if (title) title.textContent = online ? 'MENU (GAME KEEPS RUNNING)' : 'PAUSED';
            document.querySelectorAll('#pause-screen button').forEach(btn => {
                const action = btn.getAttribute('onclick') || '';
                if (action.startsWith('saveGame') || action.startsWith('saveAndQuit')) btn.style.display = online ? 'none' : '';
                if (action.startsWith('resetGame')) btn.textContent = online ? 'LEAVE GAME' : 'QUIT WITHOUT SAVING';
            });
        }
        function resumeGame() { currentState = 'PLAYING'; document.getElementById('pause-screen').style.display = 'none'; updateDesktopPresence(`${pendingMode === 'online' || pendingMode === 'online-create' ? 'Playing multiplayer' : 'Surviving solo'} · Day ${dayCount}`); }
        function displayChat(msg) { const display = document.getElementById('chat-display'); if (!display) return; const div = document.createElement('div'); div.className = 'chat-msg'; const namePart = (msg.name && msg.name !== 'SYSTEM') ? `<span style="color:${msg.color}">${msg.name}:</span> ` : ''; div.innerHTML = `${namePart}${msg.text}`; display.appendChild(div); if (display.childNodes.length > 8) display.removeChild(display.firstChild); display.scrollTop = display.scrollHeight; setTimeout(() => { if (div.parentNode) { div.style.opacity = '0'; div.style.transform = 'translateY(-2px)'; setTimeout(() => div.remove(), 500); } }, 4000); }

        function sendChatMessage() {
            const input = document.getElementById('chat-input');
            if (!input) return;
            const text = input.value.trim();
            input.value = '';
            input.blur();   // give the keyboard back to the game
            if (!text) return;
            if (isOnlineActive()) {
                gameSocket.send(JSON.stringify({ type: 'chat:send', roomId: onlineRoom, playerId: onlinePlayerId, text }));
                const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                displayChat({ name: onlineName || 'YOU', text: safe, color: player.color || '#fff' });
            }
        }

        function handleChatMessage(message) {
            if (!message || !message.text) return;
            displayChat({ name: message.name || 'PLAYER', text: message.text, color: message.color || '#fff' });
        }

        function writeAdminConsole(text) {
            const output = document.getElementById('admin-console-output');
            if (!output) return;
            const line = document.createElement('div');
            line.textContent = String(text);
            output.appendChild(line);
            output.scrollTop = output.scrollHeight;
            while (output.childElementCount > 100) output.firstElementChild.remove();
        }

        function toggleAdminConsole() {
            releaseFirstPersonPointerLock();
            const panel = document.getElementById('admin-console');
            if (!panel) return;
            const opening = panel.style.display !== 'flex';
            if (opening && !areAchievementsDisabled() &&
                !confirm('Opening the admin console disables achievements in this world, even if you only type help. Continue?')) return;
            panel.style.display = opening ? 'flex' : 'none';
            if (!opening) {
                document.getElementById('admin-console-input')?.blur();
                return;
            }
            disableAchievementsForWorld('admin-console');
            stopMovement();
            if (!isOnlineActive()) consoleIsOp = true;
            writeAdminConsole(consoleIsOp
                ? 'Admin console ready. Type help for available commands.'
                : 'Admin commands require room-owner access. On the official server, use auth with the operator-provided server token.');
            document.getElementById('admin-console-input')?.focus();
        }

        function submitAdminConsole(event) {
            event.preventDefault();
            const input = document.getElementById('admin-console-input');
            const commandLine = input?.value.trim();
            if (!commandLine) return;
            input.value = '';
            const firstWord = commandLine.split(/\s+/, 1)[0].toLowerCase();
            writeAdminConsole(firstWord === 'auth' ? '> auth [hidden]' : `> ${commandLine}`);

            if (isOnlineActive()) {
                gameSocket.send(JSON.stringify({ type: 'admin:command', command: commandLine }));
                return;
            }
            runLocalAdminCommand(commandLine);
        }

        function runLocalAdminCommand(commandLine) {
            const [command = '', ...args] = commandLine.trim().split(/\s+/);
            const name = command.toLowerCase();
            const say = writeAdminConsole;
            const itemTypes = new Set(['wood', 'stone', 'iron', 'amber', 'twigs', 'flint', 'axe', 'pickaxe', 'sword', 'torch', 'lantern', 'shovel', 'hammer', 'berries', 'carrots', 'paste', 'acorn']);
            const isSelf = ['you', 'me', 'player'].includes(args.join(' ').trim().toLowerCase());

            if (name === 'help') {
                say('Commands: help, status, players, give <item> <count> [durability 0-100], speed <0-100>, creative <player name>, ohko <player name>, firstperson <player name> [on|off|toggle], heal, tp <tile-x> <tile-y>, day, night, say <message>, regen, confirm, clear. In singleplayer use "you" as the player name.');
            } else if (name === 'status') {
                say(`Day ${dayCount} · ${CYCLE[currentPhase]?.label || currentPhase} · position ${Math.floor(player.x / cellSize)},${Math.floor(player.y / cellSize)} · speed ${consoleSpeedPercent}%`);
            } else if (name === 'players') {
                say('Singleplayer: you are the only player.');
            } else if (name === 'give') {
                const type = String(args[0] || '').toLowerCase();
                const count = Number(args[1]);
                const durability = args[2] === undefined ? 100 : Number(args[2]);
                if (!itemTypes.has(type) || !Number.isInteger(count) || count < 1 || count > 999 ||
                    !Number.isFinite(durability) || durability < 0 || durability > 100) {
                    say('Usage: give <item> <count> [durability 0-100].');
                    return;
                }
                if ((BUILDINGS[type]?.durability || BUILDINGS[type]?.duration) && count > 15) {
                    say('Tool count must be 15 or less.');
                    return;
                }
                const before = player.inventory.filter(slot => slot.type === type).length;
                for (let i = 0; i < count; i++) addToInv(type, 1);
                const toolSlots = player.inventory.filter(slot => slot.type === type).slice(before);
                if (BUILDINGS[type]?.durability || BUILDINGS[type]?.duration) {
                    for (const slot of toolSlots) {
                        slot.duration = Math.max(1, Math.round((BUILDINGS[type].durability || BUILDINGS[type].duration) * durability / 100));
                        slot.maxDuration = BUILDINGS[type].durability || BUILDINGS[type].duration;
                    }
                    renderInventory();
                }
                say(`Gave ${toolSlots.length || count} ${type}${toolSlots.length ? ` at ${durability}% durability` : ''}.`);
            } else if (name === 'speed') {
                const percent = Number(args[0]);
                if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
                    say('Usage: speed <0-100>. This is a percentage of normal movement speed.');
                    return;
                }
                consoleSpeedPercent = percent;
                say(`Movement speed set to ${percent}% of normal.`);
            } else if (name === 'creative' || name === 'ohko') {
                if (args.length === 0) {
                    say(`Usage: ${name} <player name>.`);
                    return;
                }
                if (!isSelf) {
                    say('Player not found. In singleplayer use "you".');
                    return;
                }
                if (name === 'creative') {
                    creativePanelEnabled = !creativePanelEnabled;
                    updateCreativeButton();
                    say(`Creative panel ${creativePanelEnabled ? 'enabled' : 'disabled'} for you.`);
                } else {
                    ohkoEnabled = !ohkoEnabled;
                    say(`OHKO mode ${ohkoEnabled ? 'enabled' : 'disabled'} for you.`);
                }
            } else if (name === 'firstperson' || name === 'thirdperson') {
                if (!args.length || !['you', 'me', 'player'].includes(String(args[0]).toLowerCase())) {
                    say('Usage: firstperson you [on|off|toggle].');
                    return;
                }
                const requested = (args[1] || 'toggle').toLowerCase();
                if (!['on', 'off', 'toggle'].includes(requested)) {
                    say('Usage: firstperson you [on|off|toggle].');
                    return;
                }
                setFirstPersonMode(requested === 'toggle' ? !thirdPerson3D : requested === 'on');
                say(`First-person mode ${thirdPerson3D ? 'enabled' : 'disabled'} for you.`);
            } else if (name === 'heal') {
                player.hp = 100;
                player.hunger = 100;
                say('Health and hunger restored.');
            } else if (name === 'tp') {
                const x = Number(args[0]), y = Number(args[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    say('Usage: tp <tile-x> <tile-y>.');
                    return;
                }
                player.x = Math.max(0, Math.min(COLS - 1, Math.floor(x))) * cellSize + 20;
                player.y = Math.max(0, Math.min(ROWS - 1, Math.floor(y))) * cellSize + 20;
                say(`Teleported to tile ${Math.floor(player.x / cellSize)},${Math.floor(player.y / cellSize)}.`);
            } else if (name === 'day' || name === 'night') {
                currentPhase = name.toUpperCase();
                phaseTimeLeft = CYCLE[currentPhase].length * (name === 'day' ? worldConfig.dayMult : worldConfig.nightMult);
                wolfWaveSpawned = false;
                say(`Time changed to ${name}.`);
            } else if (name === 'say') {
                const text = args.join(' ').slice(0, 180);
                if (!text) say('Usage: say <message>.');
                else {
                    displayChat({ name: 'ADMIN', text, color: '#ffcc00' });
                    say('Announcement displayed.');
                }
            } else if (name === 'regen') {
                localRegenConfirmations = 0;
                say('DANGER: This replaces the world and resets your inventory and status. Type confirm three times to proceed.');
            } else if (name === 'confirm') {
                if (localRegenConfirmations === null) {
                    say('No active regeneration request. Type regen to start one.');
                    return;
                }
                localRegenConfirmations++;
                if (localRegenConfirmations < 3) {
                    say(`Regeneration confirmation ${localRegenConfirmations}/3. Type confirm again to continue.`);
                    return;
                }
                localRegenConfirmations = null;
                player.inventory = Array.from({ length: 15 }, () => ({ type: null, count: 0, duration: 0, maxDuration: 0 }));
                selectedHotbarIndex = 0;
                player.hp = 100;
                player.hunger = 100;
                player.inBoat = false;
                player.boatId = null;
                unlocked = { door: false };
                dayCount = 1;
                initializeSoloSeason();
                gregDefeated = false;
                gregDefeatedDay = null;
                alphaWolfDefeated = false;
                soloTokenInventory = { ivory: 0, wolf: 0 };
                soloTokenDrops = { ivory: false, wolf: false };
                currentPhase = 'DAY';
                phaseTimeLeft = CYCLE.DAY.length;
                wolfWaveSpawned = false;
                currentWorldSeed = generateWorldSeed();
                const seedInput = document.getElementById('set-world-seed');
                if (seedInput) seedInput.value = currentWorldSeed;
                normalizeInventory();
                renderInventory();
                generateOrganicMap();
                say('World regeneration started. Existing terrain and player inventory have been reset.');
            } else if (name === 'clear') {
                document.getElementById('admin-console-output').replaceChildren();
            } else if (name === 'auth') {
                say('Authentication is only available on the official multiplayer server. Ask its operator for the configured access token.');
            } else if (name === 'op') {
                say('op is only available in multiplayer rooms.');
            } else {
                say(`Unknown command: ${command}. Type help for commands.`);
            }
        }

        // =====================================================
        // CREATIVE TOOLS (solo creative worlds only)
        // =====================================================
        let creativeSpeedMult = 1, creativeNoclip = false, creativeFreezeTime = false;

        function creativeAvailable() {
            const online = gameSocket && gameSocket.readyState === WebSocket.OPEN;
            return (online ? creativePanelEnabled : worldConfig.creative || creativePanelEnabled) && currentState !== 'MENU';
        }

        function updateCreativeButton() {
            const button = document.getElementById('creative-btn');
            if (!button) return;
            const online = gameSocket && gameSocket.readyState === WebSocket.OPEN;
            button.style.display = (worldConfig.creative && !online) || creativePanelEnabled ? '' : 'none';
        }

        function cpStatus(msg) {
            const el = document.getElementById('cp-status');
            if (el) el.textContent = msg;
        }

        function toggleCreativePanel() {
            const panel = document.getElementById('creative-panel');
            if (!panel) return;
            if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
            if (!creativeAvailable()) return;
            if (!areAchievementsDisabled() &&
                !confirm('Using creative tools disables achievements in this world. Continue?')) return;
            disableAchievementsForWorld('creative-tools');
            panel.style.display = 'block';
        }

        function closeCreativePanel() {
            const panel = document.getElementById('creative-panel');
            if (panel) panel.style.display = 'none';
        }

        function resetCreativeState() {
            creativeSpeedMult = 1; creativeNoclip = false; creativeFreezeTime = false;
            creativePanelEnabled = false;
            ohkoEnabled = false;
            const speed = document.getElementById('cp-speed'); if (speed) speed.value = 1;
            const label = document.getElementById('cp-speed-val'); if (label) label.textContent = '1x';
            const noclip = document.getElementById('cp-noclip'); if (noclip) noclip.checked = false;
            const freeze = document.getElementById('cp-freeze'); if (freeze) freeze.checked = false;
            cpStatus('');
            closeCreativePanel();
        }

        function setCreativeSpeed(value) {
            creativeSpeedMult = Number(value) || 1;
            document.getElementById('cp-speed-val').textContent = `${creativeSpeedMult}x`;
            sendCreativeAction('speed', { value: creativeSpeedMult });
        }

        function sendCreativeAction(action, payload = {}) {
            if (!creativeAvailable()) return false;
            return sendWorldAction('creative_panel', { action, ...payload });
        }

        function setCreativeNoclip(enabled) {
            creativeNoclip = !!enabled;
            sendCreativeAction('noclip', { value: creativeNoclip });
        }

        function setCreativeFreezeTime(enabled) {
            creativeFreezeTime = !!enabled;
            sendCreativeAction('freeze_time', { value: creativeFreezeTime });
        }

        function setCreativeInvulnerability(enabled) {
            player.creativeInvulnerable = !!enabled;
            if (isOnlineActive()) sendCreativeAction('invulnerability', { value: player.creativeInvulnerable });
        }

        function creativeSetPhase(phase) {
            if (!creativeAvailable() || !CYCLE[phase]) return;
            if (isOnlineActive()) {
                sendCreativeAction('phase', { phase });
                return;
            }
            currentPhase = phase;
            phaseTimeLeft = CYCLE[phase].length * (phase === 'DAY' ? worldConfig.dayMult : worldConfig.nightMult);
            cpStatus(`Time set to ${CYCLE[phase].label}.`);
        }

        function creativeNextDay() {
            if (!creativeAvailable()) return;
            if (isOnlineActive()) {
                sendCreativeAction('next_day');
                return;
            }
            dayCount++;
            advanceSoloSeason();
            checkSurvivalAchievements(dayCount);
            maybeRespawnSoloGreg();
            wolfWaveSpawned = false;
            resourceNodes.forEach(node => {
                if (node.type === 'sapling' && dayCount >= node.plantedDay) { node.type = 'wood'; node.icon = '🌲'; node.hp = 5; node.maxHp = 5; }
            });
            creativeSetPhase('DAY');
            cpStatus(`Skipped to day ${dayCount}.`);
        }

        function nearestPassableTile(tx, ty, maxR = 40) {
            for (let r = 0; r <= maxR; r++) {
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                        const x = tx + dx, y = ty + dy;
                        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
                        if (BIOMES[worldGrid[y]?.[x]]?.passable) return { x, y };
                    }
                }
            }
            return null;
        }

        function creativeTeleportToTile(tx, ty) {
            if (!creativeAvailable() || !Number.isFinite(tx) || !Number.isFinite(ty)) return false;
            tx = Math.max(0, Math.min(COLS - 1, Math.floor(tx)));
            ty = Math.max(0, Math.min(ROWS - 1, Math.floor(ty)));
            if (isOnlineActive()) {
                sendCreativeAction('teleport', { x: tx, y: ty });
                cpStatus(`Teleporting to ${tx}, ${ty}...`);
                return true;
            }
            if (!creativeNoclip) {
                // Don't strand the player in deep ocean: snap to the nearest walkable tile.
                const spot = nearestPassableTile(tx, ty);
                if (!spot) { cpStatus('No walkable land nearby.'); return false; }
                tx = spot.x; ty = spot.y;
            }
            player.x = tx * cellSize + 20;
            player.y = ty * cellSize + 20;
            placementMouse = { x: player.x, y: player.y };
            cpStatus(`Teleported to ${tx}, ${ty}.`);
            return true;
        }

        function creativeTeleportToInputs() {
            creativeTeleportToTile(parseFloat(document.getElementById('cp-tx').value), parseFloat(document.getElementById('cp-ty').value));
        }

        function creativePickOnMap() {
            if (!isMapOpen) toggleWorldMap();
            cpStatus('Double-click a spot on the map.');
        }

        function creativeMapDoubleClick(event) {
            if (!creativeAvailable()) return;
            const rect = worldMapCanvas.getBoundingClientRect();
            const cx = (event.clientX - rect.left) * worldMapCanvas.width / rect.width;
            const cy = (event.clientY - rect.top) * worldMapCanvas.height / rect.height;
            const scale = Math.min(worldMapCanvas.width / COLS, worldMapCanvas.height / ROWS) * mapZoom;
            const offX = (worldMapCanvas.width - COLS * scale) * 0.5 + mapPan.x;
            const offY = (worldMapCanvas.height - ROWS * scale) * 0.5 + mapPan.y;
            const tx = (cx - offX) / scale, ty = (cy - offY) / scale;
            if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return;   // clicked outside the map image
            if (creativeTeleportToTile(tx, ty)) toggleWorldMap();
        }

        function creativeGiveItem() {
            if (!creativeAvailable()) return;
            const type = document.getElementById('cp-item').value;
            let amount = Math.max(1, Math.floor(Number(document.getElementById('cp-amount').value) || 1));
            const data = BUILDINGS[type];
            const durable = !!(data?.durability || data?.duration);
            if (durable) amount = 1;
            if (isOnlineActive()) {
                sendCreativeAction('give', { type, count: amount });
                return;
            }
            const canStack = !durable && player.inventory.some(s => s.type === type);
            const hasEmpty = player.inventory.some(s => !s.type);
            if (!canStack && !hasEmpty) { cpStatus('Inventory full.'); return; }
            addToInv(type, amount);
            cpStatus(`Gave ${amount} ${type}.`);
        }

        function creativeSpawnMob(kind) {
            if (!creativeAvailable()) return;
            if (isOnlineActive()) {
                sendCreativeAction('spawn', { kind });
                return;
            }
            const x = player.x + 90, y = player.y;
            if (kind === 'alpha_wolf') {
                mobs.push(createSoloAlphaWolf(x, y));
            } else if (kind === 'wolf') {
                const hp = 15 + dayCount * 3;
                mobs.push({ type: 'wolf', x, y, emoji: '🐺', hp, maxHp: hp, speed: 2.2 + dayCount * 0.1, damage: 4 + Math.floor(dayCount / 4) });
            } else {
                mobs.push({ type: 'elephant', x, y, emoji: '🐘', tx: x, ty: y, hp: 100, maxHp: 100 });
            }
            cpStatus(`Spawned ${kind === 'alpha_wolf' ? 'the Alpha Wolf' : `a ${kind}`}.`);
        }

        function creativeClearMobs() {
            if (!creativeAvailable()) return;
            if (isOnlineActive()) {
                sendCreativeAction('clear_mobs');
                return;
            }
            const count = mobs.length;
            mobs = [];
            cpStatus(`Cleared ${count} mobs.`);
        }

        function creativeRevealMap() {
            if (!creativeAvailable()) return;
            if (isOnlineActive()) {
                sendCreativeAction('reveal_map');
                return;
            }
            discoveredGrid.fill(1);
            mapTerrainDirty = true;
            cpStatus('Minimap revealed.');
        }

        function setupCreativePanel() {
            const panel = document.getElementById('creative-panel');
            if (!panel) return;
            // Typing coordinates / picking items must not move the player or change the hotbar.
            panel.addEventListener('keydown', e => {
                if (e.code === 'Backquote') { e.preventDefault(); toggleCreativePanel(); return; }
                if (e.target.matches('input[type="number"], select')) e.stopPropagation();
            });
            // Give focus back to the game after using a control, so WASD keeps working.
            panel.addEventListener('click', e => { if (e.target.tagName === 'BUTTON') e.target.blur(); });
            panel.addEventListener('change', e => { if (e.target.matches('input[type="range"], input[type="checkbox"]')) e.target.blur(); });
            // Scrolling the panel shouldn't cycle the hotbar.
            panel.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
            worldMapCanvas.addEventListener('dblclick', creativeMapDoubleClick);
            setInterval(() => {
                const el = document.getElementById('cp-pos');
                if (el && panel.style.display === 'block') el.textContent = `(${Math.floor(player.x / cellSize)}, ${Math.floor(player.y / cellSize)})`;
            }, 200);
        }

        const TILE = 40;
        const REACH_WORK = 56;          // px: how close you stand to pick up / chop / shake
        const REACH_ATTACK = 58;        // px: how close you stand to hit something
        const WORK_SEARCH = 240;        // px: how far hold-SPACE looks for something to do
        const ATTACK_SEARCH = 450;      // px: how far hold-F looks for something to hit
        const SHAKES_PER_DAY = 3;       // per tree (the server uses the same numbers)
        const SHAKE_TWIG_CHANCE = 0.33;
        const SHAKE_ACORN_CHANCE = 0.10;
        const WOLF_FIRST_DAY = 4;
        const WOLF_CAP_PER_PLAYER = 4;
        const ALPHA_WOLF_HP = 1250;
        const ALPHA_WOLF_SUMMON_INTERVAL = 7;
        const ALPHA_WOLF_STUN_DURATION = 5;
        const ALPHA_WOLF_SUMMON_COUNT = 6;
        const ALPHA_WOLF_SUMMON_HP = 45;
        const ALPHA_WOLF_SUMMON_SPEED = 2.4;
        const ALPHA_WOLF_SUMMON_DAMAGE = 8;
        const ALPHA_WOLF_SUMMON_BITE_FRAMES = 90;
