# gitbook-plugin-rss

[![NPM version][npm-image]][npm-url]
[![Dependency Status][depstat-image]][depstat-url]

> RSS for your gitbook

Generate a RSS feed and display link to feed in your gitbook:

![image](https://cloud.githubusercontent.com/assets/3459374/12374850/81a6cd9a-bcb2-11e5-9b05-251fea000d3b.png)

It's very useful for books which get update several times a month. If you wanna notify readers about updates, just use this plugin.

## Install

    npm install --save gitbook-plugin-rss

## Usage

Add it to your `book.json` with a basic configuration:

```json
{
  "plugins": [ "rss" ],
  "pluginsConfig": {
    "rss": {
      "title": "My amazing book",
      "description": "This is the best book ever.",
      "author": "Denys Dovhan",
      "site_url": "http://book.org/",
      "managingEditor": "writer@book.org (Denys Dovhan)",
      "webMaster": "webmaster@book.org (Denys Dovhan)",
      "categories": [
        "awesome",
        "book",
        "gitbook"
      ]
    }
  }
}
```

## API

* `title` (_required_ **string**) — Title of your site or feed
* `site_url` (_required_ **url string**) — Url to the site that the feed is for.
* `feed_url` (_required_ **url string**) — Url to the rss feed.
* `description` (_optional_ **string**) — A short description of the feed.
* `generator` (_optional_  **string**) — Feed generator.
* `image_url` (_optional_  **url string**) — Small image for feed readers to use.
* `managingEditor` (_optional_ **string**) — Who manages content in this feed.
* `webMaster` (_optional_ **string**) — Who manages feed availability and technical support.
* `categories` (_optional_ **array of strings**) —  One or more categories this feed belongs to.
* `copyright` (_optional_ **string**) — Copyright information for this feed.
* `language` (_optional_ **string**) — The language of the content of this feed.

## License

MIT © [Denys Dovhan](http://denysdovhan.com)

[npm-url]: https://npmjs.org/package/gitbook-plugin-rss
[npm-image]: https://img.shields.io/npm/v/gitbook-plugin-rss.svg?style=flat-square

[depstat-url]: https://david-dm.org/denysdovhan/gitbook-plugin-rss
[depstat-image]: https://david-dm.org/denysdovhan/gitbook-plugin-rss.svg?style=flat-square
