        const CHARACTER_THOUGHTS = {
            ambient: [
                'I should probably have a plan.',
                'That tree looks like it knows something.',
                'I wonder if anyone else is having a normal day.',
                'One more step. Then another. Great plan.',
                'I miss having pockets that make sense.',
                'This place is a lot bigger when you are lost.',
                'I should stop talking to myself. Anyway...',
                'Maybe I can build something that stays standing.',
                'I hope that noise was just the wind.',
                'I am sure this is fine. Probably.',
                'I wonder what the weather is doing. Besides this.',
                'A snack would solve at least one of my problems.'
            ],
            cold: [
                "it's so cold...",
                'My bones are filing a complaint.',
                'I would trade a lot for a warm rock right now.',
                'Keep moving. Freezing is a bad look.',
                'I miss the sun. And my fingers.',
                'A campfire would be a very good friend right now.'
            ],
            cave: [
                'why am i going in THERE',
                'That rock looks like a face. hi, rock.',
                'If I hear a noise, I did not hear a noise.',
                'This cave has terrible natural lighting.',
                'I should have brought more courage. And torches.',
                'The rocks are quiet. That is somehow worse.',
                'Hello, cave. Please do not become a problem.',
                'Every step deeper feels like a questionable choice.'
            ],
            lowHealth: [
                'i was going to be someone',
                'tell them i tried.',
                'I have made several avoidable choices.',
                'Okay. New plan: do not get hit again.',
                'I am not ready to be a cautionary tale.'
            ],
            hurt: [
                'it hurts so bad',
                "god i shouldn't have done that",
                'Ow. That was a very bad idea.',
                'I felt that in every possible way.',
                'Note to self: avoid the sharp end.',
                'I would like to file a complaint.'
            ],
            fight: [
                'aim for the knees!',
                "you'll rue the day! what does rue mean?",
                'Okay, act confident. Now swing.',
                'I have a plan. The plan is mostly swinging.',
                'This seemed easier in my head.',
                'Come on then. I think.'
            ]
        };
        const THOUGHT_PRIORITY = { ambient: 0, cold: 1, cave: 1, lowHealth: 2, fight: 3, hurt: 3 };
        const THOUGHT_TYPE_INTERVAL_MS = 34;
        const THOUGHT_LINGER_MS = 10000;
        const THOUGHT_AMBIENT_GAP_MIN_MS = 9000;
        const THOUGHT_AMBIENT_GAP_MAX_MS = 17000;
        const THOUGHT_COLD_REPEAT_MS = 30000;
        const THOUGHT_HURT_COOLDOWN_MS = 1200;
        const thoughtAudio = new Audio(new URL('thought.wav', document.baseURI).href);
        thoughtAudio.preload = 'auto';
        let currentPlayerThought = null;
        let nextAmbientThoughtAt = performance.now() + 7000;
        let lastObservedThoughtHealth = Number(player.hp) || 100;
        let lowHealthThoughtActive = false;
        let coldThoughtActive = false;
        let nextColdThoughtAt = 0;
        let lastHurtThoughtAt = -Infinity;
        let lastThoughtByType = {};
        let thoughtAudioWarningShown = false;

        function randomThoughtDelay() {
            return THOUGHT_AMBIENT_GAP_MIN_MS +
                Math.random() * (THOUGHT_AMBIENT_GAP_MAX_MS - THOUGHT_AMBIENT_GAP_MIN_MS);
        }

        function chooseCharacterThought(type) {
            const options = CHARACTER_THOUGHTS[type];
            if (!options?.length) throw new Error(`Unknown character thought type: ${type}`);
            let index = Math.floor(Math.random() * options.length);
            if (options.length > 1 && index === lastThoughtByType[type]) {
                index = (index + 1 + Math.floor(Math.random() * (options.length - 1))) % options.length;
            }
            lastThoughtByType[type] = index;
            return options[index];
        }

        function playThoughtLetter() {
            const audio = thoughtAudio.cloneNode();
            audio.volume = typeof soundSettings === 'object'
                ? Math.max(0, Math.min(1, soundSettings.effects))
                : 1;
            if (audio.volume <= 0) return;
            Promise.resolve(audio.play()).catch(error => {
                if (thoughtAudioWarningShown) return;
                thoughtAudioWarningShown = true;
                console.warn('Could not play character thought audio:', error);
            });
        }

        function triggerPlayerThought(type) {
            const text = chooseCharacterThought(type);
            const now = performance.now();
            const interrupt = type === 'hurt' || type === 'fight';
            const currentPriority = currentPlayerThought
                ? THOUGHT_PRIORITY[currentPlayerThought.type]
                : -1;
            if (!interrupt && currentPlayerThought && currentPriority >= THOUGHT_PRIORITY[type]) return false;

            currentPlayerThought = {
                type,
                text,
                startedAt: now,
                visibleUntil: Infinity,
                visibleText: '',
                typedCharacters: 0
            };
            nextAmbientThoughtAt = now + randomThoughtDelay();
            return true;
        }

        function registerPlayerHurtThought() {
            const now = performance.now();
            if (now - lastHurtThoughtAt < THOUGHT_HURT_COOLDOWN_MS) return;
            lastHurtThoughtAt = now;
            triggerPlayerThought('hurt');
        }

        function clearPlayerThoughts() {
            currentPlayerThought = null;
            nextAmbientThoughtAt = performance.now() + 7000;
            lastObservedThoughtHealth = Number(player.hp) || 100;
            lowHealthThoughtActive = false;
            coldThoughtActive = false;
            nextColdThoughtAt = 0;
            lastHurtThoughtAt = -Infinity;
        }

        function thoughtAmbientType() {
            if (currentSeason === 'winter' &&
                getBiomeAtWorldPos(player.x + 13, player.y + 13) !== 'DESERT' &&
                Number(player.bodyHeat) <= 35) return 'cold';
            if (currentLayer === 'caves') return 'cave';
            return 'ambient';
        }

        function updatePlayerThoughts() {
            if (!['PLAYING', 'GAME'].includes(currentState)) return;
            const now = performance.now();
            const health = Number(player.hp);
            if (Number.isFinite(health)) {
                if (health <= 20 && !lowHealthThoughtActive) {
                    lowHealthThoughtActive = true;
                    triggerPlayerThought('lowHealth');
                } else if (health > 25) {
                    lowHealthThoughtActive = false;
                }
                if (lastObservedThoughtHealth - health >= 1.5) registerPlayerHurtThought();
                lastObservedThoughtHealth = health;
            }

            const isFreezing = currentSeason === 'winter' &&
                getBiomeAtWorldPos(player.x + 13, player.y + 13) !== 'DESERT' &&
                Number(player.bodyHeat) <= 25;
            if (isFreezing && (!coldThoughtActive || now >= nextColdThoughtAt)) {
                coldThoughtActive = true;
                nextColdThoughtAt = now + THOUGHT_COLD_REPEAT_MS;
                triggerPlayerThought('cold');
            } else if (!isFreezing && Number(player.bodyHeat) > 35) {
                coldThoughtActive = false;
                nextColdThoughtAt = 0;
            }

            if (currentPlayerThought && Number.isFinite(currentPlayerThought.visibleUntil) &&
                now >= currentPlayerThought.visibleUntil) {
                currentPlayerThought = null;
                nextAmbientThoughtAt = now + randomThoughtDelay();
            }

            if (document.hidden || isAnyOverlayActive()) return;
            if (currentPlayerThought) {
                const nextCount = Math.min(
                    currentPlayerThought.text.length,
                    Math.floor((now - currentPlayerThought.startedAt) / THOUGHT_TYPE_INTERVAL_MS) + 1
                );
                for (let index = currentPlayerThought.typedCharacters; index < nextCount; index++) {
                    if (!/\s/.test(currentPlayerThought.text[index])) playThoughtLetter();
                }
                currentPlayerThought.typedCharacters = nextCount;
                currentPlayerThought.visibleText = currentPlayerThought.text.slice(0, nextCount);
                if (nextCount === currentPlayerThought.text.length && !Number.isFinite(currentPlayerThought.visibleUntil)) {
                    currentPlayerThought.visibleUntil = now + THOUGHT_LINGER_MS;
                }
                return;
            }
            if (now >= nextAmbientThoughtAt && health > 20 && !player.isDowned) {
                triggerPlayerThought(thoughtAmbientType());
            }
        }

        function drawPlayerThought(context, anchorX, anchorY) {
            const thought = currentPlayerThought;
            if (!thought?.visibleText) return;

            const maxTextWidth = 210;
            const paddingX = 10;
            const lineHeight = 16;
            context.save();
            context.font = '12px "Segoe UI", sans-serif';
            context.textAlign = 'left';
            context.textBaseline = 'top';
            const lines = [];
            let line = '';
            for (const word of thought.visibleText.split(' ')) {
                const candidate = line ? `${line} ${word}` : word;
                if (line && context.measureText(candidate).width > maxTextWidth) {
                    lines.push(line);
                    line = word;
                } else {
                    line = candidate;
                }
            }
            if (line) lines.push(line);
            const width = Math.min(maxTextWidth, Math.max(52, ...lines.map(value => context.measureText(value).width))) + paddingX * 2;
            const height = Math.max(1, lines.length) * lineHeight + 14;
            const left = anchorX - width / 2;
            const top = anchorY - height - 13;
            const radius = 7;

            context.beginPath();
            context.moveTo(left + radius, top);
            context.lineTo(left + width - radius, top);
            context.quadraticCurveTo(left + width, top, left + width, top + radius);
            context.lineTo(left + width, top + height - radius);
            context.quadraticCurveTo(left + width, top + height, left + width - radius, top + height);
            context.lineTo(anchorX + 6, top + height);
            context.lineTo(anchorX, anchorY - 3);
            context.lineTo(anchorX - 7, top + height);
            context.lineTo(left + radius, top + height);
            context.quadraticCurveTo(left, top + height, left, top + height - radius);
            context.lineTo(left, top + radius);
            context.quadraticCurveTo(left, top, left + radius, top);
            context.closePath();
            context.fillStyle = 'rgba(12, 14, 18, 0.88)';
            context.strokeStyle = 'rgba(220, 226, 235, 0.72)';
            context.lineWidth = 1;
            context.fill();
            context.stroke();

            context.fillStyle = '#f1f3f5';
            lines.forEach((value, index) => {
                context.fillText(value, left + paddingX, top + 7 + index * lineHeight);
            });
            context.restore();
        }
