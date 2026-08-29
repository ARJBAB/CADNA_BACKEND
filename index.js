import express from "express";
import cors from "cors";
import connectDB from "./db/db.js";
import mongoose from "mongoose";
import { connectRedis } from "./db/redis.js";
import { swaggerUi, specs } from "./swagger.js";
import { errorHandler, notFound } from "./middleware/ErrorMiddleware.js";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/authRoutes.js";
import examRoutes from "./routes/examRoutes.js";
import examSessionRoutes from "./routes/examSessionRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import metricsRoutes from "./routes/metricsRoutes.js";
import resultRoutes from "./routes/resultRoutes.js";
import { ensureDBConnection } from "./middleware/DatabaseMiddleware.js";
import dotenv from "dotenv";
import seedRoutes from "./routes/seedRoutes.js";
import aiRoutes from "./routes/aiRoutes-vercel.js";
import aiService from "./services/ai/AIService-vercel.js";
import studyResourceRoutes from "./routes/studyResourceRoutes.js";

dotenv.config();


const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "https://exam-genius-cadna-p7raj245e-ifeanyis-projects-30bb4f9f.vercel.app",
  "https://exam-genius-cadna-five.vercel.app",
]);

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // non-browser tools (e.g., curl, Postman)
  if (allowedOrigins.has(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Cookie",
    "x-requested-with",
    "Accept",
  ],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Swagger Documentation
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

// Handle preflight requests (Express 5 requires a RegExp for catch-all)
app.options(/.*/, cors(corsOptions));

// Add request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Routes
app.get("/", (req, res) => {
  res.json({ message: "CADNA Backend API is running!" });
});

app.get("/health", (req, res) => {
  const dbStatus =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res.json({
    status: "ok",
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

app.use("/api", ensureDBConnection);

app.use("/api/auth", authRoutes);
app.use("/api/exams", examRoutes);

// exam-session routes are responsible for starting exams,
// submitting answers and managing integrity checks.  These
// are mounted after the main exam routes to avoid path conflicts.
app.use("/api/exam-sessions", examSessionRoutes);

app.use("/api/users", userRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/metrics", metricsRoutes);
app.use("/api/results", resultRoutes);
app.use("/api/admin", seedRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/study-resources", studyResourceRoutes);


// 404 handler - must be after all routes
app.use(notFound);

// Error handling middleware - must be last
app.use(errorHandler);

// Start the HTTP server immediately so the port is open (and health checks
// / cold-start pings succeed) without waiting on MongoDB. DB-dependent
// routes are gated by ensureDBConnection until the connection below is ready.
app.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
  console.log(` API docs: http://localhost:${PORT}/api-docs`);
});

// Connect to databases / init services in the background
(async () => {
  try {
    console.log(" Starting CADNA Backend background initialization...");

    // Connect Redis (non-blocking)
    connectRedis().catch((err) => console.warn("Redis failed:", err.message));

    // Connect MongoDB
    await connectDB();

    // Initialize AI Service
    await aiService.initialize();
  } catch (error) {
    console.error(" Background initialization failed:", error.message);
  }
})();

// export app for integration testing or external bootstrapping
export default app;
