import _ from 'lodash'
import { Graph } from 'graphlibrary'

/*
 * Adds a dummy node to the graph and return v.
 */
export function addDummyNode (g, type, attrs, name) {
  let v
  do {
    v = _.uniqueId(name)
  } while (g.hasNode(v))

  attrs.dummy = type
  g.setNode(v, attrs)
  return v
}

/*
 * Returns a new graph with only simple edges. Handles aggregation of data
 * associated with multi-edges.
 */
export function simplify (g) {
  const simplified = new Graph().setGraph(g.graph())
  _.forEach(g.nodes(), function (v) { simplified.setNode(v, g.node(v)) })
  _.forEach(g.edges(), function (e) {
    const simpleLabel = simplified.edge(e.v, e.w) || { weight: 0, minlen: 1 }
    const label = g.edge(e)
    simplified.setEdge(e.v, e.w, {
      weight: simpleLabel.weight + label.weight,
      minlen: Math.max(simpleLabel.minlen, label.minlen)
    })
  })
  return simplified
}

export function asNonCompoundGraph (g) {
  const simplified = new Graph({ multigraph: g.isMultigraph() }).setGraph(g.graph())
  _.forEach(g.nodes(), function (v) {
    if (!g.children(v).length) {
      simplified.setNode(v, g.node(v))
    }
  })
  _.forEach(g.edges(), function (e) {
    simplified.setEdge(e, g.edge(e))
  })
  return simplified
}

export function successorWeights (g) {
  const weightMap = _.map(g.nodes(), function (v) {
    const sucs = {}
    _.forEach(g.outEdges(v), function (e) {
      sucs[e.w] = (sucs[e.w] || 0) + g.edge(e).weight
    })
    return sucs
  })
  return _.zipObject(g.nodes(), weightMap)
}

export function predecessorWeights (g) {
  const weightMap = _.map(g.nodes(), function (v) {
    const preds = {}
    _.forEach(g.inEdges(v), function (e) {
      preds[e.v] = (preds[e.v] || 0) + g.edge(e).weight
    })
    return preds
  })
  return _.zipObject(g.nodes(), weightMap)
}

/*
 * Finds where a line starting at point ({x, y}) would intersect a rectangle
 * ({x, y, width, height}) if it were pointing at the rectangle's center.
 */
export function intersectRect (rect, point) {
  const x = rect.x
  const y = rect.y

  // Rectangle intersection algorithm from:
  // http://math.stackexchange.com/questions/108113/find-edge-between-two-boxes
  const dx = point.x - x
  const dy = point.y - y
  let w = rect.width / 2
  let h = rect.height / 2

  if (!dx && !dy) {
    throw new Error('Not possible to find intersection inside of the rectangle')
  }

  let sx
  let sy
  if (Math.abs(dy) * w > Math.abs(dx) * h) {
    // Intersection is top or bottom of rect.
    if (dy < 0) {
      h = -h
    }
    sx = h * dx / dy
    sy = h
  } else {
    // Intersection is left or right of rect.
    if (dx < 0) {
      w = -w
    }
    sx = w
    sy = w * dy / dx
  }

  return { x: x + sx, y: y + sy }
}

/*
 * Given a DAG with each node assigned "rank" and "order" properties, this
 * function will produce a matrix with the ids of each node.
 */
export function buildLayerMatrix (g) {
  const layering = _.map(_.range(maxRank(g) + 1), function () { return [] })
  _.forEach(g.nodes(), function (v) {
    const node = g.node(v)
    const rank = node.rank
    if (!_.isUndefined(rank)) {
      layering[rank][node.order] = v
    }
  })
  return layering
}

/*
 * Adjusts the ranks for all nodes in the graph such that all nodes v have
 * rank(v) >= 0 and at least one node w has rank(w) = 0.
 */
export function normalizeRanks (g) {
  const min = _.min(_.map(g.nodes(), function (v) { return g.node(v).rank }))
  _.forEach(g.nodes(), function (v) {
    const node = g.node(v)
    if (_.has(node, 'rank')) {
      node.rank -= min
    }
  })
}

export function removeEmptyRanks (g) {
  // Ranks may not start at 0, so we need to offset them
  const offset = _.min(_.map(g.nodes(), function (v) { return g.node(v).rank }))

  const layers = []
  _.forEach(g.nodes(), function (v) {
    const rank = g.node(v).rank - offset
    if (!layers[rank]) {
      layers[rank] = []
    }
    layers[rank].push(v)
  })

  let delta = 0
  const nodeRankFactor = g.graph().nodeRankFactor
  _.forEach(layers, function (vs, i) {
    if (_.isUndefined(vs) && i % nodeRankFactor !== 0) {
      --delta
    } else if (delta) {
      _.forEach(vs, function (v) { g.node(v).rank += delta })
    }
  })
}

export function addBorderNode (g, prefix, rank, order) {
  const node = {
    width: 0,
    height: 0
  }
  if (arguments.length >= 4) {
    node.rank = rank
    node.order = order
  }
  return addDummyNode(g, 'border', node, prefix)
}

export function maxRank (g) {
  return _.max(_.map(g.nodes(), function (v) {
    const rank = g.node(v).rank
    if (!_.isUndefined(rank)) {
      return rank
    }
  }))
}

/*
 * Partition a collection into two groups: `lhs` and `rhs`. If the supplied
 * function returns true for an entry it goes into `lhs`. Otherwise it goes
 * into `rhs.
 */
export function partition (collection, fn) {
  const result = { lhs: [], rhs: [] }
  _.forEach(collection, function (value) {
    if (fn(value)) {
      result.lhs.push(value)
    } else {
      result.rhs.push(value)
    }
  })
  return result
}

/*
 * Returns a new function that wraps `fn` with a timer. The wrapper logs the
 * time it takes to execute the function.
 */
export function time (name, fn) {
  const start = _.now()
  try {
    return fn()
  } finally {
    console.log(name + ' time: ' + (_.now() - start) + 'ms')
  }
}

export function notime (name, fn) {
  return fn()
}

export default {
  addDummyNode,
  simplify,
  asNonCompoundGraph,
  successorWeights,
  predecessorWeights,
  intersectRect,
  buildLayerMatrix,
  normalizeRanks,
  removeEmptyRanks,
  addBorderNode,
  maxRank,
  partition,
  time,
  notime
}
