import util from '../util'

function addSVGLabel (root, node) {
  const domNode = root

  domNode.node().appendChild(node.label)

  util.applyStyle(domNode, node.labelStyle)

  return domNode
}

export default addSVGLabel
