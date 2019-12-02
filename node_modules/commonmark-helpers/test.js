import {
  text, html, match, matchRemove, matchRemoveList, matchProcess, matchProcessList,
  isHeader, isLevel, isParagraph, isBlockQuote, isImage, isEmph, isStrong } from './index';
import { equal, deepEqual } from 'assert';

const input = `
# title

## title 2

paragraph

![](imgsrc)

> BlockQuote

> BlockQuote *italic*
`;

it('node matcher', ()=> {
  equal(text(match(input, node => node.type === 'Header')), 'title');
});

it('node isHeader matcher', ()=> {
  equal(text(match(input, isHeader)), 'title');
});

it('node isHeader lvl 2 matcher', ()=> {
  equal(text(match(input, node => isLevel(node, 2))), 'title 2');
});

it('ast, html, text and match should not fail and return undefined if nothing matched', ()=> {
  equal(text(match(input, node => isLevel(node, 3))), undefined);
});

it('node isParagraph matcher', ()=> {
  equal(text(match(input, isParagraph)), 'paragraph');
});

it('node isBlockQuote matcher', ()=> {
  equal(text(match(input, isBlockQuote)), 'BlockQuote');
});

it('node isImage matcher', ()=> {
  equal(match(input, isImage).destination, 'imgsrc');
});

it('html', ()=> {
  equal(html('**awsm**'), '<p><strong>awsm</strong></p>\n');
});

it('text', ()=> {
  equal(text(input), `
title

title 2

paragraph

BlockQuote

BlockQuote italic
  `.trim());
});

it('matchRemove', ()=> {
  equal(text(matchRemove(`# asd\n\ntext`, isHeader)), `text`);
});

it('matchRemoveList simple', ()=> {
  equal(text(matchRemoveList(`# asd\n\ntext`, isHeader)), `text`);
});

it('matchRemoveList double', ()=> {
  equal(text(matchRemoveList(`# asd\n\n## double\n\ntext`, i => isLevel(i, 1), i => isLevel(i, 2))), `text`);
});

it('matchProcess', ()=> {
  const up = node => {
    if (node.literal) {
      node.literal = node.literal.toUpperCase();
    }
  }
  equal(text(matchProcess(`# wat\n\ntext`, up)), `WAT\n\nTEXT`);
});

it('matchProcess semi-complicated', ()=> {
  const t2tt = node => {
    if (node.literal) {
      node.literal = node.literal.split('').map(i => i === 't' ? 'tt' : i).join('');
    }
  }
});

it('matchProcess complicated', ()=> {
  const procHeaders = (deeper, node) => {
    if (isHeader(node)) { matchProcess(node, deeper) }
  }
  const up = (node) => {
    if (node.literal) { node.literal = node.literal.toUpperCase(); }
  };
  equal(text(matchProcess(`# asd\n\ntext`, procHeaders.bind(null, up))), `ASD\n\ntext`);
});


it('matchProcessList', ()=> {
  const up = (node) => {
    if (node.literal) { node.literal = node.literal.toUpperCase(); }
  };
  const procEmph = (deeper, node) => {
    if (isEmph(node)) { matchProcess(node, deeper) }
  }
  const procStrong = (deeper, node) => {
    if (isStrong(node)) { matchProcess(node, deeper) }
  }
  equal(text(matchProcessList(`_emph_ and **strong**`, procEmph.bind(null, up), procStrong.bind(null, up))), `EMPH and STRONG`);
});

it('flexible AST', ()=> {
  const input = '# yay yay';
  const addId = (node) => {
    if (isHeader(node)) {
      node.id = text(node).replace(/\s/gim, '-').toLowerCase();
    }
  };
  equal(match(matchProcess(input, addId), isHeader).id, 'yay-yay');
});
