FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ARG VITE_GATEWAY_URL=http://localhost:3000
ARG VITE_GATEWAY_WS=ws://localhost:3000/ws
ARG VITE_ADMIN_KEY=admin-secret-key
ENV VITE_GATEWAY_URL=$VITE_GATEWAY_URL
ENV VITE_GATEWAY_WS=$VITE_GATEWAY_WS
ENV VITE_ADMIN_KEY=$VITE_ADMIN_KEY
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
