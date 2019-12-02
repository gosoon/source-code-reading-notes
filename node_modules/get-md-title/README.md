# get-md-title

[![NPM version][npm-image]][npm-url]
[![Build Status][travis-image]][travis-url]
[![Coveralls Status][coveralls-image]][coveralls-url]
[![Dependency Status][depstat-image]][depstat-url]

> get title from markdown article

## Install

    npm install --save get-md-title

## Usage

```js
import getTitle from 'get-md-title';

const input = `
# awesome *heading*

# second heading

paragragh`;

getTitle(input).text; // awesome heading
getTitle(input).html; // awesome <em>heading</em>
getTitle(input).node; // AST node, see commonmark API
getTitle('');         // undefined ¯\_(ツ)_/¯
```

## API

### getTitle(input)

#### input

*Required*  
Type: `String`

Markdown string.

## Related

* [get-md-content][get-md-content] - get content from markdown article
* [get-md-date][get-md-date] - get date from markdown article
* [get-md-desc][get-md-desc] - get description from markdown article
* [get-md-image][get-md-image] - get image from markdown article

## License

MIT © [Vladimir Starkov](https://iamstarkov.com)


[npm-url]: https://npmjs.org/package/get-md-title
[npm-image]: https://img.shields.io/npm/v/get-md-title.svg?style=flat-square

[travis-url]: https://travis-ci.org/iamstarkov/get-md-title
[travis-image]: https://img.shields.io/travis/iamstarkov/get-md-title.svg?style=flat-square

[coveralls-url]: https://coveralls.io/r/iamstarkov/get-md-title
[coveralls-image]: https://img.shields.io/coveralls/iamstarkov/get-md-title.svg?style=flat-square

[depstat-url]: https://david-dm.org/iamstarkov/get-md-title
[depstat-image]: https://david-dm.org/iamstarkov/get-md-title.svg?style=flat-square

[get-md-content]: https://github.com/iamstarkov/get-md-content
[get-md-date]: https://github.com/iamstarkov/get-md-date
[get-md-desc]: https://github.com/iamstarkov/get-md-desc
[get-md-image]: https://github.com/iamstarkov/get-md-image
