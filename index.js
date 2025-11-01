import express from "express";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

// Middleware: verify JWT
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing token" });

  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // store user info for later
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

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

// Token generator route (optional/admin)
app.post("/auth/token", (req, res) => {
  // in a real app, verify user credentials, etc.
  const token = jwt.sign({ user: "test-user" }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
  res.json({ token });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Redis microservice running with JWT auth")
);
