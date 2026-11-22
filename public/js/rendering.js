        function toggleWorldMap() {
            if (currentState === 'MENU') return;
            if (!isMapOpen) releaseFirstPersonPointerLock();
            isMapOpen = !isMapOpen;
            const overlay = document.getElementById('world-map-overlay');
            overlay.style.display = isMapOpen ? 'flex' : 'none';
            if (isMapOpen) { stopMovement(); drawWorldMap(); }
        }

        function changeMapZoom(amount) {
            setMapZoom(mapZoom + amount, COLS / 2, ROWS / 2);
        }

        function resetMapZoom() {
            mapZoom = 1;
            mapPan = { x: 0, y: 0 };
            persistMapView();
            document.getElementById('world-map-zoom-label').innerText = '100%';
            drawWorldMap();
        }

        function clampMapPan() {
            const scale = Math.min(worldMapCanvas.width / COLS, worldMapCanvas.height / ROWS);
            const maxPan = Math.max(0, (COLS * scale * mapZoom - worldMapCanvas.width) * 0.5);
            mapPan.x = Math.max(-maxPan, Math.min(maxPan, mapPan.x));
            mapPan.y = Math.max(-maxPan, Math.min(maxPan, mapPan.y));
        }

        function setMapZoom(nextZoom, focusX, focusY) {
            const oldZoom = mapZoom;
            mapZoom = Math.max(0.5, Math.min(3, nextZoom));
            const scale = Math.min(worldMapCanvas.width / COLS, worldMapCanvas.height / ROWS);
            const oldWorldWidth = COLS * scale * oldZoom;
            const newWorldWidth = COLS * scale * mapZoom;
            const focusNormX = (focusX / COLS) * oldWorldWidth - oldWorldWidth / 2;
            const focusNormY = (focusY / ROWS) * oldWorldWidth - oldWorldWidth / 2;
            mapPan.x = (mapPan.x + focusNormX) * (newWorldWidth / oldWorldWidth) - focusNormX;
            mapPan.y = (mapPan.y + focusNormY) * (newWorldWidth / oldWorldWidth) - focusNormY;
            clampMapPan();
            persistMapView();
            document.getElementById('world-map-zoom-label').innerText = `${Math.round(mapZoom * 100)}%`;
            drawWorldMap();
        }

        function mapCanvasPoint(event) {
            const rect = worldMapCanvas.getBoundingClientRect();
            return { x: (event.clientX - rect.left) * COLS / rect.width, y: (event.clientY - rect.top) * ROWS / rect.height };
        }

        function startMapDrag(event) {
            mapDrag = { x: event.clientX, y: event.clientY, panX: mapPan.x, panY: mapPan.y };
            worldMapCanvas.classList.add('dragging');
            worldMapCanvas.setPointerCapture(event.pointerId);
        }

        function dragMap(event) {
            if (!mapDrag) return;
            const rect = worldMapCanvas.getBoundingClientRect();
            mapPan.x = mapDrag.panX + (event.clientX - mapDrag.x) * COLS / rect.width;
            mapPan.y = mapDrag.panY + (event.clientY - mapDrag.y) * ROWS / rect.height;
            clampMapPan();
            persistMapView();
            drawWorldMap();
        }

        function stopMapDrag(event) {
            if (mapDrag && event && worldMapCanvas.hasPointerCapture(event.pointerId)) worldMapCanvas.releasePointerCapture(event.pointerId);
            mapDrag = null;
            worldMapCanvas.classList.remove('dragging');
        }

        function zoomMapAtCursor(event) {
            event.preventDefault();
            const point = mapCanvasPoint(event);
            setMapZoom(mapZoom + (event.deltaY < 0 ? 0.2 : -0.2), point.x, point.y);
        }

        let _mapRebuildIndex = 0; let _mapRebuildChunk = 20000;
        function drawWorldMap() {
            clampMapPan();
            document.getElementById('world-map-zoom-label').innerText = `${Math.round(mapZoom * 100)}%`;
            if (mapTerrainDirty) {
                const terrainCtx = mapTerrainCanvas.getContext('2d', { willReadFrequently: true });
                // For very large maps, rebuild in chunks to avoid frame stalls
                const total = COLS * ROWS;
                if (total > 150000) {
                    const image = terrainCtx.getImageData(0, 0, COLS, ROWS);
                    const start = _mapRebuildIndex;
                    const end = Math.min(total, start + _mapRebuildChunk);
                    for (let i = start; i < end; i++) {
                        const y = Math.floor(i / COLS), x = i % COLS;
                        if (!worldConfig.creative && !discoveredGrid[y * COLS + x]) { image.data[i * 4 + 3] = 0; continue; }
                        const color = winterBiomeColor(worldGrid[y][x]);
                        image.data[i * 4] = parseInt(color.slice(1, 3), 16);
                        image.data[i * 4 + 1] = parseInt(color.slice(3, 5), 16);
                        image.data[i * 4 + 2] = parseInt(color.slice(5, 7), 16);
                        image.data[i * 4 + 3] = 255;
                    }
                    terrainCtx.putImageData(image, 0, 0);
                    _mapRebuildIndex = end;
                    if (_mapRebuildIndex >= total) { mapTerrainDirty = false; _mapRebuildIndex = 0; }
                } else {
                    const image = terrainCtx.createImageData(COLS, ROWS);
                    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
                        if (!worldConfig.creative && !discoveredGrid[y * COLS + x]) continue;
                        const color = BIOMES[worldGrid[y][x]].color;
                        const index = (y * COLS + x) * 4;
                        image.data[index] = parseInt(color.slice(1, 3), 16); image.data[index + 1] = parseInt(color.slice(3, 5), 16); image.data[index + 2] = parseInt(color.slice(5, 7), 16); image.data[index + 3] = 255;
                    }
                    terrainCtx.putImageData(image, 0, 0);
                    mapTerrainDirty = false;
                }
            }
            const mapW = worldMapCanvas.width;
            const mapH = worldMapCanvas.height;
            const fitScale = Math.min(mapW / COLS, mapH / ROWS);
            const renderScale = fitScale * mapZoom;
            const drawW = COLS * renderScale;
            const drawH = ROWS * renderScale;
            const offsetX = (mapW - drawW) * 0.5 + mapPan.x;
            const offsetY = (mapH - drawH) * 0.5 + mapPan.y;
            worldMapCtx.clearRect(0, 0, mapW, mapH);
            worldMapCtx.imageSmoothingEnabled = false;
            worldMapCtx.save();
            worldMapCtx.translate(offsetX, offsetY);
            worldMapCtx.scale(renderScale, renderScale);
            worldMapCtx.drawImage(mapTerrainCanvas, 0, 0, COLS, ROWS);
            resourceNodes.forEach(node => {
                const x = Math.floor(node.x / cellSize), y = Math.floor(node.y / cellSize);
                if (worldConfig.creative || discoveredGrid[y * COLS + x]) { worldMapCtx.fillStyle = node.pickup ? '#ffcc00' : '#ffffff'; worldMapCtx.fillRect(x, y, 2, 2); }
            });
            buildings.forEach(building => {
                const x = Math.floor(building.x / cellSize), y = Math.floor(building.y / cellSize);
                const discovered = worldConfig.creative || discoveredGrid[y * COLS + x];
                if (!discovered && !['cave_entrance', 'cave_exit'].includes(building.type)) return;
                if (building.type === 'cave_entrance') {
                    worldMapCtx.fillStyle = '#07131b';
                    worldMapCtx.fillRect(x - 2, y - 2, 6, 6);
                    worldMapCtx.strokeStyle = '#39e7ff';
                    worldMapCtx.lineWidth = 1.5;
                    worldMapCtx.strokeRect(x - 1.5, y - 1.5, 5, 5);
                    worldMapCtx.fillStyle = '#39e7ff';
                    worldMapCtx.fillRect(x, y, 2, 2);
                } else if (building.type === 'cave_exit') {
                    worldMapCtx.fillStyle = '#fff2a1';
                    worldMapCtx.fillRect(x - 2, y - 2, 5, 5);
                    worldMapCtx.fillStyle = '#17120a';
                    worldMapCtx.fillRect(x - 1, y - 1, 3, 3);
                } else {
                    worldMapCtx.fillStyle = '#ff4444';
                    worldMapCtx.fillRect(x, y, 3, 3);
                }
            });
            worldMapCtx.fillStyle = '#00f2ff'; worldMapCtx.fillRect(Math.floor(player.x / cellSize) - 3, Math.floor(player.y / cellSize) - 3, 7, 7);
            Object.values(remotePlayers).forEach(other => {
                const x = other.x / cellSize + 0.5, y = other.y / cellSize + 0.5;
                worldMapCtx.beginPath();
                worldMapCtx.arc(x, y, 2.5 / renderScale, 0, Math.PI * 2);
                worldMapCtx.fillStyle = other.color || '#ffcc00';
                worldMapCtx.fill();
                worldMapCtx.lineWidth = 1 / renderScale;
                worldMapCtx.strokeStyle = '#ffffff';
                worldMapCtx.stroke();
                if (other.name) {
                    worldMapCtx.font = `${9 / renderScale}px Segoe UI`;
                    worldMapCtx.textAlign = 'left';
                    worldMapCtx.textBaseline = 'middle';
                    worldMapCtx.fillStyle = '#ffffff';
                    worldMapCtx.fillText(other.name, x + 4 / renderScale, y);
                }
            });
            worldMapCtx.restore();
            if (worldConfig.cavesEnabled) {
                worldMapCtx.save();
                worldMapCtx.font = '12px Segoe UI';
                worldMapCtx.textAlign = 'left';
                worldMapCtx.textBaseline = 'bottom';
                worldMapCtx.fillStyle = 'rgba(0,0,0,0.72)';
                worldMapCtx.fillRect(8, mapH - 28, 205, 20);
                worldMapCtx.fillStyle = '#39e7ff';
                worldMapCtx.fillText('■ Cave entrance', 14, mapH - 13);
                worldMapCtx.fillStyle = '#fff2a1';
                worldMapCtx.fillText('■ Cave exit', 116, mapH - 13);
                worldMapCtx.restore();
            }
        }

        function wrapWorldDelta(delta, dimension) {
            if (!dimension) return delta;
            if (delta > dimension / 2) return delta - dimension;
            if (delta < -dimension / 2) return delta + dimension;
            return delta;
        }

        function firstPersonCamera() {
            const forward = { x: Math.cos(firstPersonYaw), y: Math.sin(firstPersonYaw) };
            const groundHeight = firstPersonGroundHeight(player.x + 20, player.y + 20);
            return {
                x: player.x + 20,
                y: player.y + 20,
                forward,
                right: { x: -forward.y, y: forward.x },
                height: groundHeight + 54,
                pitch: firstPersonPitch,
                focal: logicalWidth / 2,
                horizon: logicalHeight * 0.47
            };
        }

        function firstPersonGroundHeight(x, y) {
            const tileX = Math.floor(x / cellSize);
            const tileY = Math.floor(y / cellSize);
            const biome = worldGrid[tileY]?.[tileX];
            return biome && LIQUID_BIOMES.has(biome) ? -16 : 0;
        }

        function projectThirdPerson(x, y, height, cameraState) {
            const dx = wrapWorldDelta(x - cameraState.x, worldWidth);
            const dy = wrapWorldDelta(y - cameraState.y, worldHeight);
            const along = dx * cameraState.forward.x + dy * cameraState.forward.y;
            const side = dx * cameraState.right.x + dy * cameraState.right.y;
            const sin = Math.sin(cameraState.pitch), cos = Math.cos(cameraState.pitch);
            const depth = along * cos + (cameraState.height - height) * sin;
            if (depth <= 8) return null;
            const vertical = along * sin + (height - cameraState.height) * cos;
            const scale = cameraState.focal / depth;
            return {
                x: logicalWidth / 2 + side * scale,
                y: cameraState.horizon - vertical * scale,
                depth,
                scale
            };
        }

        function screenToWorld3D(screenX, screenY) {
            const cameraState = firstPersonCamera();
            const verticalRatio = (cameraState.horizon - screenY) / cameraState.focal;
            const sin = Math.sin(cameraState.pitch), cos = Math.cos(cameraState.pitch);
            const divisor = sin - verticalRatio * cos;
            const along = Math.abs(divisor) < 0.001
                ? 1200
                : cameraState.height * (cos + verticalRatio * sin) / divisor;
            const depth = along * cos + cameraState.height * sin;
            const side = (screenX - logicalWidth / 2) * depth / cameraState.focal;
            const x = cameraState.x + cameraState.forward.x * along + cameraState.right.x * side;
            const y = cameraState.y + cameraState.forward.y * along + cameraState.right.y * side;
            return {
                x: Math.max(0, Math.min(worldWidth - 1, x)),
                y: Math.max(0, Math.min(worldHeight - 1, y))
            };
        }

        function drawFirstPersonWorld() {
            const cameraState = firstPersonCamera();
            const sky = ctx.createLinearGradient(0, 0, 0, logicalHeight);
            sky.addColorStop(0, currentLayer === 'caves' ? '#111521' : '#6aa6ca');
            sky.addColorStop(0.5, currentLayer === 'caves' ? '#292b34' : '#d4c195');
            sky.addColorStop(1, '#283728');
            ctx.fillStyle = sky;
            ctx.fillRect(0, 0, logicalWidth, logicalHeight);

            const centerX = Math.floor(player.x / cellSize);
            const centerY = Math.floor(player.y / cellSize);
            const commands = [];
            const waterBanks = [];
            const tileHeight = biome => LIQUID_BIOMES.has(biome) ? -16 : 0;
            for (let ty = centerY - 38; ty <= centerY + 38; ty++) {
                if (ty < 0 || ty >= ROWS) continue;
                for (let tx = centerX - 36; tx <= centerX + 36; tx++) {
                    if (tx < 0 || tx >= COLS) continue;
                    const biome = worldGrid[ty]?.[tx];
                    if (!biome) continue;
                    const x = tx * cellSize, y = ty * cellSize;
                    const height = tileHeight(biome);
                    const projection = projectThirdPerson(x + cellSize / 2, y + cellSize / 2, height, cameraState);
                    if (!projection || projection.depth > 1900) continue;
                    commands.push({ kind: 'tile', x, y, height, depth: projection.depth, biome });

                    if (height < 0) {
                        const banks = [
                            { biome: worldGrid[ty - 1]?.[tx], a: [x, y], b: [x + cellSize, y] },
                            { biome: worldGrid[ty + 1]?.[tx], a: [x, y + cellSize], b: [x + cellSize, y + cellSize] },
                            { biome: worldGrid[ty]?.[tx - 1], a: [x, y], b: [x, y + cellSize] },
                            { biome: worldGrid[ty]?.[tx + 1], a: [x + cellSize, y], b: [x + cellSize, y + cellSize] }
                        ];
                        for (const bank of banks) {
                            if (!bank.biome || LIQUID_BIOMES.has(bank.biome)) continue;
                            const midpoint = projectThirdPerson((bank.a[0] + bank.b[0]) / 2, (bank.a[1] + bank.b[1]) / 2, -8, cameraState);
                            if (midpoint && midpoint.depth <= 1900) waterBanks.push(bank);
                        }
                    }
                }
            }

            for (const bank of waterBanks) {
                const lowerA = projectThirdPerson(bank.a[0], bank.a[1], -16, cameraState);
                const lowerB = projectThirdPerson(bank.b[0], bank.b[1], -16, cameraState);
                const upperA = projectThirdPerson(bank.a[0], bank.a[1], 0, cameraState);
                const upperB = projectThirdPerson(bank.b[0], bank.b[1], 0, cameraState);
                if (!lowerA || !lowerB || !upperA || !upperB) continue;
                ctx.beginPath();
                ctx.moveTo(lowerA.x, lowerA.y);
                ctx.lineTo(lowerB.x, lowerB.y);
                ctx.lineTo(upperB.x, upperB.y);
                ctx.lineTo(upperA.x, upperA.y);
                ctx.closePath();
                ctx.fillStyle = '#17465b';
                ctx.fill();
            }

            const addBillboard = (emoji, x, y, size, color, label, options = {}) => {
                const height = firstPersonGroundHeight(x, y);
                const projection = projectThirdPerson(x, y, height, cameraState);
                if (!projection || projection.depth > 1900) return;
                commands.push({ kind: 'sprite', emoji, x, y, height, size, color, label, alpha: options.alpha ?? 1, offsetX: options.offsetX ?? 0, glowColor: options.glowColor, glowBlur: options.glowBlur ?? 0, depth: projection.depth });
            };
            const addGroundHole = (x, y) => {
                const height = firstPersonGroundHeight(x + cellSize, y + cellSize);
                const projection = projectThirdPerson(x + cellSize, y + cellSize, height, cameraState);
                if (!projection || projection.depth > 1900) return;
                commands.push({ kind: 'hole', x, y, height, depth: projection.depth });
            };
            const activeItem = getActiveItem();
            resourceNodes.forEach(node => {
                const token = TOKEN_DEFINITIONS[node.type];
                const size = token ? 38 : node.pickup ? 18
                    : ['wood', 'tree'].includes(node.type) ? 58
                        : ['rock', 'big_rock', 'stone'].includes(node.type) ? 48
                            : node.type === 'sapling' ? 42 : 50;
                addBillboard(node.icon || '❓', node.x + 20, node.y + 20, size, null, null, token ? { glowColor: token.color, glowBlur: 22 } : {});
            });
            buildings.forEach(building => {
                if (building.type === 'cave_entrance') {
                    addGroundHole(building.x, building.y);
                    return;
                }
                const reveal = building.rewardChest && building.rewardChestAt
                    ? Math.max(0, Math.min(1, (Date.now() - building.rewardChestAt) / GREG_CHEST_FADE_MS))
                    : 1;
                if (reveal > 0) {
                    addBillboard(BUILDINGS[building.type]?.icon || '❓', building.x + 20, building.y + 20, 42, null, building.type === 'sign' ? building.text : null, { alpha: reveal });
                }
            });
            mobs.forEach(mob => {
                const size = mob.type === 'greg' ? 144 : mob.type === 'alpha_wolf' ? 112 : mob.type === 'wolf' ? 54 : 64;
                const center = mobCenter(mob);
                const elapsed = mob.deathAt ? Date.now() - mob.deathAt : 0;
                if (mob.deathAt && elapsed >= GREG_SHAKE_MS + GREG_FADE_MS) return;
                const alpha = mob.deathAt
                    ? elapsed <= GREG_SHAKE_MS ? 1 : Math.max(0, 1 - (elapsed - GREG_SHAKE_MS) / GREG_FADE_MS)
                    : 1;
                const offsetX = mob.deathAt && elapsed < GREG_SHAKE_MS ? Math.sin(elapsed / 35) * 5 : 0;
                const bossLabel = mob.type === 'greg' && !mob.deathAt
                    ? `GREG · ${Math.ceil(mob.hp)} HP`
                    : mob.type === 'alpha_wolf'
                        ? `ALPHA WOLF · ${mob.phase === 'stunned' ? `STUNNED ${Math.ceil(mob.stunTimer)}s` : `SUMMONS IN ${Math.ceil(mob.summonTimer)}s`} · ${Math.ceil(mob.hp)} HP`
                        : null;
                addBillboard(mob.emoji || '❓', center.x, center.y, size,
                    ['greg', 'alpha_wolf'].includes(mob.type) ? '#ff5555' : null, bossLabel, { alpha, offsetX });
            });
            Object.values(remotePlayers).forEach(other => {
                addBillboard(other.emoji || '🙂', other.x + 20, other.y + 20, 48, other.color || '#ffffff', other.name);
            });
            commands.sort((a, b) => b.depth - a.depth);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const command of commands) {
                if (command.kind === 'tile') {
                    const corners = [
                        projectThirdPerson(command.x, command.y, command.height, cameraState),
                        projectThirdPerson(command.x + cellSize, command.y, command.height, cameraState),
                        projectThirdPerson(command.x + cellSize, command.y + cellSize, command.height, cameraState),
                        projectThirdPerson(command.x, command.y + cellSize, command.height, cameraState)
                    ];
                    if (corners.some(point => !point)) continue;
                    if (corners.every(point => point.x < -20 || point.x > logicalWidth + 20 || point.y < -20 || point.y > logicalHeight + 20)) continue;
                    ctx.beginPath();
                    ctx.moveTo(corners[0].x, corners[0].y);
                    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
                    ctx.closePath();
                    ctx.fillStyle = winterBiomeColor(command.biome);
                    ctx.fill();
                    ctx.strokeStyle = ctx.fillStyle;
                    ctx.lineWidth = 1.25;
                    ctx.stroke();
                    continue;
                }
                if (command.kind === 'hole') {
                    const corners = [
                        projectThirdPerson(command.x, command.y, command.height, cameraState),
                        projectThirdPerson(command.x + cellSize * 2, command.y, command.height, cameraState),
                        projectThirdPerson(command.x + cellSize * 2, command.y + cellSize * 2, command.height, cameraState),
                        projectThirdPerson(command.x, command.y + cellSize * 2, command.height, cameraState)
                    ];
                    if (corners.some(point => !point)) continue;
                    ctx.beginPath();
                    ctx.moveTo(corners[0].x, corners[0].y);
                    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
                    ctx.closePath();
                    ctx.fillStyle = '#091116';
                    ctx.fill();
                    ctx.strokeStyle = '#71909a';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    continue;
                }
                const ground = projectThirdPerson(command.x, command.y, command.height, cameraState);
                if (!ground || ground.x < -120 || ground.x > logicalWidth + 120 || ground.y < -160 || ground.y > logicalHeight + 160) continue;
                const nearScale = Math.min(4, Math.max(1, 650 / ground.depth));
                const screenSize = command.size * nearScale;
                if (command.alpha <= 0) continue;
                ctx.save();
                ctx.globalAlpha *= command.alpha;
                ctx.font = `${screenSize}px serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.shadowColor = command.glowColor || 'transparent';
                ctx.shadowBlur = command.glowBlur * nearScale;
                ctx.fillText(command.emoji, ground.x + command.offsetX, ground.y);
                ctx.shadowBlur = 0;
                if (command.label) {
                    ctx.font = `bold ${Math.max(10, Math.min(22, 12 * nearScale))}px Segoe UI`;
                    ctx.textBaseline = 'bottom';
                    ctx.fillStyle = command.color || '#ffffff';
                    ctx.shadowColor = '#000000';
                    ctx.shadowBlur = 4;
                    ctx.fillText(command.label, ground.x, ground.y - screenSize * 1.05);
                    ctx.shadowBlur = 0;
                }
                ctx.restore();
            }

        }

        function drawFirstPersonLighting() {
            if (currentPhase === 'DAY' && currentLayer !== 'caves') return;

            lightCanvas.width = canvas.width;
            lightCanvas.height = canvas.height;
            lctx.globalCompositeOperation = 'source-over';
            lctx.fillStyle = `rgba(0,0,5,${currentLayer === 'caves' ? 1 : CYCLE[currentPhase].color})`;
            lctx.fillRect(0, 0, lightCanvas.width, lightCanvas.height);
            lctx.globalCompositeOperation = 'destination-out';

            const cameraState = firstPersonCamera();
            const eraseLight = (x, y, height, radius) => {
                const point = projectThirdPerson(x, y, height, cameraState);
                if (!point) return;
                drawLightOnCtx(lctx, point.x * globalScale, point.y * globalScale, radius * point.scale * globalScale);
            };
            const heldType = getActiveItem()?.type;
            const heldLightRadius = heldType === 'lantern' ? 240 : heldType === 'torch' ? 150 : 0;
            if (heldLightRadius) {
                const lightX = cameraState.x + cameraState.forward.x * 200;
                const lightY = cameraState.y + cameraState.forward.y * 200;
                eraseLight(lightX, lightY, 0, heldLightRadius);
            }

            Object.values(remotePlayers).forEach(other => {
                const radius = other.heldLight === 'lantern' ? 240 : other.heldLight === 'torch' ? 150 : 0;
                if (radius) eraseLight(other.x + 20, other.y + 20, 0, radius);
            });
            buildings.forEach(building => {
                if (building.type === 'campfire') eraseLight(building.x + 20, building.y + 20, 0, 250);
            });

            if (currentLayer === 'caves') {
                const arena = isOnlineActive() ? gregArenaOnline : caveLayerLocal?.gregArena;
                if (arena) {
                    for (let y = arena.y - 15; y < arena.y + 15; y++) {
                        for (let x = arena.x - 15; x < arena.x + 15; x++) {
                            const corners = [
                                projectThirdPerson(x * cellSize, y * cellSize, 0, cameraState),
                                projectThirdPerson((x + 1) * cellSize, y * cellSize, 0, cameraState),
                                projectThirdPerson((x + 1) * cellSize, (y + 1) * cellSize, 0, cameraState),
                                projectThirdPerson(x * cellSize, (y + 1) * cellSize, 0, cameraState)
                            ];
                            if (corners.some(point => !point)) continue;
                            lctx.beginPath();
                            lctx.moveTo(corners[0].x * globalScale, corners[0].y * globalScale);
                            for (let i = 1; i < corners.length; i++) {
                                lctx.lineTo(corners[i].x * globalScale, corners[i].y * globalScale);
                            }
                            lctx.closePath();
                            lctx.fillStyle = '#000';
                            lctx.fill();
                        }
                    }
                }
                for (let y = Math.floor(player.y / cellSize) - 25; y <= Math.floor(player.y / cellSize) + 25; y++) {
                    for (let x = Math.floor(player.x / cellSize) - 25; x <= Math.floor(player.x / cellSize) + 25; x++) {
                        if (worldGrid[y]?.[x] !== 'CAVE_SUNLIT') continue;
                        if (arena && x >= arena.x - 15 && x < arena.x + 15 && y >= arena.y - 15 && y < arena.y + 15) continue;
                        eraseLight(x * cellSize + cellSize / 2, y * cellSize + cellSize / 2, 0, 55);
                    }
                }
            }

            lctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(lightCanvas, 0, 0);
        }

        function drawFirstPersonCrosshair() {
            const x = logicalWidth * globalScale / 2;
            const y = logicalHeight * globalScale / 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.82)';
            ctx.lineWidth = 1.5 * globalScale;
            ctx.beginPath();
            ctx.moveTo(x - 7 * globalScale, y);
            ctx.lineTo(x + 7 * globalScale, y);
            ctx.moveTo(x, y - 7 * globalScale);
            ctx.lineTo(x, y + 7 * globalScale);
            ctx.stroke();
        }

        function drawMinimap() {
            const vD = 60, px = Math.floor(player.x / 40), py = Math.floor(player.y / 40), mX = miniCanvas.width / (vD * 2), mY = miniCanvas.height / (vD * 2);
            if (frameCount % 6 === 0) {
                miniCtx.fillStyle = '#000'; miniCtx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);
                for (let y = py - vD; y < py + vD; y++) for (let x = px - vD; x < px + vD; x++) if (x >= 0 && x < COLS && y >= 0 && y < ROWS && discoveredGrid[y * COLS + x]) { miniCtx.fillStyle = winterBiomeColor(worldGrid[y][x]); miniCtx.fillRect((x - (px - vD)) * mX, (y - (py - vD)) * mY, mX + 1, mY + 1); }
                buildings.forEach(building => {
                    if (!['cave_entrance', 'cave_exit'].includes(building.type)) return;
                    const x = Math.floor(building.x / cellSize), y = Math.floor(building.y / cellSize);
                    if (x < px - vD || y < py - vD || x >= px + vD || y >= py + vD) return;
                    miniCtx.fillStyle = building.type === 'cave_entrance' ? '#39e7ff' : '#fff2a1';
                    miniCtx.fillRect((x - (px - vD)) * mX - 1, (y - (py - vD)) * mY - 1, Math.max(3, mX * 3), Math.max(3, mY * 3));
                });
            }
            miniCtx.fillStyle = player.color; miniCtx.fillRect(miniCanvas.width / 2 - 3, miniCanvas.height / 2 - 3, 6, 6);
            Object.values(remotePlayers).forEach(other => {
                const x = ((other.x / cellSize) - (px - vD)) * mX;
                const y = ((other.y / cellSize) - (py - vD)) * mY;
                if (x < 0 || y < 0 || x >= miniCanvas.width || y >= miniCanvas.height) return;
                miniCtx.fillStyle = '#ffffff';
                miniCtx.fillRect(x - 3, y - 3, 7, 7);
                miniCtx.fillStyle = other.color || '#ffcc00';
                miniCtx.fillRect(x - 2, y - 2, 5, 5);
            });
        }

        function draw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (currentState === 'MENU') return;
            if (thirdPerson3D) {
                ctx.save();
                ctx.scale(globalScale, globalScale);
                drawFirstPersonWorld();
                ctx.restore();
                drawFirstPersonLighting();
                drawFirstPersonCrosshair();
                drawMinimap();
                drawWinterScreenTint();
                return;
            }
            ctx.save(); ctx.scale(globalScale, globalScale);
            const camX = Math.floor(camera.x), camY = Math.floor(camera.y);
            ctx.translate(-camX, -camY);
            const sX = Math.floor(camX / 40), eX = Math.min(COLS, Math.floor((camX + logicalWidth) / 40) + 1), sY = Math.floor(camY / 40), eY = Math.min(ROWS, Math.floor((camY + logicalHeight) / 40) + 1);
            for (let y = sY; y < eY; y++) for (let x = sX; x < eX; x++) { ctx.fillStyle = winterBiomeColor(worldGrid[y][x]); ctx.fillRect(x * 40, y * 40, 40, 40); }
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            resourceNodes.forEach(n => {
                if (n.x <= camX - 50 || n.x >= camX + logicalWidth + 50 || n.y <= camY - 50 || n.y >= camY + logicalHeight + 50) return;
                const token = TOKEN_DEFINITIONS[n.type];
                ctx.save();
                if (token) {
                    ctx.shadowColor = token.color;
                    ctx.shadowBlur = 24;
                }
                ctx.font = `${token ? 36 : n.pickup ? 16 : 48}px serif`;
                ctx.fillText(n.icon, n.x + 20, n.y + 20);
                ctx.restore();
                if (!n.pickup && n.hp < n.maxHp) {
                    ctx.fillStyle = '#111';
                    ctx.fillRect(n.x + 5, n.y + 30, 30, 4);
                    ctx.fillStyle = n.type === 'wood' ? '#a67c52' : (n.type === 'stump' ? '#8b4513' : '#888');
                    ctx.fillRect(n.x + 5, n.y + 30, 30 * (n.hp / n.maxHp), 4);
                }
            });
            buildings.forEach(b => {
                const reveal = b.rewardChest && b.rewardChestAt
                    ? Math.max(0, Math.min(1, (Date.now() - b.rewardChestAt) / GREG_CHEST_FADE_MS))
                    : 1;
                if (reveal <= 0) return;
                ctx.save();
                ctx.globalAlpha *= reveal;
                if (b.type === 'cave_entrance') {
                    ctx.fillStyle = '#26343b';
                    ctx.fillRect(b.x + 2, b.y + 2, 76, 76);
                    ctx.strokeStyle = '#80eaff';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(b.x + 3.5, b.y + 3.5, 73, 73);
                    ctx.fillStyle = '#05090b';
                    ctx.beginPath();
                    ctx.ellipse(b.x + 40, b.y + 40, 23, 27, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.font = '52px serif';
                    ctx.fillText('🕳️', b.x + 40, b.y + 40);
                } else {
                    ctx.font = '32px serif';
                    ctx.fillText(BUILDINGS[b.type]?.icon || '❓', b.x + 20, b.y + 20);
                }
                if (b.type === 'sign' && b.text) {
                    const words = String(b.text).split(/\s+/);
                    const lines = [];
                    let line = '';
                    for (const word of words) {
                        const next = line ? `${line} ${word}` : word;
                        if (next.length > 24 && line) {
                            lines.push(line);
                            line = word;
                        } else {
                            line = next;
                        }
                    }
                    if (line) lines.push(line);
                    const visibleLines = lines.slice(0, 3);
                    ctx.font = 'bold 12px Segoe UI';
                    ctx.textAlign = 'center';
                    visibleLines.forEach((text, index) => {
                        const y = b.y - 12 - (visibleLines.length - index - 1) * 15;
                        const width = ctx.measureText(text).width + 10;
                        ctx.fillStyle = 'rgba(0,0,0,0.75)';
                        ctx.fillRect(b.x + 20 - width / 2, y - 8, width, 16);
                        ctx.fillStyle = '#fff';
                        ctx.fillText(text, b.x + 20, y);
                    });
                }
                ctx.restore();
            });
            mobs.forEach(m => {
                const center = mobCenter(m), size = mobSize(m);
                if (m.x > camX - size && m.x < camX + logicalWidth + size && m.y > camY - size && m.y < camY + logicalHeight + size) {
                    const elapsed = m.deathAt ? Date.now() - m.deathAt : 0;
                    if (m.deathAt && elapsed >= GREG_SHAKE_MS + GREG_FADE_MS) return;
                    const alpha = m.deathAt
                        ? elapsed <= GREG_SHAKE_MS ? 1 : Math.max(0, 1 - (elapsed - GREG_SHAKE_MS) / GREG_FADE_MS)
                        : 1;
                    const offsetX = m.deathAt && elapsed < GREG_SHAKE_MS ? Math.sin(elapsed / 35) * 5 : 0;
                    ctx.save();
                    ctx.globalAlpha *= alpha;
                    ctx.font = m.type === 'greg' ? '112px serif' : m.type === 'alpha_wolf' ? '72px serif' : m.type === 'wolf' ? '36px serif' : '52px serif';
                    ctx.fillText(m.emoji || '❓', center.x + offsetX, center.y);
                    if (m.type === 'greg' && !m.deathAt) {
                        ctx.font = 'bold 13px Segoe UI';
                        ctx.fillStyle = '#fff2a1';
                        ctx.textAlign = 'center';
                        ctx.fillText('GREG (FROM ACCOUNTING)', center.x, m.y - 43);
                        if (m.chargeState === 'windup') ctx.fillText('CHARGING...', center.x, m.y - 29);
                        if (m.chargeState === 'stunned') ctx.fillText('STUNNED!', center.x, m.y - 29);
                    }
                    if (m.type === 'alpha_wolf') {
                        ctx.font = 'bold 13px Segoe UI';
                        ctx.fillStyle = m.phase === 'stunned' ? '#ffcc66' : '#ff7777';
                        ctx.textAlign = 'center';
                        ctx.fillText(m.phase === 'stunned' ? `STUNNED · ${Math.ceil(m.stunTimer)}s` : `SUMMONS IN ${Math.ceil(m.summonTimer)}s`, center.x, m.y - 34);
                    }
                    if (!m.deathAt && (m.type === 'greg' || m.type === 'alpha_wolf' || m.hp < m.maxHp)) {
                        const barWidth = m.type === 'greg' ? 80 : m.type === 'alpha_wolf' ? 70 : 30;
                        ctx.fillStyle = '#111'; ctx.fillRect(center.x - barWidth / 2, m.y - 23, barWidth, 5);
                        ctx.fillStyle = m.type === 'greg' || m.type === 'alpha_wolf' || m.type === 'wolf' ? '#ff4444' : '#2ecc71';
                        ctx.fillRect(center.x - barWidth / 2, m.y - 23, barWidth * Math.max(0, m.hp / m.maxHp), 5);
                        if (m.type === 'greg' || m.type === 'alpha_wolf') {
                            ctx.font = 'bold 11px Segoe UI';
                            ctx.fillStyle = '#fff';
                            ctx.fillText(`${Math.ceil(m.hp)} / ${m.maxHp} HP`, center.x, m.y - 15);
                        }
                    }
                    ctx.restore();
                }
            });
            Object.values(remotePlayers).forEach(other => { ctx.font = '40px serif'; ctx.fillText(other.emoji || '🙂', other.renderX + 20, other.renderY + 20); if (other.name) { ctx.font = 'bold 12px Segoe UI'; ctx.fillStyle = other.color || '#fff'; ctx.fillText(other.name, other.renderX + 20, other.renderY - 10); } });
            if (isPlacing && buildMode !== 'none') {
                ctx.save(); ctx.globalAlpha = 0.45; ctx.font = '32px serif'; ctx.fillText(BUILDINGS[buildMode].icon, placementMouse.x + 20, placementMouse.y + 20); ctx.restore();
            }
            ctx.font = '40px serif'; ctx.textAlign = 'center'; ctx.fillText(player.emoji, player.x + 20, player.y + 20);
            if (pendingMode === 'online') { ctx.font = 'bold 12px Segoe UI'; ctx.fillStyle = player.color; ctx.fillText(player.name, player.x + 20, player.y - 10); }
            drawAutoEffects();
            ctx.restore();

            if (currentPhase !== 'DAY' || currentLayer === 'caves') {
                lightCanvas.width = canvas.width; lightCanvas.height = canvas.height; lctx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
                lctx.fillStyle = `rgba(0,0,5, ${currentLayer === 'caves' ? 1 : CYCLE[currentPhase].color})`; lctx.fillRect(0, 0, canvas.width, canvas.height);
                lctx.globalCompositeOperation = 'destination-out';
                if (currentLayer === 'caves') {
                    const arena = isOnlineActive() ? gregArenaOnline : caveLayerLocal?.gregArena;
                    if (arena) {
                        const left = (arena.x - 15) * cellSize;
                        const top = (arena.y - 15) * cellSize;
                        lctx.fillStyle = 'rgba(0,0,0,1)';
                        lctx.fillRect(
                            (left - camX) * globalScale,
                            (top - camY) * globalScale,
                            cellSize * 30 * globalScale,
                            cellSize * 30 * globalScale
                        );
                    }
                    for (let y = sY; y < eY; y++) for (let x = sX; x < eX; x++) {
                        const inArena = arena && x >= arena.x - 15 && x < arena.x + 15 && y >= arena.y - 15 && y < arena.y + 15;
                        if (!inArena && worldGrid[y]?.[x] === 'CAVE_SUNLIT') {
                            drawLightOnCtx(lctx, (x * cellSize + cellSize / 2 - camX) * globalScale, (y * cellSize + cellSize / 2 - camY) * globalScale, 55 * globalScale);
                        }
                    }
                }
                if (getActiveItem()?.type === 'torch') drawLightOnCtx(lctx, (player.x - camX + 13) * globalScale, (player.y - camY + 13) * globalScale, 150 * globalScale);
                if (getActiveItem()?.type === 'lantern') drawLightOnCtx(lctx, (player.x - camX + 13) * globalScale, (player.y - camY + 13) * globalScale, 240 * globalScale);
                Object.values(remotePlayers).forEach(other => {
                    const radius = other.heldLight === 'lantern' ? 240 : other.heldLight === 'torch' ? 150 : 0;
                    if (radius) drawLightOnCtx(lctx, (other.renderX - camX + 13) * globalScale, (other.renderY - camY + 13) * globalScale, radius * globalScale);
                });
                buildings.forEach(b => { if (b.type === 'campfire') drawLightOnCtx(lctx, (b.x - camX + 20) * globalScale, (b.y - camY + 20) * globalScale, 250 * globalScale); });
                lctx.globalCompositeOperation = 'source-over'; ctx.drawImage(lightCanvas, 0, 0);
            }
            const vD = 60, px = Math.floor(player.x / 40), py = Math.floor(player.y / 40), mX = miniCanvas.width / (vD * 2), mY = miniCanvas.height / (vD * 2);
            if (frameCount % 6 === 0) {
                miniCtx.fillStyle = '#000'; miniCtx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);
                for (let y = py - vD; y < py + vD; y++) for (let x = px - vD; x < px + vD; x++) if (x >= 0 && x < COLS && y >= 0 && y < ROWS && discoveredGrid[y * COLS + x]) { miniCtx.fillStyle = winterBiomeColor(worldGrid[y][x]); miniCtx.fillRect((x - (px - vD)) * mX, (y - (py - vD)) * mY, mX + 1, mY + 1); }
                buildings.forEach(building => {
                    if (!['cave_entrance', 'cave_exit'].includes(building.type)) return;
                    const x = Math.floor(building.x / cellSize), y = Math.floor(building.y / cellSize);
                    if (x < px - vD || y < py - vD || x >= px + vD || y >= py + vD) return;
                    miniCtx.fillStyle = building.type === 'cave_entrance' ? '#39e7ff' : '#fff2a1';
                    miniCtx.fillRect((x - (px - vD)) * mX - 1, (y - (py - vD)) * mY - 1, Math.max(3, mX * 3), Math.max(3, mY * 3));
                });
            }
            miniCtx.fillStyle = player.color; miniCtx.fillRect(miniCanvas.width / 2 - 3, miniCanvas.height / 2 - 3, 6, 6);
            Object.values(remotePlayers).forEach(other => {
                const x = ((other.x / cellSize) - (px - vD)) * mX;
                const y = ((other.y / cellSize) - (py - vD)) * mY;
                if (x < 0 || y < 0 || x >= miniCanvas.width || y >= miniCanvas.height) return;
                miniCtx.fillStyle = '#ffffff';
                miniCtx.fillRect(x - 3, y - 3, 7, 7);
                miniCtx.fillStyle = other.color || '#ffcc00';
                miniCtx.fillRect(x - 2, y - 2, 5, 5);
            });
            drawWinterScreenTint();
        }
