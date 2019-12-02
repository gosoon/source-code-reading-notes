import commonmark from 'commonmark';
import { apply, compose, map, partialRight } from 'ramda';


const ast = input =>
  typeof input === 'string'
    ? new commonmark.Parser().parse(input)
    : input;

const match = (input, matcher) => {
  if (!input) return;
  var walker = ast(input).walker();
  var event;
  while (event = walker.next()) {
    if (matcher(event.node, event)) { return event.node; }
  }
}

const matchRemove = (input, matcher) => {
  if (!input) return;
  var tree = ast(input);
  var walker = tree.walker();
  var event;
  while (event = walker.next()) {
    if (matcher(event.node, event)) { event.node.unlink(); }
  }
  return tree;
}

const matchProcess = (input, processor) => {
  if (!input) return;
  var tree = ast(input);
  var walker = tree.walker();
  var event;
  while (event = walker.next()) { processor(event.node, event); }
  return tree;
}

const matchRemoveList = (input, ...matchers) =>
  matchers.length === 0
    ? ast(input)
    : apply(compose, map(item => partialRight(matchRemove, item), matchers))(input);

const matchProcessList = (input, ...processors) =>
  processors.length === 0
    ? ast(input)
    : apply(compose, map(item => partialRight(matchProcess, item), processors))(input);

const html = (input) => {
  if (!input) return;
  return new commonmark.HtmlRenderer().render(ast(input));
};

const text = (input) => {
  if (!input) return;
  let res = '';
  match(input, (node, event) => {
    res += (isRoot(node) && event.entering && res !== '') ? '\n\n' : '';
    res += isBreak(node) ? '\n' : (node.literal || '');
  });
  return res.replace(/\n{2,}/gim, '\n\n');
}

// shortcuts
/* istanbul ignore if */
const isType = (node, type) => node.type === type;
const isLevel = (node, level) => node.level === level;
const isText = node => isType(node, 'Text');
const isEmph = node => isType(node, 'Emph');
const isCode = node => isType(node, 'Code');
const isHtml = node => isType(node, 'Html');
const isLink = node => isType(node, 'Link');
const isItem = node => isType(node, 'Item');
const isList = node => isType(node, 'List');
const isImage = node => isType(node, 'Image');
const isStrong = node => isType(node, 'Strong');
const isHeader = node => isType(node, 'Header');
const isDocument = node => isType(node, 'Document');
const isCodeBlock = node => isType(node, 'CodeBlock');
const isHtmlBlock = node => isType(node, 'HtmlBlock');
const isSoftbreak = node => isType(node, 'Softbreak');
const isHardbreak = node => isType(node, 'Hardbreak');
const isParagraph = node => isType(node, 'Paragraph');
const isBlockQuote = node => isType(node, 'BlockQuote');
const isHorizontalRule = node => isType(node, 'HorizontalRule');

// special
const isRoot  = node => node.parent && isDocument(node.parent);
const isBreak = node => isHardbreak(node) || isSoftbreak(node);
/* istanbul ignore else */


export default {
  // helpers
  ast, html, text,

  // matchers
  match, matchRemove, matchRemoveList,
  matchProcess, matchProcessList,


  // shortcuts
  isType, isText, isEmph, isCode, isHtml, isLink, isItem, isList, isImage,
  isStrong, isHeader, isLevel, isDocument, isCodeBlock, isHtmlBlock,
  isSoftbreak, isHardbreak, isParagraph, isBlockQuote, isHorizontalRule,
  isRoot, isBreak
};
