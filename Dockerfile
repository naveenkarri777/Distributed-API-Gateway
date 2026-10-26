# Dockerfile
# Multi-purpose container for Distributed API Gateway, Microservices, and Load Balancer
FROM node:20-alpine

WORKDIR /app

# Install dependencies (cached if package files haven't changed)
COPY package*.json ./
RUN npm ci

# Copy TypeScript configuration and source files
COPY tsconfig.json ./
COPY src/ ./src/
COPY services/ ./services/

# Default port
EXPOSE 3000

# Default command runs the API gateway (overridden per service in docker-compose)
CMD ["npx", "tsx", "src/server.ts"]
