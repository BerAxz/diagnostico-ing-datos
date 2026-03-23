FROM node:20-alpine

WORKDIR /app

COPY visualizer/package*.json ./
RUN npm install --omit=dev

COPY visualizer .

EXPOSE 3000

CMD ["npm", "start"]
