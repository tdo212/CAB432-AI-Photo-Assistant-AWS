FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
ENV AWS_REGION=ap-southeast-2

CMD ["node", "ai_sdk_acp_agent.mjs"]