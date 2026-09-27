import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './server/routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// The dev server proxy forwards traffic to port 3000.
// In Cloud Run / sandbox containers, process.env.PORT is often set to 8080 (the external container port),
// while the internal dev proxy expects the node process to listen on DEFAULT_APP_PORT or port 3000.
const PORT = process.env.DEFAULT_APP_PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Mount API routes
app.use('/api', apiRouter);

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'dashboard')));

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server on 0.0.0.0:3000
const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SmartCity AI Server running on http://0.0.0.0:${PORT}`);
});
