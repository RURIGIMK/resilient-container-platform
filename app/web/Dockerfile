# Pulled from ECR Public to avoid Docker Hub rate limits inside CodeBuild
FROM public.ecr.aws/docker/library/node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "server.js"]
