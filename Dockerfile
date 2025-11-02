FROM node:20-alpine
WORKDIR /app

# Copy only package files first → cached layer
COPY package*.json ./
RUN npm ci --omit=dev

# Now copy the rest
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
