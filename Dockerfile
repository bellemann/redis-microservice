FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Bunny expects the container to listen on the internal port specified in the dashboard
# Keep 8080 as the default
EXPOSE 8080

CMD ["npm", "start"]
