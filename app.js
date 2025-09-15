// app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- PWA Service Worker Registration ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => console.log('Service Worker registered successfully:', registration))
            .catch(error => console.error('Service Worker registration failed:', error));
    }

    // --- Bluetooth GATT Service & Characteristic UUIDs ---
    const PROXIMITY_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
    const MESSAGE_CHARACTERISTIC_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

    // --- Global State ---
    let db;
    let userProfile = {};
    const connectedPeers = new Map();

    // --- UI Element References ---
    const usernameDisplay = document.getElementById('username-display');
    const messageFeed = document.getElementById('message-feed');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const scanButton = document.getElementById('scan-button');
    const peerList = document.getElementById('peer-list');
    const themeSwitcher = document.getElementById('theme-switcher');

    // --- Theme Management ---
    function applyTheme(theme) {
        if (theme === 'light') {
            document.body.classList.add('light-theme');
            themeSwitcher.textContent = 'Switch to Dark Theme';
        } else { // 'dark'
            document.body.classList.remove('light-theme');
            themeSwitcher.textContent = 'Switch to Light Theme';
        }
    }

    function toggleTheme() {
        const isLight = document.body.classList.contains('light-theme');
        const newTheme = isLight ? 'dark' : 'light';
        localStorage.setItem('proximity_theme', newTheme);
        applyTheme(newTheme);
    }

    function initTheme() {
        // Defaults to 'dark' if no theme is saved
        const savedTheme = localStorage.getItem('proximity_theme') || 'dark';
        applyTheme(savedTheme);
    }
    
    // --- IndexedDB Initialization ---
    function initDB() {
        const request = indexedDB.open('proximity_db', 1);

        request.onerror = event => console.error('IndexedDB error:', event.target.errorCode);
        request.onsuccess = event => {
            db = event.target.result;
            loadProfile();
            loadMessages();
        };

        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('profile')) {
                db.createObjectStore('profile', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('messages')) {
                const messageStore = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                messageStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    }

    // --- Profile Management ---
    function loadProfile() {
        const transaction = db.transaction('profile', 'readonly');
        const store = transaction.objectStore('profile');
        const request = store.get(1);

        request.onsuccess = event => {
            if (event.target.result) {
                userProfile = event.target.result;
                usernameDisplay.textContent = userProfile.username;
                startGattServer();
            } else {
                promptForUsername();
            }
        };
    }

    function promptForUsername() {
        const username = prompt('Please enter a username:', `user${Math.floor(Math.random() * 1000)}`);
        if (username && username.trim().length > 0) {
            saveProfile(username);
        } else {
            promptForUsername();
        }
    }

    function saveProfile(username) {
        const transaction = db.transaction('profile', 'readwrite');
        const store = transaction.objectStore('profile');
        userProfile = { id: 1, username };
        store.put(userProfile);
        usernameDisplay.textContent = userProfile.username;
        startGattServer();
    }

    // --- Message Handling ---
    function loadMessages() {
        const transaction = db.transaction('messages', 'readonly');
        const store = transaction.objectStore('messages');
        const index = store.index('timestamp');
        
        index.openCursor().onsuccess = event => {
            const cursor = event.target.result;
            if (cursor) {
                renderMessage(cursor.value);
                cursor.continue();
            }
        };
    }

    function saveAndRenderMessage(message, isMe = false) {
        const transaction = db.transaction('messages', 'readwrite');
        const store = transaction.objectStore('messages');
        const request = store.add(message);
        request.onsuccess = () => renderMessage(message, isMe);
        request.onerror = (e) => console.error("Error saving message", e);
    }

    function renderMessage(message, isMeOverride = null) {
        const isMe = isMeOverride !== null ? isMeOverride : message.sender === userProfile.username;
        const messageBubble = document.createElement('div');
        messageBubble.className = `message-bubble ${isMe ? 'me' : 'other'}`;
        
        messageBubble.innerHTML = `
            <div class="message-sender">${isMe ? 'You' : message.sender}</div>
            <div class="message-text">${message.text}</div>
        `;
        
        messageFeed.appendChild(messageBubble);
        messageFeed.scrollTop = messageFeed.scrollHeight;
    }

    // --- Web Bluetooth: GATT Server (Peripheral Role) ---
    async function startGattServer() {
        if (!navigator.bluetooth || !navigator.bluetooth.getAvailability || !await navigator.bluetooth.getAvailability()) {
            alert('Web Bluetooth is not available on this browser.');
            return;
        }
        // Placeholder for server logic. True GATT server advertising is not yet
        // widely supported, so devices primarily act as clients (centrals).
        console.log('Device is ready to be discovered (acting as a potential peripheral).');
    }
    
    function handleIncomingMessage(event) {
        const value = event.target.value;
        const decoder = new TextDecoder('utf-8');
        const messageString = decoder.decode(value);
        
        try {
            const message = JSON.parse(messageString);
            console.log('Received message:', message);
            if (message.sender !== userProfile.username) {
                saveAndRenderMessage(message, false);
            }
        } catch (error) {
            console.error('Failed to parse incoming message:', error);
        }
    }

    // --- Web Bluetooth: Client (Central Role) ---
    async function scanForPeers() {
        console.log('Scanning for nearby users...');
        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [PROXIMITY_SERVICE_UUID] }]
            });

            console.log('Found device:', device.name || `ID: ${device.id}`);
            if (connectedPeers.has(device.id)) {
                console.log('Already connected to this device.');
                return;
            }

            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(PROXIMITY_SERVICE_UUID);
            const characteristic = await service.getCharacteristic(MESSAGE_CHARACTERISTIC_UUID);
            
            // Start listening for messages FROM this peer
            await characteristic.startNotifications();
            characteristic.addEventListener('characteristicvaluechanged', handleIncomingMessage);

            connectedPeers.set(device.id, { device, characteristic });
            console.log(`Connection established with ${device.name || device.id}.`);
            
            device.addEventListener('gattserverdisconnected', () => onDisconnected(device.id));
            updatePeerListUI();

        } catch (error) {
            console.error('Bluetooth Scan/Connect Error:', error);
        }
    }

    function onDisconnected(deviceId) {
        console.log(`Device ${deviceId} disconnected.`);
        connectedPeers.delete(deviceId);
        updatePeerListUI();
    }
    
    function updatePeerListUI() {
        peerList.innerHTML = '';
        if (connectedPeers.size === 0) {
            peerList.innerHTML = '<li>None</li>';
            return;
        }
        for (const [id, peer] of connectedPeers.entries()) {
            const listItem = document.createElement('li');
            listItem.textContent = peer.device.name || `Device ID: ${id.substring(0, 8)}...`;
            peerList.appendChild(listItem);
        }
    }

    // --- Sending Messages ---
    async function sendMessage() {
        const text = messageInput.value.trim();
        if (text.length === 0 || !userProfile.username) return;

        const message = {
            sender: userProfile.username,
            text: text,
            timestamp: new Date().getTime()
        };

        saveAndRenderMessage(message, true);
        messageInput.value = '';

        if (connectedPeers.size === 0) return;

        const encoder = new TextEncoder();
        const data = encoder.encode(JSON.stringify(message));

        console.log(`Broadcasting message to ${connectedPeers.size} peer(s)`);
        for (const peer of connectedPeers.values()) {
            try {
                await peer.characteristic.writeValue(data);
                console.log(`Message sent to ${peer.device.id}`);
            } catch (error) {
                console.error(`Failed to send message to ${peer.device.id}:`, error);
            }
        }
    }

    // --- Event Listeners ---
    themeSwitcher.addEventListener('click', toggleTheme);
    scanButton.addEventListener('click', scanForPeers);
    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            sendMessage();
        }
    });

    // --- App Initialization ---
    initTheme();
    initDB();
});