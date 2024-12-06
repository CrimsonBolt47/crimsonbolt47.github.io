import express from 'express';
import http from 'http';
import { Server as socketIO } from 'socket.io';
import bodyParser from 'body-parser';
import cors from 'cors';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
//const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',');

function isValidSubdomain(origin) {
  if (!origin) return false;
  
  // Create a regex pattern for theqube.ai subdomains and localhost
  const pattern = /^https?:\/\/(([a-zA-Z0-9-]+\.)*theqube\.ai|localhost(:\d+)?)$/;
  return pattern.test(origin);
}

const app = express();
app.use(bodyParser.json());
const server = http.createServer(app);
const io = new socketIO(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || isValidSubdomain(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.get('/', (req, res) => {
  res.send('Server is running v5.1');
});

const rooms = new Map();
const userSockets = new Map();


// Constants for room management
const MAX_ROOM_CAPACITY = 20;
const BASE_ROOM_NAME = 'aaaa';

// Function to get the next room name
function getNextRoomName(currentRoom) {
  const chars = currentRoom.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      break;
    } else {
      chars[i] = 'a';
      if (i === 0) {
        chars.unshift('a');
      }
    }
  }
  return chars.join('');
}

// Function to get the next available room
function getAvailableRoom() {
  let currentRoom = BASE_ROOM_NAME;
  while (rooms.has(currentRoom) && rooms.get(currentRoom).size >= MAX_ROOM_CAPACITY) {
    currentRoom = getNextRoomName(currentRoom);
  }
  return currentRoom;
}

// Function to check if a room is full
function isRoomFull(roomId) {
  return rooms.has(roomId) && rooms.get(roomId).size >= MAX_ROOM_CAPACITY;
}

// Function to find a user's room
function findUserRoom(userId) {
  for (const [roomId, players] of rooms.entries()) {
    if (players.has(userId)) {
      return { roomId, players };
    }
  }
  return null;
}

