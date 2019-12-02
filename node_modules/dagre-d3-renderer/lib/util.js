import _ from 'lodash'

/*
 * Returns true if the specified node in the graph is a subgraph node. A
 * subgraph node is one that contains other nodes.
 */
function isSubgraph (g, v) {
  return !!g.children(v).length
}

function edgeToId (e) {
  return escapeId(e.v) + ':' + escapeId(e.w) + ':' + escapeId(e.name)
}

const ID_DELIM = /:/g
function escapeId (str) {
  return str ? String(str).replace(ID_DELIM, '\\:') : ''
}

function applyStyle (dom, styleFn) {
  if (styleFn) {
    dom.attr('style', styleFn)
  }
}

function applyClass (dom, classFn, otherClasses) {
  if (classFn) {
    dom
      .attr('class', classFn)
      .attr('class', otherClasses + ' ' + dom.attr('class'))
  }
}

function applyTransition (selection, g) {
  const graph = g.graph()

  if (_.isPlainObject(graph)) {
    const transition = graph.transition
    if (_.isFunction(transition)) {
      return transition(selection)
    }
  }

  return selection
}

// Public utility functions
export default {
  isSubgraph,
  edgeToId,
  applyStyle,
  applyClass,
  applyTransition
}
