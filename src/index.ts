import express, { Request, Response } from "express";
import http from "http";
import { Server } from "socket.io";
import { handleSocket, rooms } from "./socketHandler";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { PrismaClient } from "@prisma/client"; // Import PrismaClient
const prisma = new PrismaClient();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://192.168.178.30:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const port = process.env.PORT || 8080;

// Middleware to parse JSON bodies
app.use(express.json());

// Route to register a new user
app.post("/register", async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;

    // Check if user already exists in the database
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Save the user to the database
    const newUser = await prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
      },
    });

    res
      .status(201)
      .json({ message: "User registered successfully", user: newUser });
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Route to authenticate user login
app.post("/login", async (req: Request, res: Response) => {
  console.log("New Login");
  try {
    const { email, password } = req.body;

    // Find the user in the database
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Compare the password
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Generate a unique session ID
    const sessionId = uuidv4();

    // Save the session information in the database
    await prisma.session.create({
      data: {
        cookie: sessionId,
        user: { connect: { id: user.id } },
      },
    });

    // Set the session ID as a cookie in the response
    res.cookie("sessionId", sessionId, { httpOnly: true });

    // Send the user ID along with the cookie to the client
    res.json({ userId: user.id, message: "Login successful" });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/getUser", async (req: Request, res: Response) => {
  try {
    const { userId } = req.query; // Use req.query to get the userId from the query parameters

    // Find the user in the database
    const user = await prisma.user.findUnique({
      where: { id: userId as string },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Send the user object as a JSON response
    res.json({
      id: user.id,
      username: user.username,
      elo: user.elo,
    });

    return res.status(200);
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Call the function to handle sockets
handleSocket(io);

server.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
