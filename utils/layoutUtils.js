const dagre = require('@dagrejs/dagre');

function autoLayoutNodes(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));

  // Настройки layout
  g.setGraph({
    rankdir: 'TB',
    nodesep: 100,
    ranksep: 150,
    marginx: 50,
    marginy: 50
  });

  // Добавляем узлы
  nodes.forEach(node => {
    g.setNode(node.id, {
      width: 200,
      height: 100
    });
  });

  // Добавляем связи
  edges.forEach(edge => {
    g.setEdge(edge.source, edge.target);
  });

  // Вычисляем layout
  dagre.layout(g);

  // Применяем позиции
  return nodes.map(node => {
    const nodeWithPosition = g.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 100, // Центрируем
        y: nodeWithPosition.y - 50
      },
      data: {
        ...node.data,
        position: {
          x: nodeWithPosition.x - 100,
          y: nodeWithPosition.y - 50
        }
      }
    };
  });
}

module.exports = {
  autoLayoutNodes
};