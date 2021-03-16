FROM node:buster

RUN mkdir -p /home/node/app/node_modules && mkdir -p /home/node/app/dist/ && chown -R node:node /home/node/app

WORKDIR /home/node/app/

COPY --chown=node:node package*.json ./
USER node

RUN npm install

COPY --chown=node:node . .

RUN npm i typescript --save-dev
RUN npx tsc

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
