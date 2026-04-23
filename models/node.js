const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Node = sequelize.define(
  "Node",
  {
    id: {
      type: DataTypes.UUID, // UUID для согласованности
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    normalizedLabel: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    type: {
      type: DataTypes.ENUM("product", "transformation"),
      allowNull: false,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    usageCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
  },
  {
    tableName: "nodes",
  }
);

module.exports = Node;
