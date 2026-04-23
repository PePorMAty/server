const sequelize = require("../config/database");

const { Graph, GraphNode } = require("./graph");
const Node = require("./node");
const Edge = require("./edge");

// Определение связей - только одна ассоциация многие-ко-многим
Graph.belongsToMany(Node, {
  through: GraphNode,
  foreignKey: "graphId",
  as: "nodes",
});
Node.belongsToMany(Graph, {
  through: GraphNode,
  foreignKey: "nodeId",
  as: "graphs",
});

// Связи для Edge
Graph.hasMany(Edge, { foreignKey: "graphId", as: "edges" });
Edge.belongsTo(Graph, { foreignKey: "graphId" });
Edge.belongsTo(Node, { foreignKey: "sourceId", as: "source" });
Edge.belongsTo(Node, { foreignKey: "targetId", as: "target" });

module.exports = {
  sequelize,
  Graph,
  Node,
  Edge,
  GraphNode,
};
