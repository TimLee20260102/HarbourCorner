const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const publicDir = fs.existsSync(path.join(__dirname, 'index.html'))
    ? __dirname
    : path.resolve(__dirname, '..');

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});
app.use(express.static(publicDir));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const wardLights = {
    '床位 101': { id: '101', name: '微光 101', x: 25, y: 30, isOn: false },
    '床位 102': { id: '102', name: '微光 102', x: 50, y: 25, isOn: false },
    '床位 103': { id: '103', name: '微光 103', x: 75, y: 30, isOn: false },
    '床位 104': { id: '104', name: '微光 104', x: 25, y: 65, isOn: false },
    '床位 105': { id: '105', name: '微光 105', x: 50, y: 70, isOn: false },
    '床位 106': { id: '106', name: '微光 106', x: 75, y: 65, isOn: false }
};

const activeLights = {};
const residualTimers = new Map();
const RESIDUAL_GLOW_MS = 4 * 60 * 60 * 1000;
const SOLO_WAIT_MS = 10 * 1000;
const MIN_LIGHT_DISTANCE = 18;
let lightJarCount = 0;
let soloTimer = null;
let soloSince = 0;
let soloUserId = null;
let soloGiftDelivered = false;

function emitLights() {
    io.emit('update_lights', Object.values(activeLights));
}

function activeUserIds() {
    return Object.values(activeLights)
        .filter((light) => light.status === 'active')
        .map((light) => light.id);
}

function getLightPosition() {
    const existingLights = Object.values(activeLights);
    const distanceToNearestLight = (position) => {
        if (existingLights.length === 0) return Infinity;

        return existingLights.reduce((minimum, light) => Math.min(
            minimum,
            Math.hypot(position.x - light.x, position.y - light.y)
        ), Infinity);
    };

    for (let attempt = 0; attempt < 100; attempt += 1) {
        const position = {
            x: Math.random() * 84 + 8,
            y: Math.random() * 72 + 8
        };
        if (distanceToNearestLight(position) >= MIN_LIGHT_DISTANCE) return position;
    }

    let bestPosition = null;
    let bestDistance = -1;
    for (let y = 8; y <= 80; y += 2) {
        for (let x = 8; x <= 92; x += 2) {
            const position = { x, y };
            const distance = distanceToNearestLight(position);
            if (distance > bestDistance) {
                bestPosition = position;
                bestDistance = distance;
            }
        }
    }

    return bestPosition;
}

function deliverStoredGlow() {
    if (soloGiftDelivered || !soloUserId || Date.now() - soloSince < SOLO_WAIT_MS) return;
    if (activeUserIds().length !== 1 || activeUserIds()[0] !== soloUserId || lightJarCount < 1) return;

    const light = activeLights[soloUserId];
    if (!light) return;

    lightJarCount -= 1;
    light.brightness = Math.min(2.5, (light.brightness || 1) + 0.8);
    soloGiftDelivered = true;
    io.emit('light-jar-state', { count: lightJarCount });
    emitLights();
    io.emit('solo-light-boost', { targetId: soloUserId });
}

function refreshSoloPresence() {
    const ids = activeUserIds();
    if (ids.length !== 1) {
        if (soloTimer) clearTimeout(soloTimer);
        soloTimer = null;
        soloSince = 0;
        soloUserId = null;
        soloGiftDelivered = false;
        return;
    }

    if (soloUserId === ids[0]) return;

    if (soloTimer) clearTimeout(soloTimer);
    soloUserId = ids[0];
    soloSince = Date.now();
    soloGiftDelivered = false;
    soloTimer = setTimeout(deliverStoredGlow, SOLO_WAIT_MS);
}

io.on('connection', (socket) => {
    console.log('一位新的病友連線，ID:', socket.id);

    const oldResidualTimer = residualTimers.get(socket.id);
    if (oldResidualTimer) clearTimeout(oldResidualTimer);
    residualTimers.delete(socket.id);

    socket.emit('init-ward-status', wardLights);
    activeLights[socket.id] = {
        id: socket.id,
        ...getLightPosition(),
        status: 'active',
        brightness: 1
    };
    emitLights();
    socket.emit('light-jar-state', { count: lightJarCount });
    refreshSoloPresence();

    socket.on('toggle-light', (lightId) => {
        if (lightId === 'REFRESH_MAP') {
            io.emit('init-ward-status', wardLights);
            return;
        }

        const key = `床位 ${lightId}`;
        const light = wardLights[key];
        if (!light) return;

        if (!light.isOn) {
            light.isOn = true;
            light.ownerId = socket.id;
            io.emit('sync-ward-light', light);
        } else if (light.ownerId === socket.id) {
            light.isOn = false;
            light.ownerId = null;
            io.emit('sync-ward-light', light);
        } else {
            io.emit('receive-companion-ripple', { lightId });
        }
    });

    socket.on('click_light', ({ targetId } = {}) => {
        if (!targetId || targetId === socket.id) return;

        const target = activeLights[targetId];
        if (!target) return;

        if (target.status === 'residual') {
            target.brightness = Math.min(2.5, (target.brightness || 0.45) + 0.25);
            target.encouragementCount = (target.encouragementCount || 0) + 1;
            emitLights();
            return;
        }

        io.emit('light_triggered', { fromId: socket.id, targetId });
    });

    socket.on('deposit-light', () => {
        lightJarCount += 1;
        io.emit('light-jar-state', { count: lightJarCount });
        deliverStoredGlow();
    });

    socket.on('disconnect', () => {
        console.log('病友斷開連線:', socket.id);

        Object.values(wardLights).forEach((light) => {
            if (light.ownerId === socket.id) {
                light.isOn = false;
                light.ownerId = null;
                io.emit('sync-ward-light', light);
            }
        });

        const light = activeLights[socket.id];
        if (light) {
            light.status = 'residual';
            light.brightness = 0.45;
            light.encouragementCount = 0;
            light.expiresAt = Date.now() + RESIDUAL_GLOW_MS;
            const timer = setTimeout(() => {
                if (activeLights[socket.id] === light) {
                    delete activeLights[socket.id];
                    residualTimers.delete(socket.id);
                    emitLights();
                }
            }, RESIDUAL_GLOW_MS);
            residualTimers.set(socket.id, timer);
        }

        emitLights();
        refreshSoloPresence();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`微光港灣病房地圖服務已在 Port ${PORT} 溫暖啟動...`);
});