// Firebase Admin SDK initialization
const serviceAccount = path.join(__dirname, 'nextmeet-23792-firebase-adminsdk-g0vaf-f9a9c0a741.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://nextmeet-23792.firebaseio.com"
});
const db = admin.firestore();

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (isValidSubdomain(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// API routes
app.post('/api/update-avatar', async (req, res) => {
  const { userId, avatarURL } = req.body;

  if (!userId || !avatarURL) {
    return res.status(400).json({ error: 'userId and avatarURL are required in the request body' });
  }

  try {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({ avatarURL });
    res.json({ message: 'Avatar URL updated successfully' });
  } catch (error) {
    console.error('Error updating avatar URL:', error);
    res.status(500).json({ error: 'Failed to update avatar URL', details: error.message });
  }
});

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('joinRoom', (data) => {
    const { roomEnv: roomEnv, avatarURL: avatarURL,avatarGender: avatarGender, userId, displayName, roomId: requestedRoomId } = data;
    let roomId;
    console.log(avatarURL);

    if (requestedRoomId && !isRoomFull(requestedRoomId)) {
      roomId = requestedRoomId;
    } else {
      roomId = roomEnv + getAvailableRoom();
    }

    if (userSockets.has(userId)) {
      const existingSocket = userSockets.get(userId);
      if (existingSocket !== socket.id) {
        io.sockets.sockets.get(existingSocket)?.disconnect(true);
        console.log(`Disconnected old socket for user ${userId}`);
      }
    }

    userSockets.set(userId, socket.id);
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    rooms.get(roomId).set(userId, { 
      socketId: socket.id, 
      displayName, 
      position: [0, 0, 0], 
      rotation: [0, 0, 0],
      animationState: 'idle',
      avatarURL: avatarURL,
      gender: avatarGender
    });

    try {
      const roomPlayers = rooms.get(roomId);
      if (!roomPlayers) {
        throw new Error(`Room ${roomId} not found after joining`);
      }
      
      const roomData = Array.from(roomPlayers.entries()).map(([id, user]) => ({
        userId: id,
        displayName: user.displayName,
        position: user.position,
        rotation: user.rotation,
        animationState: user.animationState,
        avatarURL: user.avatarURL,
        gender: user.gender,
        isMuted: false
      }));
      console.log(roomData);

      io.emit('newPlayerJoined', {
        userId: socket.id,
        displayName: displayName,
        roomId: roomId
      });
      
      io.to(roomId).emit('roomUpdate', roomData);
      socket.emit('roomAssigned', { roomId });
    } catch (error) {
      console.error(`Error processing room data for room ${roomId}:`, error);
      socket.emit('error', { message: 'Failed to join room. Please try again.' });
    }
  });

  socket.on('updatePosition', (data) => {
    const { userId, position, rotation, animationState } = data;
    const userRoom = findUserRoom(userId);

    if (!userRoom) {
      //console.error(`User ${userId} not found in any room`);
      socket.emit('error', { message: 'Failed to update position. User not found in any room.' });
      return;
    }

    const { roomId, players } = userRoom;
    const playerData = players.get(userId);

    if (playerData) {
      playerData.position = position;
      playerData.rotation = rotation;
      playerData.animationState = animationState;
      socket.to(roomId).emit('playerMoved', { userId, position, rotation, animationState });
    } else {
      console.error(`Player data for user ${userId} not found in room ${roomId}`);
      socket.emit('error', { message: 'Failed to update position. Player data not found.' });
    }
  });

  socket.on('updatePlayerdata', (data) => {
    const { userId, avatarURL, gender } = data;
    const userRoom = findUserRoom(userId);

    if (!userRoom) {
      //console.error(`User ${userId} not found in any room`);
      socket.emit('error', { message: 'Failed to update player data. User not found in any room.' });
      return;
    }

    const { roomId, players } = userRoom;
    const playerData = players.get(userId);

    if (playerData) {
      playerData.avatarURL = avatarURL;
      playerData.gender = gender;

      try {
        const roomData = Array.from(players.entries()).map(([id, user]) => ({
          userId: id,
          displayName: user.displayName,
          position: user.position,
          rotation: user.rotation,
          animationState: user.animationState,
          avatarURL: user.avatarURL,
          gender: user.gender,
          isMuted: user.isMuted
        }));
        
        io.to(roomId).emit('roomUpdate', roomData);
      } catch (error) {
        console.error(`Error processing room data for room ${roomId}:`, error);
        socket.emit('error', { message: 'Failed to update room data. Please try again.' });
      }
    } else {
      console.error(`Player data for user ${userId} not found in room ${roomId}`);
      socket.emit('error', { message: 'Failed to update player data. Player data not found.' });
    }
  });

  socket.on('chat message', (data) => {
    const { message, userId, userName } = data;
    const userRoom = findUserRoom(userId);

    if (!userRoom) {
      //console.error(`User ${userId} not found in any room`);
      socket.emit('error', { message: 'Failed to send chat message. User not found in any room.' });
      return;
    }

    const { roomId } = userRoom;
    io.to(roomId).emit('chat message', { id: socket.id, text: message, user: userName });
  });

  socket.on('audioStream', (audioData) => {
    console.log(audioData);
    socket.broadcast.emit('audioStream', audioData);
  });

  socket.on('toggleMute', (data) => {
    const { userId, isMuted } = data;
    console.log(userId+ "--is mutedon-" +isMuted);
    const userRoom = findUserRoom(userId);

    if (!userRoom) {
      //console.error(`User ${userId} not found in any room`);
      socket.emit('error', { message: 'Failed to update mute status. User not found in any room.' });
      return;
    }

    const { roomId, players } = userRoom;
    const playerData = players.get(userId);

    if (playerData) {
      playerData.isMuted = isMuted;
      
      // Broadcast the mute status change to all players in the room
      io.to(roomId).emit('playerMuteChanged', { userId, isMuted });
    } else {
      console.error(`Player data for user ${userId} not found in room ${roomId}`);
      socket.emit('error', { message: 'Failed to update mute status. Player data not found.' });
    }
  });

  socket.on('screenShareUpdate', (data) => {
    const { userId, textureData } = data;
    const userRoom = findUserRoom(userId);
    console.log("emitted")

    if (userRoom) {
      const { roomId } = userRoom;
      // Broadcast to all clients in the room except the sender
      socket.to(roomId).emit('screenShareUpdate', { userId, textureData });
    }
  });

  socket.on('removePlayer', (data) => {
    const { userId } = data;
    const userRoom = findUserRoom(userId);
    console.log(userId+" removed");
  
    if (userRoom) {
      const { roomId, players } = userRoom;
      players.delete(userId);
  
      // Notify all clients that the player has been removed
      //io.emit('playerRemoved', { userId, roomId });
  
      // If the room is empty after removing the player, you might want to delete it
      if (players.size === 0) {
        rooms.delete(roomId);
      }
    }
  });

  socket.on('leaveRoom', (userId) => {
    console.log('User leaving room:', userId);
    let userRoom = findUserRoom(userId);

    if (userRoom) {
        const { roomId, players } = userRoom;
        players.delete(userId);

        if (players.size === 0) {
            rooms.delete(roomId);
        } else {
            const roomData = Array.from(players.entries()).map(([id, user]) => ({
                userId: id,
                displayName: user.displayName,
                position: user.position,
                rotation: user.rotation,
                animationState: user.animationState,
                avatarURL: user.avatarURL,
                gender: user.gender
            }));
            io.to(roomId).emit('roomUpdate', roomData);
        }

        // Remove from socket room
        socket.leave(roomId);
    }

    // Remove from userSockets if you want to completely disconnect
    userSockets.delete(userId);

    // Send confirmation back to client
    console.log(`${userId} has left the room`);
});





  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    let disconnectedUserId = null;
    let disconnectedUserRoom = null;

    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        break;
      }
    }

    if (disconnectedUserId) {
      userSockets.delete(disconnectedUserId);
      disconnectedUserRoom = findUserRoom(disconnectedUserId);

      if (disconnectedUserRoom) {
        const { roomId, players } = disconnectedUserRoom;
        players.delete(disconnectedUserId);

        if (players.size === 0) {
          rooms.delete(roomId);
        } else {
          const roomData = Array.from(players.entries()).map(([id, user]) => ({
            userId: id,
            displayName: user.displayName,
            position: user.position,
            rotation: user.rotation,
            animationState: user.animationState,
            avatarURL: user.avatarURL,
            gender: user.gender
          }));
          io.to(roomId).emit('roomUpdate', roomData);
        }
      }
    }
  });


});



server.listen(PORT, () => console.log(`Server running on port ${PORT}`));