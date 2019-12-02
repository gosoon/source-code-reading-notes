'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _commonmark = require('commonmark');

var _commonmark2 = _interopRequireDefault(_commonmark);

var _ramda = require('ramda');

var ast = function ast(input) {
  return typeof input === 'string' ? new _commonmark2['default'].Parser().parse(input) : input;
};

var match = function match(input, matcher) {
  if (!input) return;
  var walker = ast(input).walker();
  var event;
  while (event = walker.next()) {
    if (matcher(event.node, event)) {
      return event.node;
    }
  }
};

var matchRemove = function matchRemove(input, matcher) {
  if (!input) return;
  var tree = ast(input);
  var walker = tree.walker();
  var event;
  while (event = walker.next()) {
    if (matcher(event.node, event)) {
      event.node.unlink();
    }
  }
  return tree;
};

var matchProcess = function matchProcess(input, processor) {
  if (!input) return;
  var tree = ast(input);
  var walker = tree.walker();
  var event;
  while (event = walker.next()) {
    processor(event.node, event);
  }
  return tree;
};

var matchRemoveList = function matchRemoveList(input) {
  for (var _len = arguments.length, matchers = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
    matchers[_key - 1] = arguments[_key];
  }

  return matchers.length === 0 ? ast(input) : (0, _ramda.apply)(_ramda.compose, (0, _ramda.map)(function (item) {
    return (0, _ramda.partialRight)(matchRemove, item);
  }, matchers))(input);
};

var matchProcessList = function matchProcessList(input) {
  for (var _len2 = arguments.length, processors = Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
    processors[_key2 - 1] = arguments[_key2];
  }

  return processors.length === 0 ? ast(input) : (0, _ramda.apply)(_ramda.compose, (0, _ramda.map)(function (item) {
    return (0, _ramda.partialRight)(matchProcess, item);
  }, processors))(input);
};

var html = function html(input) {
  if (!input) return;
  return new _commonmark2['default'].HtmlRenderer().render(ast(input));
};

var text = function text(input) {
  if (!input) return;
  var res = '';
  match(input, function (node, event) {
    res += isRoot(node) && event.entering && res !== '' ? '\n\n' : '';
    res += isBreak(node) ? '\n' : node.literal || '';
  });
  return res.replace(/\n{2,}/gim, '\n\n');
};

// shortcuts
/* istanbul ignore if */
var isType = function isType(node, type) {
  return node.type === type;
};
var isLevel = function isLevel(node, level) {
  return node.level === level;
};
var isText = function isText(node) {
  return isType(node, 'Text');
};
var isEmph = function isEmph(node) {
  return isType(node, 'Emph');
};
var isCode = function isCode(node) {
  return isType(node, 'Code');
};
var isHtml = function isHtml(node) {
  return isType(node, 'Html');
};
var isLink = function isLink(node) {
  return isType(node, 'Link');
};
var isItem = function isItem(node) {
  return isType(node, 'Item');
};
var isList = function isList(node) {
  return isType(node, 'List');
};
var isImage = function isImage(node) {
  return isType(node, 'Image');
};
var isStrong = function isStrong(node) {
  return isType(node, 'Strong');
};
var isHeader = function isHeader(node) {
  return isType(node, 'Header');
};
var isDocument = function isDocument(node) {
  return isType(node, 'Document');
};
var isCodeBlock = function isCodeBlock(node) {
  return isType(node, 'CodeBlock');
};
var isHtmlBlock = function isHtmlBlock(node) {
  return isType(node, 'HtmlBlock');
};
var isSoftbreak = function isSoftbreak(node) {
  return isType(node, 'Softbreak');
};
var isHardbreak = function isHardbreak(node) {
  return isType(node, 'Hardbreak');
};
var isParagraph = function isParagraph(node) {
  return isType(node, 'Paragraph');
};
var isBlockQuote = function isBlockQuote(node) {
  return isType(node, 'BlockQuote');
};
var isHorizontalRule = function isHorizontalRule(node) {
  return isType(node, 'HorizontalRule');
};

// special
var isRoot = function isRoot(node) {
  return node.parent && isDocument(node.parent);
};
var isBreak = function isBreak(node) {
  return isHardbreak(node) || isSoftbreak(node);
};
/* istanbul ignore else */

exports['default'] = {
  // helpers
  ast: ast, html: html, text: text,

  // matchers
  match: match, matchRemove: matchRemove, matchRemoveList: matchRemoveList,
  matchProcess: matchProcess, matchProcessList: matchProcessList,

  // shortcuts
  isType: isType, isText: isText, isEmph: isEmph, isCode: isCode, isHtml: isHtml, isLink: isLink, isItem: isItem, isList: isList, isImage: isImage,
  isStrong: isStrong, isHeader: isHeader, isLevel: isLevel, isDocument: isDocument, isCodeBlock: isCodeBlock, isHtmlBlock: isHtmlBlock,
  isSoftbreak: isSoftbreak, isHardbreak: isHardbreak, isParagraph: isParagraph, isBlockQuote: isBlockQuote, isHorizontalRule: isHorizontalRule,
  isRoot: isRoot, isBreak: isBreak
};
module.exports = exports['default'];

