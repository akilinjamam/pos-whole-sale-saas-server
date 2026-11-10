# Use official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --production=false

# Copy the rest of the application code
COPY . .

# Build the project (if your app requires a build step, e.g., TypeScript or Vite)
RUN npm run build

# Expose port 3005 to match your production .env PORT setting
EXPOSE 3001

# Start the application
CMD ["npm", "start"]