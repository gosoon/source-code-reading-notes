var plantumlEncoder = require('plantuml-encoder');

module.exports = {
    blocks: {
        plantuml: {
            process: function(block) {
                var defaultFormat = this.generator == 'ebook'? 'png' : 'svg';
                var format = block.kwargs.format || defaultFormat;

                // Generate url
                var encoded = plantumlEncoder.encode(block.body);
                var href = 'http://www.plantuml.com/plantuml/' + format + '/' + encoded;

                return '<img src="' + href + '" />';
            }
        }
    }
};
