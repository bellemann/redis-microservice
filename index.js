import express from "express";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cors from "cors";
app.use(cors());

dotenv.config();

const app = express();
app.use(express.json());

// Persistent Redis connection
const redis = new Redis(process.env.REDIS_URL);

// ==== PUBLIC ROUTES ====

// optional helper for quickly generating tokens manually
app.post("/auth/token", (req, res) => {
  const token = jwt.sign({ user: "admin" }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
  res.json({ token });
});

// ==== AUTH MIDDLEWARE ====
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing token" });

  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

// ==== CORE ROUTES ====

// Upstash-compatible batch endpoint
app.post("/", async (req, res) => {
  let commands = req.body;

  // Support both plain [[...]] and { commands: [[...]] }
  if (!Array.isArray(commands)) {
    if (Array.isArray(req.body.commands)) {
      commands = req.body.commands;
    } else {
      return res
        .status(400)
        .json({ error: "Body must be an array of Redis commands" });
    }
  }

  const results = [];

  for (const [cmd, ...args] of commands) {
    try {
      // You can optionally allow specific commands
      const allowed = [
        "SET",
        "GET",
        "DEL",
        "HINCRBY",
        "HGETALL",
        "ZADD",
        "ZINCRBY",
        "ZREVRANGE",
        "EXPIRE",
        "INCR",
        "DECR",
        "MSET",
        "MGET",
        "HSET",
        "HGET",
        "ZCARD",
      ];

      if (!allowed.includes(cmd.toUpperCase())) {
        results.push(`ERR unknown command ${cmd}`);
        continue;
      }

      const out = await redis[cmd.toLowerCase()](...args);
      results.push(out);
    } catch (err) {
      results.push(`ERR ${err.message}`);
    }
  }

  res.json(results);
});

// Simple example endpoints
app.post("/hit", async (req, res) => {
  const { postId, metric } = req.body;
  if (!postId || !metric) return res.status(400).send("Missing params");
  await redis.hincrby(`post:${postId}`, metric, 1);
  res.send("ok");
});

app.get("/stats/:id", async (req, res) => {
  const data = await redis.hgetall(`post:${req.params.id}`);
  res.json(data);
});

// ==== START SERVER ====
app.listen(process.env.PORT || 3000, () => {
  console.log("Redis microservice running with Upstash-style API + JWT auth");
});
