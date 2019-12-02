var uuid = require('uuid/v4');

module.exports = {
    website: {
        assets: './assets',
        js: ['osmd.min.js', 'musicxml.js', 'promise.min.js']
    },
    ebook: {},
    blocks: {
        musicxml: {
            process: function (blk) {
                return '<div class="musicxml" id="' + uuid() + '"data-url="' + blk.body + '"></div>';
            }
        }
    }
};