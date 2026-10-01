FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package*.json server.mjs ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
ENV NODE_ENV=production PORT=4318 YOLINK_MODE=cloud
USER node
EXPOSE 4318
CMD ["node", "server.mjs"]
