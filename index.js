import express from "express";
import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);

app.use((req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
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

app.listen(process.env.PORT || 3000, () =>
  console.log("Redis microservice running")
);
