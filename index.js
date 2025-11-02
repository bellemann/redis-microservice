import express from "express";
import cors from "cors";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

// ===== JWT AUTH MIDDLEWARE =====
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

// ===== READ‑ONLY UPSTASH‑STYLE ENDPOINT =====
app.post("/", async (req, res) => {
  let commands = req.body;
  if (!Array.isArray(commands)) {
    if (Array.isArray(req.body.commands)) commands = req.body.commands;
    else
      return res
        .status(400)
        .json({ error: "Body must be an array of Redis commands" });
  }

  const results = [];
  const tokenUserId = req.user.user_id; // UUID or numeric — works for both

  for (const [cmdRaw, ...args] of commands) {
    const cmd = cmdRaw.toUpperCase();

    // Block write operations
    const writeCommands = [
      "SET",
      "DEL",
      "HSET",
      "HINCRBY",
      "ZADD",
      "ZREM",
      "INCR",
      "DECR",
      "MSET",
      "APPEND",
      "EXPIRE"
    ];
    if (writeCommands.includes(cmd)) {
      results.push("ERR read‑only mode");
      continue;
    }

    try {
      // Replace user:AUTH placeholders
      const argsProcessed = args.map((a) =>
        typeof a === "string" ? a.replace("user:AUTH", `user:${tokenUserId}`) : a
      );

      // Restrict “user:<id>:following” access
      if (
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string" &&
        /^user:[\w-]+:following$/.test(argsProcessed[0])
      ) {
        const idInKey = argsProcessed[0].split(":")[1];
        if (idInKey !== tokenUserId) {
          results.push("ERR forbidden: private resource");
          continue;
        }
      }

      // ===== DEBUG LOGGING =====
      console.log("------------ DEBUG ------------");
      console.log("Token user_id:", req.user.user_id);
      console.log("Raw command:", cmdRaw);
      console.log("Original args:", args);
      console.log("Resolved args:", argsProcessed);

      const result = await redis[cmd.toLowerCase()](...argsProcessed);

      console.log("Redis returned:", result);
      console.log("-------------------------------");

      results.push(result);
    } catch (err) {
      console.error("Redis error:", err);
      results.push(`ERR ${err.message}`);
    }
  }

  res.json(results);
});

// ===== DEBUG ENDPOINT =====
app.get("/debug/:key", async (req, res) => {
  try {
    const key =
      req.params.key === "AUTH"
        ? `user:${req.user.user_id}`
        : req.params.key;

    const data = await redis.hgetall(key);
    res.json({ key, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Crash logging =====
process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) =>
  console.error("Unhandled:", err)
);

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
