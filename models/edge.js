const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Edge = sequelize.define(
  "Edge",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    sourceId: {
      type: DataTypes.UUID, // Должен совпадать с Node.id
      allowNull: false,
    },
    targetId: {
      type: DataTypes.UUID, // Должен совпадать с Node.id
      allowNull: false,
    },
    graphId: {
      type: DataTypes.UUID, // Должен совпадать с Graph.id
      allowNull: false,
    },
  },
  {
    tableName: "edges",
  }
);

module.exports = Edge;
