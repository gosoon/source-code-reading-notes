# get-md-desc

[![NPM version][npm-image]][npm-url]
[![Build Status][travis-image]][travis-url]
[![Coveralls Status][coveralls-image]][coveralls-url]
[![Dependency Status][depstat-image]][depstat-url]

> get description from markdown article

## Install

    npm install --save get-md-desc

## Usage

```js
import getDesc from 'get-md-desc';

const input = `
# title

* nope

Published yesterday

Or in 21 december 2012

True *description*`;

getDesc(input).text;                       // Published yesterday
getDesc(input, /december/).text;           // Published yesterday
getDesc(input, /Published|december/).text; // True description
getDesc(input, /Published|december/).html; // True <em>description</em>
getDesc(input, /Published|december/).node; // AST node, see commonmark API
getDesc('',    /Published|december/);      // undefined ¯\_(ツ)_/¯
```

## API

### getDesc(input, [exclude])

#### input

*Required*  
Type: `String`

Markdown string.

#### exclude

Type: `String` or `RegExp`  
Default: `null`

Pattern, which paragraph of description should not contain.

## Related

* [article-data][article-data] - extract data from your markdown article
* [get-md-content][get-md-content] - get content from markdown article
* [get-md-date][get-md-date] - get date from markdown article
* [get-md-image][get-md-image] - get image from markdown article
* [get-md-title][get-md-title] - get title from markdown article

## License

MIT © [Vladimir Starkov](https://iamstarkov.com)

[npm-url]: https://npmjs.org/package/get-md-desc
[npm-image]: https://img.shields.io/npm/v/get-md-desc.svg?style=flat-square

[travis-url]: https://travis-ci.org/iamstarkov/get-md-desc
[travis-image]: https://img.shields.io/travis/iamstarkov/get-md-desc.svg?style=flat-square

[coveralls-url]: https://coveralls.io/r/iamstarkov/get-md-desc
[coveralls-image]: https://img.shields.io/coveralls/iamstarkov/get-md-desc.svg?style=flat-square

[depstat-url]: https://david-dm.org/iamstarkov/get-md-desc
[depstat-image]: https://david-dm.org/iamstarkov/get-md-desc.svg?style=flat-square

[article-data]: https://github.com/iamstarkov/article-data
[get-md-content]: https://github.com/iamstarkov/get-md-content
[get-md-date]: https://github.com/iamstarkov/get-md-date
[get-md-image]: https://github.com/iamstarkov/get-md-image
[get-md-title]: https://github.com/iamstarkov/get-md-title
