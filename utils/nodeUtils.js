const { Node, Edge, GraphNode, Graph } = require('../models');

// Нормализация названия для поиска дубликатов
function normalizeLabel(label) {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^\w\sа-яА-Я]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 200);
}

// Создание или получение существующего узла
async function findOrCreateNode(nodeData, transaction) {
  const normalizedLabel = normalizeLabel(nodeData.data.label);
  
  // Ищем существующий узел
  let node = await Node.findOne({
    where: { 
      normalizedLabel,
      type: nodeData.type 
    },
    transaction
  });

  if (node) {
    // Увеличиваем счетчик использования
    await node.increment('usageCount', { transaction });
    console.log(`?? Использован существующий узел: "${nodeData.data.label}"`);
  } else {
    // Создаем новый узел
    node = await Node.create({
      normalizedLabel,
      type: nodeData.type,
      data: nodeData.data,
      usageCount: 1
    }, { transaction });
    console.log(`? Создан новый узел: "${nodeData.data.label}"`);
  }

  return node;
}

// Получение полного графа с общими узлами
async function getGraphWithSharedNodes(graphId) {
  const graph = await Graph.findByPk(graphId, {
    include: [
      {
        model: Node,
        as: 'nodes',
        through: { attributes: [] }
      },
      {
        model: Edge,
        as: 'edges',
        include: [
          {
            model: Node,
            as: 'source',
            required: true
          },
          {
            model: Node,
            as: 'target',
            required: true
          }
        ]
      }
    ]
  });

  if (!graph) {
    return null;
  }

  // Преобразуем в формат React Flow
  const nodes = graph.nodes.map(node => ({
    id: node.id,
    type: node.type,
    data: node.data,
    position: node.data.position || { x: 0, y: 0 }
  }));

  const edges = graph.edges.map(edge => ({
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId
  }));

  return {
    nodes,
    edges,
    graphInfo: {
      id: graph.id,
      name: graph.name,
      userPrompt: graph.userPrompt,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount
    }
  };
}

// Поиск связанных графов через общие узлы
async function findRelatedGraphs(graphId, limit = 5) {
  const graph = await Graph.findByPk(graphId, {
    include: [{ model: Node, as: 'nodes' }]
  });

  if (!graph) return [];

  const nodeIds = graph.nodes.map(node => node.id);

  // Находим графы, которые используют те же узлы
  const { Sequelize } = require('sequelize');
  const relatedGraphs = await Graph.findAll({
    where: {
      id: { [Sequelize.Op.ne]: graphId }
    },
    include: [{
      model: Node,
      as: 'nodes',
      where: {
        id: { [Sequelize.Op.in]: nodeIds }
      },
      required: true
    }],
    order: [[Sequelize.literal('(SELECT COUNT(*) FROM graph_nodes WHERE graph_id = "Graph"."id" AND node_id IN (?))', [nodeIds]), 'DESC']],
    limit
  });

  return relatedGraphs;
}

// Получение нескольких графов для объединения на одном холсте
async function getMultipleGraphs(graphNames) {
  const graphs = await Graph.findAll({
    where: {
      name: graphNames
    },
    include: [
      {
        model: Node,
        as: 'nodes',
        through: { attributes: [] }
      },
      {
        model: Edge,
        as: 'edges'
      }
    ]
  });

  // Объединяем узлы и связи всех графов
  const allNodes = new Map();
  const allEdges = [];
  const graphInfos = [];

  graphs.forEach(graph => {
    graphInfos.push({
      id: graph.id,
      name: graph.name,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount
    });

    // Добавляем узлы (избегаем дубликатов)
    graph.nodes.forEach(node => {
      if (!allNodes.has(node.id)) {
        allNodes.set(node.id, {
          id: node.id,
          type: node.type,
          data: node.data,
          position: node.data.position || { x: 0, y: 0 }
        });
      }
    });

    // Добавляем связи
    graph.edges.forEach(edge => {
      allEdges.push({
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId
      });
    });
  });

  return {
    nodes: Array.from(allNodes.values()),
    edges: allEdges,
    graphInfos
  };
}

module.exports = {
  normalizeLabel,
  findOrCreateNode,
  getGraphWithSharedNodes,
  findRelatedGraphs,
  getMultipleGraphs
};