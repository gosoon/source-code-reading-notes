import addTextLabel from './add-text-label'
import addHtmlLabel from './add-html-label'
import addSVGLabel from './add-svg-label'

function addLabel (root, node, location) {
  const label = node.label
  const labelSvg = root.append('g')

  // Allow the label to be a string, a function that returns a DOM element, or
  // a DOM element itself.
  if (node.labelType === 'svg') {
    addSVGLabel(labelSvg, node)
  } else if (typeof label !== 'string' || node.labelType === 'html') {
    addHtmlLabel(labelSvg, node)
  } else {
    addTextLabel(labelSvg, node)
  }

  const labelBBox = labelSvg.node().getBBox()
  let y
  switch (location) {
    case 'top':
      y = (-node.height / 2)
      break
    case 'bottom':
      y = (node.height / 2) - labelBBox.height
      break
    default:
      y = (-labelBBox.height / 2)
  }
  labelSvg.attr('transform',
                'translate(' + (-labelBBox.width / 2) + ',' + y + ')')

  return labelSvg
}

export default addLabel
