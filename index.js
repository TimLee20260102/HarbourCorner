const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, '..')));

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

io.on('connection', (socket) => {
    console.log('一位新的病友連線，ID:', socket.id);

    socket.emit('init-ward-status', wardLights);
    activeLights[socket.id] = {
        id: socket.id,
        x: Math.floor(Math.random() * 60) + 20,
        y: Math.floor(Math.random() * 40) + 30
    };
    io.emit('update_lights', Object.values(activeLights));

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
        if (targetId && activeLights[targetId]) {
            io.emit('light_triggered', { fromId: socket.id, targetId });
        }
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

        delete activeLights[socket.id];
        io.emit('update_lights', Object.values(activeLights));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`微光港灣病房地圖服務已在 Port ${PORT} 溫暖啟動...`);
});