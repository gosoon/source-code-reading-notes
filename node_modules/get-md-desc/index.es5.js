'use strict';

Object.defineProperty(exports, '__esModule', {
  value: true
});

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { 'default': obj }; }

var _commonmarkHelpers = require('commonmark-helpers');

var _trimHtmlTag = require('trim-html-tag');

var _trimHtmlTag2 = _interopRequireDefault(_trimHtmlTag);

var isDesc = function isDesc(node, exclude) {
  return (0, _commonmarkHelpers.isRoot)(node) && (0, _commonmarkHelpers.isParagraph)(node) && !(0, _commonmarkHelpers.text)(node).match(exclude);
};

exports['default'] = function (input) {
  var exclude = arguments.length <= 1 || arguments[1] === undefined ? null : arguments[1];

  var node = (0, _commonmarkHelpers.match)(input, function (node) {
    return isDesc(node, exclude);
  });
  if (!node) return;
  return {
    text: (0, _commonmarkHelpers.text)(node),
    html: (0, _trimHtmlTag2['default'])((0, _commonmarkHelpers.html)(node)),
    node: node
  };
};

module.exports = exports['default'];
