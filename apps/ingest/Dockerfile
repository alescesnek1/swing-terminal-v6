FROM node:20-alpine
WORKDIR /app

# Zkopírujeme celý projekt
COPY . .

# Nainstalujeme ioredis na 'chodbu' (root), aby ho shared složka našla
RUN npm install ioredis

# Přepneme se do ingestu a doinstalujeme zbytek (ccxt atd.)
WORKDIR /app/apps/ingest
RUN npm install --production

# Spuštění workeru
CMD ["node", "src/index.js"]
