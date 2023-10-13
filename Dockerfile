FROM node:18.12.1 AS Builder

WORKDIR /app

COPY package.json ./
COPY yarn.lock ./

RUN yarn

COPY tsconfig.json ./
COPY src/ ./src/
COPY typings/ ./typings/

RUN yarn run tsc

FROM node:18.12.1-alpine AS Runner

WORKDIR /app

COPY --from=Builder /app/node_modules/ ./node_modules/
COPY --from=Builder /app/dist/ ./dist/
COPY --from=Builder /app/package.json ./package.json

EXPOSE 8080

CMD [ "node", "dist/" ]
