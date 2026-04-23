const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Graph = sequelize.define(
  "Graph",
  {
    id: {
      type: DataTypes.UUID, // Используем UUID для всех ID
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    userPrompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    nodeCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    edgeCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
  },
  {
    tableName: "graphs",
    timestamps: true,
  }
);

const GraphNode = sequelize.define(
  "GraphNode",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    graphId: {
      type: DataTypes.UUID, // Должен совпадать с Graph.id
      allowNull: false,
    },
    nodeId: {
      type: DataTypes.UUID, // Должен совпадать с Node.id
      allowNull: false,
    },
  },
  {
    tableName: "graph_nodes",
    indexes: [
      {
        unique: true,
        fields: ["graphId", "nodeId"],
      },
    ],
  }
);

module.exports = {
  Graph,
  GraphNode,
};
