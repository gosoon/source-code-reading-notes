import _ from 'lodash'

import util from './util'

function addBorderSegments (g) {
  function dfs (v) {
    const children = g.children(v)
    const node = g.node(v)
    if (children.length) {
      _.forEach(children, dfs)
    }

    if (_.has(node, 'minRank')) {
      node.borderLeft = []
      node.borderRight = []
      for (let rank = node.minRank, maxRank = node.maxRank + 1;
        rank < maxRank;
        ++rank) {
        addBorderNode(g, 'borderLeft', '_bl', v, node, rank)
        addBorderNode(g, 'borderRight', '_br', v, node, rank)
      }
    }
  }

  _.forEach(g.children(), dfs)
}

function addBorderNode (g, prop, prefix, sg, sgNode, rank) {
  const label = { width: 0, height: 0, rank: rank, borderType: prop }
  const prev = sgNode[prop][rank - 1]
  const curr = util.addDummyNode(g, 'border', label, prefix)
  sgNode[prop][rank] = curr
  g.setParent(curr, sg)
  if (prev) {
    g.setEdge(prev, curr, { weight: 1 })
  }
}

export default addBorderSegments
