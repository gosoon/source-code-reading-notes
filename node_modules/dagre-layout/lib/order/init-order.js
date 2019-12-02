import _ from 'lodash'

/*
 * Assigns an initial order value for each node by performing a DFS search
 * starting from nodes in the first rank. Nodes are assigned an order in their
 * rank as they are first visited.
 *
 * This approach comes from Gansner, et al., "A Technique for Drawing Directed
 * Graphs."
 *
 * Returns a layering matrix with an array per layer and each layer sorted by
 * the order of its nodes.
 */
function initOrder (g) {
  const visited = {}
  const simpleNodes = _.filter(g.nodes(), function (v) {
    return !g.children(v).length
  })
  const maxRank = _.max(_.map(simpleNodes, function (v) { return g.node(v).rank }))
  const layers = _.map(_.range(maxRank + 1), function () { return [] })

  function dfs (v) {
    if (_.has(visited, v)) return
    visited[v] = true
    const node = g.node(v)
    layers[node.rank].push(v)
    _.forEach(g.successors(v), dfs)
  }

  const orderedVs = _.sortBy(simpleNodes, function (v) { return g.node(v).rank })
  _.forEach(orderedVs, dfs)

  return layers
}

export default initOrder
