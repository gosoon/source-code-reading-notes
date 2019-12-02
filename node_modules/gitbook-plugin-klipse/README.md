# Introduction

This plugin allows you to embed klipse: https://github.com/viebel/klipse
in gitbook projects.

Klipse allows code snippets in your gitbooks to be live and interactive. The code is evaluated as you type or when you press `Ctrl-Enter`.

To enable this plugin add `klipse` to your `book.json` plugins.

Now you can embed interactive code snippets (clojure, javascript, python, ruby, scheme and php) in your gitbooks.

You can read [the full interactive guide](https://book.klipse.tech/) for using klipse in a gitbook. The guide is itself a gitbook using the klipse plugin.

# Clojure & ClojureScript

For clojure[script] code evaluation:

<pre><code>
&grave;&grave;&grave;eval-clojure
(map inc [1 2 3])
&grave;&grave;&grave;
</code></pre>

For clojurescript code transpilation:

<pre><code>
&grave;&grave;&grave;transpile-cljs
(map inc [1 2 3])
&grave;&grave;&grave;
</code></pre>

# Javascript

<pre><code>
&grave;&grave;&grave;eval-js
[1,2,3].map(function(x) { return x + 1;})
&grave;&grave;&grave;
</code></pre>

# Python

<pre><code>
&grave;&grave;&grave;eval-python
print [x + 1 for x in range(10)]
&grave;&grave;&grave;
</code></pre>

# Ruby
<pre><code>
&grave;&grave;&grave;eval-ruby
[1,2]*10
&grave;&grave;&grave;
</code></pre>

# Scheme 

<pre><code>
&grave;&grave;&grave;eval-scheme
(let ((x 23)
      (y 42))
  (+ x y))
&grave;&grave;&grave;
</code></pre>

# PHP

<pre><code>
&grave;&grave;&grave;eval-php
$var = ["a" => 1];
var_dump($var);
&grave;&grave;&grave;
</code></pre>

# Using options

You can define snippet level configuration by using gitbook blocks instead of code fences. The first argument is always the language, followed by named arguments for all other configuration options. All option names are camelCased.

## Clojure & ClojureScript

```
{% klipse "eval-clojure", loopMsec="1000" %}
(rand)
{% endklipse %}
```

## Javascript

```
{% klipse "eval-js", loopMsec="1000" %}
new Date()
{% endklipse %}
```