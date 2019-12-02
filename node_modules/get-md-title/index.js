import { isHeader, isLevel, match, text, html } from 'commonmark-helpers';
import trimTag from 'trim-html-tag';

const isTitle = node => isHeader(node) && isLevel(node, 1);

export default input => {
  const node = match(input, isTitle);
  if (!node) return;
  return {
    text: text(node),
    html: trimTag(html(node)),
    node
  };
};
