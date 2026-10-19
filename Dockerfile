FROM node:23-slim

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3456
ENV PULSEREMIND_DB_PATH=/app/data/pulseremind.db

EXPOSE 3456

CMD ["node", "--no-warnings", "src/index.ts"]
