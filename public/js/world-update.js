        function updateSoloWinter(dt) {
            if (isOnlineActive()) return;
            const campfires = buildings.filter(building => building.type === 'campfire');
            const nearCampfire = campfires.some(fire => Math.hypot(player.x - fire.x - 20, player.y - fire.y - 20) < 250);
            const held = getActiveItem();
            const inDesert = getBiomeAtWorldPos(player.x + 13, player.y + 13) === 'DESERT';
            const nearHeat = inDesert || nearCampfire || (held?.type === 'torch' && Number(held.duration) > 0);
            let thermalChanged = false;
            const updateStones = (slots, heated) => {
                for (const slot of slots || []) {
                    if (slot?.type !== 'thermal_stone') continue;
                    const current = Number(slot.thermalTemp) || 0;
                    const next = currentSeason === 'winter'
                        ? Math.max(-100, Math.min(100, current + (heated ? 12 : -0.003) * dt))
                        : 0;
                    const temperature = Math.round(next * 10000) / 10000;
                    if (temperature !== current || !Number.isFinite(slot.thermalTemp)) {
                        slot.thermalTemp = temperature;
                        thermalChanged = true;
                    }
                }
            };

            updateStones(player.inventory, nearHeat);
            for (const chest of buildings) {
                if (chest.type !== 'chest' || !Array.isArray(chest.inventory)) continue;
                const inDesert = getBiomeAtWorldPos(chest.x, chest.y) === 'DESERT';
                updateStones(chest.inventory, inDesert || campfires.some(fire => Math.hypot(chest.x - fire.x, chest.y - fire.y) < 250));
            }

            if (inDesert) {
                player.bodyHeat = 100;
            } else if (currentSeason === 'winter') {
                const stoneEffect = player.inventory.reduce((sum, slot) => {
                    if (slot?.type !== 'thermal_stone') return sum;
                    const temperature = Math.max(-100, Math.min(100, Number(slot.thermalTemp) || 0)) / 100;
                    return sum + (temperature > 0 ? -temperature * (8 / 9) : -temperature * 1.5);
                }, 0);
                const coolingRate = 5 * Math.max(1 / 9, Math.min(4, 1 + stoneEffect));
                player.bodyHeat = nearHeat
                    ? Math.min(100, (Number(player.bodyHeat) || 0) + 18 * dt)
                    : Math.max(0, (Number(player.bodyHeat) || 0) - coolingRate * dt);
                if (player.bodyHeat <= 0) damagePlayer(4 * dt);
                else if (player.bodyHeat <= 25 && Date.now() - lastColdMessageAt >= 5000) {
                    lastColdMessageAt = Date.now();
                    displayChat({ name: 'SYSTEM', text: 'You are freezing. Find a campfire or hold a torch.', color: '#8be5ff' });
                }
            } else {
                player.bodyHeat = 100;
            }
            if (thermalChanged && Date.now() - lastThermalRenderAt >= 1000) {
                lastThermalRenderAt = Date.now();
                renderInventory();
                renderChestUI();
            }
        }

        function update() {
            const now = performance.now();
            gameFrameDt = Math.min(0.1, Math.max(0, (now - lastGameFrameAt) / 1000));
            lastGameFrameAt = now;
            updateSoundtrack(gameFrameDt);
            updateFirstPersonHint();
            const winterVisual = winterVisualActive();
            if (winterVisual !== lastWinterVisualActive) {
                lastWinterVisualActive = winterVisual;
                mapTerrainDirty = true;
            }
            if (currentState === 'MENU') return;
            if (document.hidden) {
                stopMovement();
                if (gameSocket && gameSocket.readyState === WebSocket.OPEN) {
                    gameSocket.send(JSON.stringify({ type: 'input:update', roomId: onlineRoom, playerId: onlinePlayerId, sequence: ++inputSequence, input: { keys: {} } }));
                }
                return;
            }
            if (currentState === 'PAUSED' || isAnyOverlayActive()) {
                releaseFirstPersonPointerLock();
                // Online the world keeps running on the server, so keep telling it we're standing still.
                if (isOnlineActive() && (++overlayTick % 10) === 0) {
                    gameSocket.send(JSON.stringify({ type: 'input:update', roomId: onlineRoom, playerId: onlinePlayerId, sequence: ++inputSequence, input: { keys: {}, selected: selectedHotbarIndex } }));
                }
                return;
            }
            frameCount++; updateDiscovery();
            updateAutoTask();
            if (!isOnlineActive()) {
                let dx = 0, dy = 0;
                if (keys['KeyW'] || keys['ArrowUp'] || autoKeys.up) dy -= 1;
                if (keys['KeyS'] || keys['ArrowDown'] || autoKeys.down) dy += 1;
                if (keys['KeyA'] || keys['ArrowLeft'] || autoKeys.left) dx -= 1;
                if (keys['KeyD'] || keys['ArrowRight'] || autoKeys.right) dx += 1;
                if (thirdPerson3D) {
                    const forwardX = Math.cos(firstPersonYaw), forwardY = Math.sin(firstPersonYaw);
                    const strafeX = -forwardY, strafeY = forwardX;
                    const localForward = -dy, localRight = dx;
                    dx = forwardX * localForward + strafeX * localRight;
                    dy = forwardY * localForward + strafeY * localRight;
                }
                if (dx || dy) {
                    const magnitude = Math.hypot(dx, dy);
                    const speed = PLAYER_SPEED * creativeSpeedMult * (consoleSpeedPercent / 100) * (['LAKE', 'RIVER', 'SHALLOW_WATER'].includes(getBiomeAtWorldPos(player.x, player.y)) ? 0.5 : 1);
                    const rawX = player.x + (dx / magnitude) * speed;
                    const rawY = player.y + (dy / magnitude) * speed;
                    const nextX = wrapWorldCoordinate(rawX, worldWidth);
                    const nextY = wrapWorldCoordinate(rawY, worldHeight);
                    if (nextX !== rawX || !isLocationBlocked(nextX, player.y)) player.x = nextX;
                    if (nextY !== rawY || !isLocationBlocked(player.x, nextY)) player.y = nextY;
                }
            } else if (thirdPerson3D && player.serverX != null) {
                let dx = 0, dy = 0;
                if (keys['KeyW'] || keys['ArrowUp'] || autoKeys.up) dy -= 1;
                if (keys['KeyS'] || keys['ArrowDown'] || autoKeys.down) dy += 1;
                if (keys['KeyA'] || keys['ArrowLeft'] || autoKeys.left) dx -= 1;
                if (keys['KeyD'] || keys['ArrowRight'] || autoKeys.right) dx += 1;
                const forwardX = Math.cos(firstPersonYaw), forwardY = Math.sin(firstPersonYaw);
                const strafeX = -forwardY, strafeY = forwardX;
                const localForward = -dy, localRight = dx;
                dx = forwardX * localForward + strafeX * localRight;
                dy = forwardY * localForward + strafeY * localRight;
                if (dx || dy) {
                    const magnitude = Math.hypot(dx, dy);
                    const speed = PLAYER_SPEED * creativeSpeedMult * (consoleSpeedPercent / 100) *
                        (['LAKE', 'RIVER', 'SHALLOW_WATER'].includes(getBiomeAtWorldPos(player.x, player.y)) ? 0.5 : 1);
                    const distance = speed * 60 * gameFrameDt;
                    const rawX = player.x + (dx / magnitude) * distance;
                    const rawY = player.y + (dy / magnitude) * distance;
                    const nextX = wrapWorldCoordinate(rawX, worldWidth);
                    const nextY = wrapWorldCoordinate(rawY, worldHeight);
                    if (nextX !== rawX || !isLocationBlocked(nextX, player.y)) player.x = nextX;
                    if (nextY !== rawY || !isLocationBlocked(player.x, nextY)) player.y = nextY;
                }
            }
            if (isOnlineActive() && player.serverX != null) {
                const dx = wrapWorldDelta(player.serverX - player.x, worldWidth);
                const dy = wrapWorldDelta(player.serverY - player.y, worldHeight);
                const distance = Math.hypot(dx, dy);
                if (distance > 200) {
                    player.x = player.serverX;
                    player.y = player.serverY;
                } else {
                    const correction = 1 - Math.exp(-gameFrameDt / 0.18);
                    player.x = wrapWorldCoordinate(player.x + dx * correction, worldWidth);
                    player.y = wrapWorldCoordinate(player.y + dy * correction, worldHeight);
                }
            }
            if (worldConfig.creative) {
                if (player.creativeInvulnerable) player.hp = 100;
                player.hunger = 100;
                darknessExposure = 0;
            }
            Object.values(remotePlayers).forEach(other => { other.renderX += (other.targetX - other.renderX) * 0.25; other.renderY += (other.targetY - other.renderY) * 0.25; });
            if (!creativeFreezeTime) if (!isOnlineActive()) phaseTimeLeft--;
            if (!isOnlineActive() && phaseTimeLeft <= 0) {
                if (currentPhase === 'DAY') currentPhase = 'DUSK';
                else if (currentPhase === 'DUSK') currentPhase = 'NIGHT';
                else {
                    currentPhase = 'DAY';
                    dayCount++;
                    advanceSoloSeason();
                    checkSurvivalAchievements(dayCount);
                    wolfWaveSpawned = false;
                    const removeNightWolves = list => (list || []).filter(mob => mob.type !== 'wolf' && mob.type !== 'alpha_wolf');
                    mobs = removeNightWolves(mobs);
                    if (surfaceLayerLocal) surfaceLayerLocal.mobs = removeNightWolves(surfaceLayerLocal.mobs);
                    if (caveLayerLocal) caveLayerLocal.mobs = removeNightWolves(caveLayerLocal.mobs);
                    resourceNodes.forEach(node => {
                        if (node.type === 'sapling' && dayCount >= node.plantedDay) { node.type = 'wood'; node.icon = '🌲'; node.hp = 5; node.maxHp = 5; }
                    });
                    maybeRespawnSoloGreg();
                }
                phaseTimeLeft = CYCLE[currentPhase].length * (currentPhase === 'DAY' ? worldConfig.dayMult : worldConfig.nightMult);
            }

            if (currentPhase === 'NIGHT' && dayCount >= WOLF_FIRST_DAY && !wolfWaveSpawned && !isOnlineActive()) {
        const count = wolfCountForDay(dayCount, worldConfig.wildlifeMult);
        const hp = wolfHpForDay(dayCount);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            mobs.push({ type: 'wolf', x: player.x + Math.cos(angle) * 900, y: player.y + Math.sin(angle) * 900, emoji: '🐺', hp, maxHp: hp, speed: wolfSpeedForDay(dayCount) / 60, damage: wolfDamageForDay(dayCount) });
        }
        wolfWaveSpawned = true;
        if (count) displayChat({ name: 'SYSTEM', text: 'Howling echoes through the sector...', color: '#ff4444' });
    }
            if (!isOnlineActive() && currentLayer === 'surface' && currentPhase === 'NIGHT' &&
                Number.isInteger(alphaWolfStartDay) &&
                dayCount >= alphaWolfStartDay && !alphaWolfDefeated && !mobs.some(mob => mob.type === 'alpha_wolf')) {
                const angle = Math.random() * Math.PI * 2;
                mobs.push(createSoloAlphaWolf(
                    Math.max(0, Math.min(worldWidth - 100, player.x + Math.cos(angle) * 650)),
                    Math.max(0, Math.min(worldHeight - 100, player.y + Math.sin(angle) * 650))
                ));
                displayChat({ name: 'SYSTEM', text: 'A deep howl rolls across the night. The Alpha Wolf is hunting.', color: '#ff6666' });
            }

            if (['torch', 'lantern'].includes(getActiveItem()?.type) && !isOnlineActive()) {
                if (!worldConfig.creative) getActiveItem().duration--;
                if (getActiveItem().duration <= 0 && !worldConfig.creative) { const lightName = getActiveItem().type; getActiveItem().type = null; getActiveItem().count = 0; getActiveItem().duration = 0; getActiveItem().maxDuration = 0; displayChat({ name: 'SYSTEM', text: `Your ${lightName} burnt out!`, color: '#f00' }); }
                if (frameCount % 30 === 0) renderInventory();
            }

            updateSoloWinter(gameFrameDt);

            if (!isOnlineActive() && currentLayer === 'caves') updateSoloGregDeath();
            if (!isOnlineActive()) mobs.forEach((m, idx) => {
                if (m.deathAt) return;
                if (m.type === 'alpha_wolf') {
                    updateSoloAlphaWolf(m);
                } else if (m.type === 'wolf') {
                    let dx = player.x - m.x, dy = player.y - m.y, dist = Math.sqrt(dx * dx + dy * dy);
                    const nearFire = !m.summonedByAlpha && buildings.some(b => b.type === 'campfire' && Math.sqrt((m.x - b.x) ** 2 + (m.y - b.y) ** 2) < 200);
                    if (nearFire) { m.x -= (dx / dist) * m.speed; m.y -= (dy / dist) * m.speed; } else if (dist > 10) { m.x += (dx / dist) * m.speed; m.y += (dy / dist) * m.speed; }
                    const biteInterval = m.summonedByAlpha ? ALPHA_WOLF_SUMMON_BITE_FRAMES : 60;
                    if (!nearFire && dist < 40 && frameCount % biteInterval === 0) damagePlayer(m.damage);
                } else if (m.type === 'greg' || m.type === 'elephant' && gregDefeated) {
                    updateChargeMob(m);
                } else {
                    if (Math.random() < 0.01) {
                        const ntx = m.x + (Math.random() - 0.5) * 150, nty = m.y + (Math.random() - 0.5) * 150;
                        const b = getBiomeAtWorldPos(ntx, nty);
                        if (BIOMES[b]?.passable && !['LAKE', 'RIVER', 'SHALLOW_WATER', 'BAY', 'GULF'].includes(b)) { m.tx = ntx; m.ty = nty; }
                    }
                    let dx = (m.tx || m.x) - m.x, dy = (m.ty || m.y) - m.y, dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist > 1) { m.x += (dx / dist) * 0.5; m.y += (dy / dist) * 0.5; }
                }
            });

            // In multiplayer, movement/harvest/interaction is server-authoritative.
            if (!player.isDowned) {
                // Disembark handled by server; client can request disembark
                // Hunger and creative still handled client-side for solo; in multiplayer server will send hunger/hp updates
            }

            if (player.hp <= 0 && !gameSocket) { recordPlayerDeath(); resetGame(); }

            if (!worldConfig.creative && (currentPhase === 'NIGHT' || currentLayer === 'caves') && !isOnlineActive()) {
                const campfire = buildings.some(b => b.type === 'campfire' && Math.sqrt((player.x - b.x - 20) ** 2 + (player.y - b.y - 20) ** 2) < 250);
                const heldLight = ['torch', 'lantern'].includes(getActiveItem()?.type);
                const sunlit = getBiomeAtWorldPos(player.x + 13, player.y + 13) === 'CAVE_SUNLIT';
                if (!campfire && !heldLight && !sunlit) darknessExposure++;
                else darknessExposure = Math.max(0, darknessExposure - 2);
            }

            const hungerBox = document.getElementById('hunger-box');
            const hungerLabel = document.getElementById('hunger-label');
            const survivalAlert = document.getElementById('survival-alert');
            const nextHungerAlert = player.hunger <= 0 ? 3 : player.hunger <= 20 ? 2 : player.hunger <= 50 ? 1 : 0;
            if (nextHungerAlert !== hungerAlertLevel) {
                hungerAlertLevel = nextHungerAlert;
                if (hungerAlertLevel === 3) displayChat({ name: 'SYSTEM', text: 'STARVING: health is draining.', color: '#ff4444' });
                else if (hungerAlertLevel === 2) displayChat({ name: 'SYSTEM', text: 'CRITICAL HUNGER: eat something.', color: '#ff4444' });
                else if (hungerAlertLevel === 1) displayChat({ name: 'SYSTEM', text: 'Hunger is getting low.', color: '#ffa500' });
            }
            hungerBox.classList.toggle('warning', hungerAlertLevel === 1);
            hungerBox.classList.toggle('critical', hungerAlertLevel >= 2);
            hungerLabel.innerText = hungerAlertLevel >= 2 ? 'STARVING' : hungerAlertLevel === 1 ? 'HUNGER LOW' : 'HUNGER';
            survivalAlert.style.display = hungerAlertLevel >= 2 ? 'block' : 'none';
            survivalAlert.innerText = hungerAlertLevel === 3 ? 'Health draining' : hungerAlertLevel === 2 ? 'Find food now' : '';

            if (darknessExposure >= 8 * 60) damagePlayer(7 / 60);
            if (darknessExposure >= 8 * 60 && frameCount % 60 === 0) displayChat({ name: 'SYSTEM', text: 'The darkness is hurting you.', color: '#ff4444' });
            if (gameSocket && gameSocket.readyState === WebSocket.OPEN && frameCount % 3 === 0) gameSocket.send(JSON.stringify({ type: 'input:update', roomId: onlineRoom, playerId: onlinePlayerId, sequence: ++inputSequence, input: { keys: effectiveKeys(), selected: selectedHotbarIndex, yaw: firstPersonYaw } }));
            document.getElementById('darkness-warning').style.display = 'none';

            camera.x = Math.max(0, Math.min(worldWidth - logicalWidth, player.x - logicalWidth / 2));
            camera.y = Math.max(0, Math.min(worldHeight - logicalHeight, player.y - logicalHeight / 2));
            buildings = buildings.filter(b => b.type !== 'campfire' || --b.life > 0);
            document.getElementById('hp-val').innerText = Math.ceil(player.hp);
            document.getElementById('hunger-val').innerText = Math.ceil(player.hunger);
            document.getElementById('day-count').innerText = `DAY ${dayCount}`;
            document.getElementById('phase-label').innerText = CYCLE[currentPhase].label;
            const sec = Math.ceil(phaseTimeLeft / 60);
            document.getElementById('phase-timer').innerText = `${Math.floor(sec / 60).toString().padStart(2, '0')}:${(sec % 60).toString().padStart(2, '0')}`;

        }

        function drawLightOnCtx(targetCtx, x, y, r) {
            const grad = targetCtx.createRadialGradient(x, y, 0, x, y, r);
            grad.addColorStop(0, 'rgba(255,255,255,1)');
            grad.addColorStop(0.7, 'rgba(255,255,255,0.4)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            targetCtx.fillStyle = grad; targetCtx.beginPath(); targetCtx.arc(x, y, r, 0, Math.PI * 2); targetCtx.fill();
        }
