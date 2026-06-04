const express = require("express");
const { sequelize } = require("./models");
require("dotenv").config();

const graphRoutes = require("./routes/gpt");
const graphFileRoutes = require("./routes/graph-files");
const graphSources = require("./routes/sources/sources");
const graphAggregate = require("./routes/sources/aggregate");
const chainRoutes = require("./routes/chain/chain");
const fillCardRouter = require("./routes/fill-card/fill-card");
const stepSources = require("./routes/step/sources");
const stepAggregate = require("./routes/step/aggregate");
const stepBuild = require("./routes/step/build");
const transformationBetween = require("./routes/transformation-between/transformation-between");
const shareRoutes = require("./routes/share/share");

const app = express();
const PORT = process.env.PORT || 3001;

// Полное отключение всех CORS на backend — фильтр на уровне setHeader
app.use((req, res, next) => {
  const originalSetHeader = res.setHeader;

  res.setHeader = function (name, value) {
    const header = name.toLowerCase();

    if (
      header === "access-control-allow-origin" ||
      header === "access-control-allow-credentials" ||
      header === "access-control-allow-methods" ||
      header === "access-control-allow-headers" ||
      header === "vary"
    ) {
      // блокируем установку CORS-заголовков со стороны Express
      return;
    }

    return originalSetHeader.call(this, name, value);
  };

  next();
});

// Базовый логгинг
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Подключение к PostgreSQL
const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to PostgreSQL");

    // Безопасная синхронизация - только в development
    if (process.env.NODE_ENV === "development") {
      await sequelize.sync({ alter: false });
      console.log("✅ Database synchronized");
    }
  } catch (error) {
    console.error("❌ PostgreSQL connection error:", error);
    process.exit(1);
  }
};

connectDB();

// Routes
app.use("/api/graphs", graphRoutes);
app.use("/api/graphs", graphSources);
app.use("/api/graphs", graphAggregate);
app.use("/api/graphs", chainRoutes);
app.use("/api/graph-files", graphFileRoutes);
app.use("/api/graphs", fillCardRouter);
app.use("/api/graphs", stepSources);
app.use("/api/graphs", stepAggregate);
app.use("/api/graphs", stepBuild);
app.use("/api/graphs", transformationBetween);
app.use("/api/graphs", shareRoutes);

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({
      status: "OK",
      timestamp: new Date().toISOString(),
      database: "connected",
      environment: process.env.NODE_ENV || "development",
    });
  } catch (error) {
    res.status(503).json({
      status: "Database Error",
      timestamp: new Date().toISOString(),
      database: "disconnected",
      error: error.message,
    });
  }
});

// Получение списка графов
app.get("/api/graphs", async (req, res) => {
  try {
    const { Graph } = require("./models");
    const graphs = await Graph.findAll({
      attributes: [
        "id",
        "name",
        "userPrompt",
        "nodeCount",
        "edgeCount",
        "createdAt",
        "updatedAt",
      ],
      order: [["createdAt", "DESC"]],
    });

    res.json({
      success: true,
      data: graphs,
      count: graphs.length,
    });
  } catch (error) {
    console.error("Error fetching graphs:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch graphs",
    });
  }
});

// Статистика системы
app.get("/api/stats", async (req, res) => {
  try {
    const { Graph, Node, Edge } = require("./models");

    const [graphCount, nodeCount, edgeCount] = await Promise.all([
      Graph.count(),
      Node.count(),
      Edge.count(),
    ]);

    // Самые популярные узлы
    const popularNodes = await Node.findAll({
      attributes: ["id", "normalizedLabel", "type", "usageCount"],
      order: [["usageCount", "DESC"]],
      limit: 10,
    });

    res.json({
      success: true,
      data: {
        graphCount,
        nodeCount,
        edgeCount,
        popularNodes,
      },
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch stats",
    });
  }
});

app.get("/api/test", (req, res) => {
  res.send("CORS test OK: " + new Date().toISOString());
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    console.error("JSON PARSE FAILED. Raw body:", req.rawBody);
    return res.status(400).json({
      success: false,
      error: "Invalid JSON body",
      raw: req.rawBody,
    });
  }
  next(err);
});

// Обработка несуществующих маршрутов
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// Централизованная обработка ошибок
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
});

server.requestTimeout = 0; // отключить таймаут на весь запрос
server.headersTimeout = 0; // отключить таймаут на заголовки
server.keepAliveTimeout = 75_000; // опционально
