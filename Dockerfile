FROM node:18.12.1 AS Builder

WORKDIR /app

COPY package.json ./
COPY yarn.lock ./
COPY tsconfig.json ./
COPY src/ ./src/
COPY typings/ ./typings/

RUN yarn

RUN yarn run tsc

FROM node:18.12.1 AS Runner

WORKDIR /app

COPY --from=Builder node_modules/ ./node_modules/
COPY --from=Builder dist/ ./dist/

CMD [ "node", "dist/" ]
