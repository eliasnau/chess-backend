import express from "express";
import { Server } from "socket.io";
import { v4 as uuidV4 } from "uuid";
import http from "http";
import { Chess } from "chess.js";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const app = express(); // initialize express

const server = http.createServer(app);

// set port to value received from environment variable or 8080 if null
const port: number = parseInt(process.env.PORT as string, 10) || 8080;

// upgrade http server to websocket server
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  }, // allow connection from any origin
});

interface Player {
  id: string;
  username?: string;
}

interface Room {
  roomId: string;
  players: Player[];
  chess?: Chess;
}

const rooms: Map<string, Room> = new Map();

io.on("connection", (socket: any) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("username", (username: String) => {
    console.log(username);
    socket.data.username = username;
  });

  socket.on("createRoom", async (callback: any) => {
    // callback here refers to the callback function from the client passed as data
    const roomId = uuidV4(); // <- 1 create a new uuid
    await socket.join(roomId); // <- 2 make creating user join the room
    const newChessGame = new Chess();

    // set roomId as a key and roomData including players as value in the map
    rooms.set(roomId, {
      // <- 3
      roomId,
      players: [{ id: socket.id, username: socket.data?.username }],
      chess: newChessGame,
    });
    // returns Map(1){'2b5b51a9-707b-42d6-9da8-dc19f863c0d0' => [{id: 'socketid', username: 'username1'}]}

    callback(roomId); // <- 4 respond with roomId to client by calling the callback function from the client
  });

  socket.on("joinRoom", async (args: any, callback: any) => {
    // check if room exists and has a player waiting
    const room: Room | undefined = rooms.get(args.roomId);
    let error: boolean = false;
    let message: string = "";

    if (!room) {
      // if room does not exist
      error = true;
      message = "room does not exist";
    } else if (room.players.length <= 0) {
      // if room is empty set appropriate message
      error = true;
      message = "room is empty";
    } else if (room.players.length >= 2) {
      // if room is full
      error = true;
      message = "room is full"; // set message to 'room is full'
    }

    if (error) {
      // if there's an error, check if the client passed a callback,
      // call the callback (if it exists) with an error object and exit or
      // just exit if the callback is not given

      if (callback) {
        // if user passed a callback, call it with an error payload
        callback({
          error,
          message,
        });
      }

      return; // exit
    }

    await socket.join(args.roomId); // make the joining client join the room

    // add the joining user's data to the list of players in the room
    const roomUpdate: Room = {
      ...room!,
      players: [
        ...room!.players,
        { id: socket.id, username: socket.data?.username },
      ],
    };

    rooms.set(args.roomId, roomUpdate);

    callback(roomUpdate); // respond to the client with the room details.

    // emit an 'opponentJoined' event to the room to tell the other player that an opponent has joined
    socket.to(args.roomId).emit("opponentJoined", roomUpdate);
  });

  socket.on("move", async (data: { room: string; move: any }) => {
    const { room, move } = data;
    const game = rooms.get(room);

    if (!game || !game.chess) {
      // Room or game not found
      return;
    }

    const isPlayerTurn =
      game.players[game.chess.turn() === "w" ? 0 : 1].id === socket.id;

    if (!isPlayerTurn) {
      // It's not the player's turn
      return;
    }

    // Validate the move using chess.js
    const isLegalMove = game.chess.move(move);
    console.log(game.chess.pgn());
    if (!isLegalMove) {
      // If the move is illegal, close the room and inform both players
      io.to(room).emit("illegalMove", {
        message: "Illegal move detected. Room will be closed.",
      });
      rooms.delete(room);
      console.log("Room closed due to an illegal move");
      return;
    }
    socket.to(room).emit("move", move);

    if (game.chess.isGameOver()) {
      const gameHistory = game.chess.history();
      const gamePGN = game.chess.pgn();
      const gameFEN = game.chess.fen();
      io.to(room).emit("gameover", game.chess);

      if (game.chess.isGameOver()) {
        // Handle checkmate logic if needed
        console.log("Checkmate occurred");

        for (const player of game.players) {
          await prisma.game.create({
            data: {
              fen: gameFEN,
              history: gameHistory,
              pgn: gamePGN,
              user: {
                connect: {
                  id: player.username, // Assuming each player has an id
                },
              },
            },
          });
        }
      }

      rooms.delete(room); // Close the room
      console.log("Room closed after the game ended");
      return;
    }

    // If the move is legal, broadcast it to other clients
  });

  socket.on("disconnect", () => {
    const gameRooms: Room[] = Array.from(rooms.values());

    gameRooms.forEach((room) => {
      const userInRoom: Player | undefined = room.players.find(
        (player) => player.id === socket.id
      );

      if (userInRoom) {
        if (room.players.length < 2) {
          // if there's only 1 player in the room, close it and exit.
          rooms.delete(room.roomId);
          console.log("Room closed due to player disconnection");
          return;
        }

        socket.to(room.roomId).emit("playerDisconnected", userInRoom);
      }
    });
  });

  socket.on("closeRoom", async (data: { roomId: string }) => {
    socket.to(data.roomId).emit("closeRoom", data); // inform others in the room that the room is closing

    const clientSockets: any[] = await io.in(data.roomId).fetchSockets(); // get all sockets in a room

    // loop over each socket client
    clientSockets.forEach((s) => {
      s.leave(data.roomId); // and make them leave the room on socket.io
    });

    rooms.delete(data.roomId); // delete room from rooms map
    console.log("Room closed by request");
  });
});

server.listen(port, () => {
  console.log(`listening on *:${port}`);
});
