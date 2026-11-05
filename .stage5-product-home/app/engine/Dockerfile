# Digest-pinned for reproducibility (node:18-bullseye as of 2025-11-03)
# To update: docker pull node:18-bullseye && docker inspect node:18-bullseye --format='{{index .RepoDigests 0}}'
FROM node:18-bullseye@sha256:0d9e9a8dcd5a83ea737ed92227a6591a31ad70c8bb722b0c51aff7ae23a88b6a

WORKDIR /app

# Install runtime deps first
COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Copy source
COPY . .

# Create required directories
RUN mkdir -p logs runs backups

# Expose web ports
EXPOSE 3344 3346 3347

# Healthcheck: main dashboard
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3344',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Non-root for safety
RUN useradd -ms /bin/bash cosmo && chown -R cosmo:cosmo /app
USER cosmo

# Default entrypoint: start services and orchestrator
ENTRYPOINT ["bash","scripts/start-container.sh"]

