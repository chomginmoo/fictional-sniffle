# Render server image. Based on the official Playwright image so the matching
# Chromium + all system libraries (and Korean fonts, added below) are present.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# Korean (and CJK) fonts so Hangul doesn't render as tofu boxes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/server/package.json apps/server/package-lock.json* ./apps/server/
RUN cd apps/server && npm install --omit=dev

COPY apps/server ./apps/server
COPY apps/client ./apps/client

# Run as the non-root user that the Playwright image already provides.
USER pwuser

ENV NODE_ENV=production \
    PORT=8080 \
    HEADLESS=true

EXPOSE 8080
CMD ["node", "apps/server/src/index.js"]
