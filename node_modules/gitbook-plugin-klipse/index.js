var toCamelCase = function(s) {
    return s.replace(/-([a-z])/g, function (g) { return g[1].toUpperCase(); });
}

module.exports = {
    // Map of hooks
    hooks: {
        "page": function(page) {
        page.content = page.content + ' \
<link rel="stylesheet" \
      type="text/css" \
      href="https://storage.googleapis.com/app.klipse.tech/css/codemirror.css"> \
<script> \
    window.klipse_settings = { \
        selector: ".language-klipse, .lang-eval-clojure", \
        selector_eval_js: ".lang-eval-js", \
        selector_eval_python_client: ".lang-eval-python", \
        selector_eval_php: ".lang-eval-php", \
        selector_eval_scheme: ".lang-eval-scheme", \
        selector_eval_ruby: ".lang-eval-ruby", \
        selector_reagent: ".lang-reagent",\
        selector_google_charts: ".lang-google-chart",\
        selector_es2017: ".lang-eval-es2017",\
        selector_jsx: ".lang-eval-jsx",\
        selector_transpile_jsx: ".lang-transpile-jsx",\
        selector_render_jsx: ".lang-render-jsx",\
        selector_react: ".lang-react",\
        selector_eval_markdown: ".lang-render-markdown",\
        selector_eval_lambdaway: ".lang-render-lambdaway",\
        selector_eval_cpp: ".lang-eval-cpp",\
        selector_eval_html: ".lang-render-html",\
        selector_sql: ".lang-eval-sql",\
        selector_brainfuck: "lang-eval-brainfuck",\
        selector_js: ".lang-transpile-cljs"\
    }; \
</script> \
<script src="https://storage.googleapis.com/app.klipse.tech/plugin/js/klipse_plugin.js"></script>'
        return page;
    }
    },

    // Map of new blocks
    blocks: {
        klipse: {
            process: function(block) {
                var lang = block.kwargs.lang || block.args[0];
                var langClass = ' class="lang-' + lang + '"';

                var hidden = block.kwargs.hidden ? ' class="hidden"' : '';
                var pre = '<pre' + hidden + '>';

                var opts = [
                    // All snippets
                    'eval-idle-msec',
                    'loop-msec',
                    'preamble',
                    'gist-id',
                    // Javascript and Clojure only
                    'external-libs',
                    // Javascript only
                    'async-code',
                    // Clojure only
                    'static-fns',
                    'print-length',
                    'beautify-strings',
                    'verbose',
                    'max-eval-duration',
                    'compile-display-guard'
                ].reduce(function(a, c) {
                    var camelCased = toCamelCase(c);
                    if (block.kwargs.hasOwnProperty(camelCased)) {
                        return a + ' data-' + c + '="' + block.kwargs[camelCased] + '"';
                    }
                    return a;
                }, '');

                var code = '<code'
                    + langClass
                    + opts
                    + '>' + block.body + '</code>'

                return pre + code + '</pre>';
            }
        }
    },

    // Map of new filters
    filters: {}
};
