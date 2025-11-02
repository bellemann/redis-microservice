FROM node:20-alpine

WORKDIR /app

# Copy dependency list separately for caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

# Disable ioredis ready check
ENV REDIS_DISABLE_READY_CHECK=true

EXPOSE 3000
CMD ["npm", "start"]
