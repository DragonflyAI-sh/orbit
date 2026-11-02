FROM node:22.22.3-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ARG ORBIT_COMMIT=unknown
ENV ORBIT_COMMIT=$ORBIT_COMMIT HOST=0.0.0.0 PORT=8790
EXPOSE 8790
CMD ["node", "src/main.ts"]
