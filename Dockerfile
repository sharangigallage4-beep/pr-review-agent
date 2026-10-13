# PR Review Assistant web UI. Build:  docker build -t pr-review-ui .
# Run it with docker-compose.yml (it sets the password, the data volume and how to reach Ollama).
FROM node:22-slim

WORKDIR /app

# Install dependencies first so this layer is cached until package files change. tsx (a dev
# dependency) is what runs the TypeScript sources, so dev dependencies are installed too.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Review history and auto-review state live in a volume mounted here.
# The port is deliberately not set: a hosting service passes PORT, and otherwise the app uses 4500
# (which is what the Caddy in docker-compose.yml forwards to).
ENV PR_REVIEW_DATA_DIR=/data \
    PR_REVIEW_UI_HOST=0.0.0.0
RUN mkdir -p /data && chown -R node:node /data /app/docs

USER node
EXPOSE 4500

# The server refuses to start on 0.0.0.0 without PR_REVIEW_UI_PASSWORD - that is intentional.
CMD ["npm", "run", "ui"]
