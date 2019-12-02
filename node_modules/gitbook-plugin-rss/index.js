'use strict';

const title = require('get-md-title');
const desc  = require('get-md-desc');
const RSS   = require('rss');
const write = require('fs').writeFileSync;
const path = require('path');
const parse = require('url').parse;

// Define variables
let site, feed;

module.exports = {
  website: {
    assets: './assets',
    js: [ 'plugin.js' ],
  },

  hooks: {
    // Get and init RSS configuration
    init() {
      site = this.config.get('pluginsConfig.rss');
      feed = new RSS(site);
    },

    // Collect all pages
    ['page:before'](page) {
      // If README.md, then change it to root
      const url = site.site_url +
        ( page.path === 'README.md'
        ? ''
        : page.path.replace(/.md$/, '.html'));

      const pageTitle = title(page.content);
      const pageDescription = desc(page.content);

      feed.item({
        title: pageTitle ? pageTitle.text : '',
        description: pageDescription ? pageDescription.text : '',
        url: url,
        author: site.author,
      });

      return page;
    },

    // Generate XML and write to file
    finish() {
      const xml = feed.xml({ indent: true });
      const feedpath = path.basename(parse(site.feed_url).pathname);
      return write(path.resolve(this.options.output, feedpath), xml, 'utf-8');
    },
  }
};
